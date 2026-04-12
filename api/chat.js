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

// Estrae testo da un content che può essere stringa o array multimodale
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join(' ');
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
  const clean = text.replace(/---[\s\S]*?---/g, '').trim();
  return clean.slice(0, 200);
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
  if (!res.ok) throw new Error(`Tavily Search error: ${res.status}`);
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

  let messages, model, forceWebSearch;
  try {
    const body     = JSON.parse(await req.text());
    messages       = body.messages;
    model          = body.model || 'llama-3.3-70b-versatile';
    forceWebSearch = body.webSearch === true;
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

  // ── Web Search (Tavily) ───────────────────────────────────────────────
  let webContext = '';
  const shouldSearch = tavilyKey && (forceWebSearch || needsWebSearch(messages));

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

  // ── Chiamata a Groq ───────────────────────────────────────────────────
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
        max_tokens: 1024,
        temperature: 0.7,
      }),
    });

    const responseText = await groqRes.text();
    if (!groqRes.ok) {
      return new Response(
        JSON.stringify({ error: responseText }),
        { status: groqRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data    = JSON.parse(responseText);
    const content = data.choices[0].message.content;
    const usedWeb = shouldSearch && !!webContext;

    return new Response(
      JSON.stringify({ message: { role: 'assistant', content }, webSearchUsed: usedWeb }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
