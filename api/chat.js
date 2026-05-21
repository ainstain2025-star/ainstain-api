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
      description: 'Cerca informazioni aggiornate su internet. Usa per notizie, sport, eventi recenti, persone famose, classifiche, risultati.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_current_datetime',
      description: 'Restituisce data e ora corrente.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Calcola espressioni matematiche.',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description: "Salva un'informazione nella memoria utente.",
      parameters: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] }
    }
  }
];

const AGENT_SYSTEM = 'Sei AInstAIn, un assistente AI italiano con tool disponibili. ' +
  'Usa SEMPRE i tool appropriati: web_search per qualsiasi informazione recente o fattuale, ' +
  'get_current_datetime per data/ora, calculate per calcoli, remember per salvare note. ' +
  'Rispondi sempre in italiano.';

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

async function executeTool(name, args, tavilyKey) {
  if (name === 'web_search') {
    if (!tavilyKey) return 'Web search non disponibile.';
    try { return await tavilySearch(args.query || '', tavilyKey) || 'Nessun risultato.'; }
    catch(e) { return 'Errore ricerca: ' + e.message; }
  }
  if (name === 'get_current_datetime') {
    return 'Data e ora corrente: ' + new Date().toLocaleString('it-IT', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
    });
  }
  if (name === 'calculate') {
    try {
      const expr = (args.expression || '').replace(/[^0-9+\-*/().,% \t]/gi, '');
      const result = Function('"use strict"; return (' + expr + ')')();
      return 'Risultato: ' + result;
    } catch(e) { return 'Impossibile calcolare: ' + e.message; }
  }
  if (name === 'remember') {
    return 'Memorizzato: "' + (args.note || '') + '"';
  }
  return 'Tool non riconosciuto: ' + name;
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

  let body;
  try {
    body = JSON.parse(await req.text());
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid body: ' + e.message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // ── DEBUG: logga i campi chiave del body ────────────────────────────
  console.log('[AInstAIn] body keys:', Object.keys(body).join(','));
  console.log('[AInstAIn] agentMode:', body.agentMode, '| model:', body.model, '| msgs:', body.messages && body.messages.length);

  const messages     = body.messages;
  const model        = body.model || 'llama-3.3-70b-versatile';
  const forceWebSearch = body.webSearch === true;
  const useAgentMode = body.agentMode === true;
  const temperature  = body.temperature != null ? body.temperature : 0.7;
  const maxTokens    = body.max_tokens || 1024;

  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages array required' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const sseHeaders = { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };

  console.log('[AInstAIn] useAgentMode:', useAgentMode);

  // BRANCH A: AGENTE
  if (useAgentMode) {
    console.log('[AInstAIn] Entering agent branch');
    const readable = makeSSEStream(async (send) => {
      send({ type: 'meta', webSearchUsed: false });
      try {
        const MAX_ITER = 6;
        let msgs = [
          { role: 'system', content: AGENT_SYSTEM },
          ...messages.filter(m => m.role !== 'system')
        ];

        for (let iter = 0; iter < MAX_ITER; iter++) {
          send({ type: 'agent_step', step: iter + 1, max: MAX_ITER });
          console.log('[AInstAIn] Agent iter', iter + 1, '| msgs:', msgs.length);

          const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
            // Modello ottimizzato per tool calling
            const toolModel = 'llama3-groq-70b-8192-tool-use-preview';
            body: JSON.stringify({ model: toolModel, messages: msgs, tools: AGENT_TOOLS, tool_choice: 'auto', temperature, max_tokens: maxTokens, stream: false }),
          });

          if (!groqRes.ok) {
            const err = await groqRes.text();
            console.log('[AInstAIn] Groq error:', groqRes.status, err.slice(0, 200));
            send({ type: 'error', message: 'Groq ' + groqRes.status + ': ' + err });
            return;
          }

          const data    = await groqRes.json();
          const message = data.choices && data.choices[0] && data.choices[0].message;
          if (!message) { send({ type: 'error', message: 'Nessuna risposta' }); return; }

          const toolCalls = message.tool_calls;
          console.log('[AInstAIn] finish_reason:', data.choices[0].finish_reason, '| tool_calls:', toolCalls ? toolCalls.length : 0);

          if (!toolCalls || toolCalls.length === 0) {
            const text = message.content || '';
            for (let i = 0; i < text.length; i += 4) send({ type: 'token', token: text.slice(i, i + 4) });
            send({ type: 'done' });
            return;
          }

          const toolNames = toolCalls.map(tc => tc.function && tc.function.name).filter(Boolean);
          send({ type: 'agent_tools', tools: toolNames });
          msgs.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });

          for (const tc of toolCalls) {
            const name = tc.function && tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function && tc.function.arguments || '{}'); } catch {}
            console.log('[AInstAIn] Executing tool:', name, '| args:', JSON.stringify(args).slice(0, 100));
            const result = await executeTool(name, args, tavilyKey);
            msgs.push({ role: 'tool', tool_call_id: tc.id, name: name, content: String(result) });
          }
        }

        send({ type: 'token', token: 'Ho raggiunto il limite di passi. Riprova.' });
        send({ type: 'done' });
      } catch (e) {
        console.log('[AInstAIn] Agent error:', e.message);
        send({ type: 'error', message: e.message });
      }
    });
    return new Response(readable, { status: 200, headers: sseHeaders });
  }

  // BRANCH B: STREAMING NORMALE
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
