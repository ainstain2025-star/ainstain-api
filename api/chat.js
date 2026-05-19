export const config = {
  runtime: 'edge',
};

const WEB_SEARCH_TRIGGERS = [
  /\b(oggi|adesso|ora|attuale|attualmente|recente|recentemente|ultimo|ultimi|ultime|notizie|news)\b/i,
  /\b(2024|2025|2026)\b/,
  /\b(today|now|current|currently|latest|recent|recently|news)\b/i,
  /\b(chi è|chi sono|cos'è|cosa è|cos è|dov'è|quando è|quanto costa|prezzo di)\b/i,
  /\b(meteo|tempo|temperatura|previsioni)\b/i,
  /\b(classifica|ranking|risultati|vincitore|campione)\b/i,
];

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join(' ');
  }
  return '';
}

function needsWebSearch(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return false;
  const text = extractText(lastUser.content);
  return WEB_SEARCH_TRIGGERS.some(re => re.test(text));
}

function extractSearchQuery(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  const text = extractText(lastUser.content);
  return text.replace(/---[\s\S]*?---/g, '').trim().slice(0, 200);
}

async function tavilySearch(query, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
    }),
  });
  if (!res.ok) throw new Error(`Tavily error: ${res.status}`);
  const data = await res.json();
  return (data.results || [])
    .map(r => `- ${r.title}: ${r.content || ''} (${r.url})`)
    .join('\n');
}

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  let messages, model, forceWebSearch, tools, toolChoice, temperature, maxTokens;
  try {
    const body     = JSON.parse(await req.text());
    messages       = body.messages;
    model          = body.model || 'llama-3.3-70b-versatile';
    forceWebSearch = body.webSearch === true;
    tools          = body.tools || null;          // ← NUOVO: tool definitions
    toolChoice     = body.tool_choice || 'auto';  // ← NUOVO: tool_choice
    temperature    = body.temperature ?? 0.7;
    maxTokens      = body.max_tokens || 1024;
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Invalid request body: ' + e.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (!messages || !Array.isArray(messages)) {
    return new Response(
      JSON.stringify({ error: 'messages array required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!groqKey) {
    return new Response(
      JSON.stringify({ error: 'GROQ_API_KEY non configurata' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // ── Web Search (Tavily) — solo se non stiamo usando tool calling ──────
  let webContext = '';
  const shouldSearch = !tools && tavilyKey && (forceWebSearch || needsWebSearch(messages));

  if (shouldSearch) {
    try {
      const query   = extractSearchQuery(messages);
      const results = await tavilySearch(query, tavilyKey);
      if (results) {
        const today = new Date().toLocaleDateString('it-IT', {
          day: '2-digit', month: 'long', year: 'numeric'
        });
        webContext = `\n\n[RISULTATI WEB AGGIORNATI - ${today}]\nHo cercato in rete informazioni su: "${query}". Ecco i risultati trovati:\n${results}\n[Fine risultati web]\n\nUsa queste informazioni aggiornate per rispondere. Cita la fonte quando utile.`;
      }
    } catch (err) {
      console.error('Tavily search failed:', err.message);
    }
  }

  // ── Inietta contesto web nel system prompt ────────────────────────────
  let finalMessages = [...messages];
  if (webContext) {
    const sysIdx = finalMessages.findIndex(m => m.role === 'system');
    if (sysIdx !== -1) {
      finalMessages[sysIdx] = {
        ...finalMessages[sysIdx],
        content: finalMessages[sysIdx].content + webContext,
      };
    } else {
      finalMessages.unshift({ role: 'system', content: webContext });
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH A: TOOL CALLING (non-streaming, restituisce tool_calls al client)
  // ══════════════════════════════════════════════════════════════════════
  if (tools && tools.length > 0) {
    try {
      const groqBody = {
        model,
        messages: finalMessages,
        tools,
        tool_choice: toolChoice,
        temperature,
        max_tokens: maxTokens,
        stream: false,   // tool calling richiede non-streaming
      };

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(groqBody),
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return new Response(
          JSON.stringify({ error: errText }),
          { status: groqRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const data    = await groqRes.json();
      const choice  = data.choices?.[0];
      const message = choice?.message;

      // Serializza la risposta come SSE per uniformità con il client
      const { readable, writable } = new TransformStream();
      const writer  = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          // Evento meta
          writer.write(encoder.encode(
            `data: ${JSON.stringify({ type: 'meta', webSearchUsed: false })}\n\n`
          ));

          if (message?.tool_calls && message.tool_calls.length > 0) {
            // Il modello vuole usare dei tool — restituisci le tool_calls
            writer.write(encoder.encode(
              `data: ${JSON.stringify({ type: 'tool_calls', tool_calls: message.tool_calls, content: message.content || null })}\n\n`
            ));
          } else {
            // Risposta testuale normale — tokenizza carattere per carattere per sembrare streaming
            const text = message?.content || '';
            for (let i = 0; i < text.length; i += 4) {
              const chunk = text.slice(i, i + 4);
              writer.write(encoder.encode(
                `data: ${JSON.stringify({ type: 'token', token: chunk })}\n\n`
              ));
            }
          }

          writer.write(encoder.encode(
            `data: ${JSON.stringify({ type: 'done' })}\n\n`
          ));
        } finally {
          writer.close();
        }
      })();

      return new Response(readable, {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no',
        },
      });

    } catch (e) {
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH B: STREAMING NORMALE (comportamento originale)
  // ══════════════════════════════════════════════════════════════════════
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: finalMessages,
        max_tokens: maxTokens,
        temperature,
        stream: true,
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return new Response(
        JSON.stringify({ error: errText }),
        { status: groqRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const usedWeb = shouldSearch && !!webContext;

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const metaEvent = `data: ${JSON.stringify({ type: 'meta', webSearchUsed: usedWeb })}\n\n`;
    writer.write(encoder.encode(metaEvent));

    (async () => {
      const reader = groqRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;

            try {
              const json  = JSON.parse(trimmed.slice(6));
              const token = json.choices?.[0]?.delta?.content;
              if (token) {
                const sseChunk = `data: ${JSON.stringify({ type: 'token', token })}\n\n`;
                writer.write(encoder.encode(sseChunk));
              }
              if (json.choices?.[0]?.finish_reason) {
                writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
              }
            } catch {}
          }
        }
      } finally {
        writer.close();
      }
    })();

    return new Response(readable, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      },
    });

  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
