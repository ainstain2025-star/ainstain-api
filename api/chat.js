export const config = {
  runtime: 'edge',
};

// ── Parole chiave che suggeriscono necessità di info aggiornate ──────────
const WEB_SEARCH_TRIGGERS = [
  /\b(oggi|adesso|ora|attuale|attualmente|recente|recentemente|ultimo|ultimi|ultime|notizie|news)\b/i,
  /\b(2024|2025|2026)\b/,
  /\b(today|now|current|currently|latest|recent|recently|news)\b/i,
  /\b(chi è|chi sono|cos'è|cosa è|cos è|dov'è|quando è|quanto costa|prezzo di)\b/i,
  /\b(meteo|tempo|temperatura|previsioni)\b/i,
  /\b(classifica|ranking|risultati|vincitore|campione)\b/i,
];

function needsWebSearch(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return false;
  const text = typeof lastUser.content === 'string' ? lastUser.content : '';
  return WEB_SEARCH_TRIGGERS.some(re => re.test(text));
}

function extractSearchQuery(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return '';
  const text = typeof lastUser.content === 'string' ? lastUser.content : '';
  // Rimuovi parti del documento iniettato (troppo lungo per cercare)
  const clean = text.replace(/---[\s\S]*?---/g, '').trim();
  return clean.slice(0, 200);
}

async function braveSearch(query, apiKey) {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5&search_lang=it&country=IT`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
  });
  if (!res.ok) throw new Error(`Brave Search error: ${res.status}`);
  const data = await res.json();
  const results = data.web?.results || [];
  return results.map(r => `- ${r.title}: ${r.description || ''} (${r.url})`).join('\n');
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
    const body = JSON.parse(await req.text());
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

  const groqKey  = process.env.GROQ_API_KEY;
  const braveKey = process.env.BRAVE_API_KEY;

  if (!groqKey) {
    return new Response(
      JSON.stringify({ error: 'GROQ_API_KEY non configurata' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // ── Web Search ────────────────────────────────────────────────────────
  let webContext = '';
  const shouldSearch = braveKey && (forceWebSearch || needsWebSearch(messages));

  if (shouldSearch) {
    try {
      const query   = extractSearchQuery(messages);
      const results = await braveSearch(query, braveKey);
      if (results) {
        const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
        webContext = `\n\n[RISULTATI WEB AGGIORNATI - ${today}]\nHo cercato in rete informazioni su: "${query}". Ecco i risultati trovati:\n${results}\n[Fine risultati web]\n\nUsa queste informazioni aggiornate per rispondere. Cita la fonte quando utile.`;
      }
    } catch (err) {
      // Se la ricerca fallisce, procedi senza — non bloccare la risposta
      console.error('Brave search failed:', err.message);
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
