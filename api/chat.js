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

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Cerca informazioni aggiornate su internet. USA SEMPRE questo tool per: notizie, sport, persone famose, eventi recenti, classifiche, risultati, meteo, prezzi. NON rispondere mai dalla memoria su questi argomenti.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'La query di ricerca specifica' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Restituisce la data e ora corrente. USA SEMPRE questo tool quando chiedono che ore sono, che giorno e, la data di oggi.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Esegue calcoli matematici precisi. USA SEMPRE questo tool per percentuali, operazioni aritmetiche, conversioni numeriche.',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: "L'espressione matematica da calcolare" } },
        required: ['expression']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: "Salva un'informazione nella memoria dell'utente. USA questo tool quando l'utente dice 'ricorda che...' o vuole salvare qualcosa.",
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: "L'informazione da salvare" } },
        required: ['note']
      }
    }
  }
];

// System prompt agente — forza l'uso dei tool
const AGENT_SYSTEM = `Sei AInstAIn, un assistente AI italiano con accesso a tool potenti.

REGOLE FONDAMENTALI:
1. Per qualsiasi domanda su notizie, sport, persone, eventi, classifiche, risultati, meteo, prezzi → USA SEMPRE web_search. MAI rispondere dalla memoria.
2. Per domande su data/ora → USA SEMPRE get_current_datetime.
3. Per calcoli matematici → USA SEMPRE calculate.
4. Quando l'utente vuole salvare qualcosa → USA remember.
5. Rispondi SEMPRE in italiano.
6. Dopo aver usato un tool, usa i risultati per dare una risposta precisa e aggiornata.`;

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text || '').join(' ');
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
  return extractText(lastUser.content).replace(/---[\s\S]*?---/g, '').trim().slice(0, 200);
}

async function tavilySearch(query, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 5, include_answer: false }),
  });
  if (!res.ok) throw new Error('Tavily error: ' + res.status);
  const data = await res.json();
  return (data.results || []).map(r => '- ' + r.title + ': ' + (r.content || '') + ' (' + r.url + ')').join('\n');
}

function makeSSEStream(fn) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (obj) => writer.write(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n'));
  (async () => { try { await fn(send); } finally { writer.close(); } })();
  return readable;
}

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  let messages, model, forceWebSearch, useAgentMode, temperature, maxTokens;
  try {
    const body   = JSON.parse(await req.text());
    messages     = body.messages;
    model        = body.model || 'llama-3.3-70b-versatile';
    forceWebSearch = body.webSearch === true;
    useAgentMode = body.agentMode === true;
    temperature  = body.temperature != null ? body.temperature : 0.7;
    maxTokens    = body.max_tokens || 1024;
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid body: ' + e.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const sseHeaders = { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };

  // BRANCH A: AGENTE con tool calling
  if (useAgentMode) {
    const readable = makeSSEStream(async (send) => {
      send({ type: 'meta', webSearchUsed: false });
      try {
        // Prepara i messaggi con system prompt agente
        const agentMessages = [
          { role: 'system', content: AGENT_SYSTEM },
          ...messages.filter(m => m.role !== 'system')
        ];

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: agentMessages,
            tools: AGENT_TOOLS,
            tool_choice: 'required', // FORZA l'uso di un tool
            temperature,
            max_tokens: maxTokens,
            stream: false,
          }),
        });

        if (!groqRes.ok) {
          const err = await groqRes.text();
          send({ type: 'error', message: 'Groq ' + groqRes.status + ': ' + err });
          return;
        }

        const data    = await groqRes.json();
        const message = data.choices && data.choices[0] && data.choices[0].message;
        if (!message) { send({ type: 'error', message: 'Nessuna risposta' }); return; }

        if (message.tool_calls && message.tool_calls.length > 0) {
          send({ type: 'tool_calls', tool_calls: message.tool_calls, content: message.content || null });
        } else {
          const text = message.content || '';
          for (let i = 0; i < text.length; i += 4) send({ type: 'token', token: text.slice(i, i + 4) });
        }
        send({ type: 'done' });

      } catch (e) {
        send({ type: 'error', message: e.message });
      }
    });
    return new Response(readable, { status: 200, headers: sseHeaders });
  }

  // BRANCH B: STREAMING NORMALE con web search opzionale
  let webContext = '';
  const shouldSearch = tavilyKey && (forceWebSearch || needsWebSearch(messages));
  if (shouldSearch) {
    try {
      const query   = extractSearchQuery(messages);
      const results = await tavilySearch(query, tavilyKey);
      if (results) {
        const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
        webContext = '\n\n[RISULTATI WEB AGGIORNATI - ' + today + ']\nHo cercato: "' + query + '".\n' + results + '\n[Fine risultati web]\n\nUsa queste informazioni per rispondere. Cita la fonte quando utile.';
      }
    } catch (err) { console.error('Tavily failed:', err.message); }
  }

  let finalMessages = [...messages];
  if (webContext) {
    const sysIdx = finalMessages.findIndex(m => m.role === 'system');
    if (sysIdx !== -1) finalMessages[sysIdx] = { ...finalMessages[sysIdx], content: finalMessages[sysIdx].content + webContext };
    else finalMessages.unshift({ role: 'system', content: webContext });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: finalMessages, max_tokens: maxTokens, temperature, stream: true }),
    });
    if (!groqRes.ok) {
      const errText = await groqRes.text();
      return new Response(JSON.stringify({ error: errText }), { status: groqRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const usedWeb  = shouldSearch && !!webContext;
    const readable = makeSSEStream(async (send) => {
      send({ type: 'meta', webSearchUsed: usedWeb });
      const reader  = groqRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]' || !trimmed.startsWith('data: ')) continue;
          try {
            const json  = JSON.parse(trimmed.slice(6));
            const token = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
            if (token) send({ type: 'token', token });
            if (json.choices && json.choices[0] && json.choices[0].finish_reason) send({ type: 'done' });
          } catch {}
        }
      }
    });
    return new Response(readable, { status: 200, headers: sseHeaders });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
}
