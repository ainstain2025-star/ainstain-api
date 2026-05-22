export const config = { runtime: 'edge' };

const WEB_TRIGGERS = [
  /\b(oggi|adesso|ora|attuale|attualmente|recente|recentemente|ultimo|ultima|ultimi|ultime|notizie|news|ha vinto|hanno vinto|chi ha|chi è|dov'è)\b/i,
  /\b(2024|2025|2026)\b/,
  /\b(today|now|current|currently|latest|recent|news)\b/i,
  /\b(chi è|chi sono|cos'è|dov'è|quando è|quanto costa)\b/i,
  /\b(meteo|tempo|temperatura|previsioni)\b/i,
  /\b(classifica|ranking|risultati|vincitore|campione|partita|gol)\b/i,
  /\b(borsa|azioni|bitcoin|crypto|euro|dollaro)\b/i,
  /\b(elezioni|governo|presidente|premier|ministro)\b/i,
];

const CALC_RE = /\b(\d[\d\s]*[%+\-*/]\s*[\d\s]+|\d+\s*%\s*di\s*\d+)\b/i;
const DATETIME_RE = /\b(che ore|che giorno|che data|oggi è|giorno è|ora è|data oggi|orario)\b/i;
const REMEMBER_RE = /\b(ricorda che|memorizza|salva che|tieni a mente)\b/i;

function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text || '').join(' ');
  return '';
}

function getLastUserText(messages) {
  const m = [...messages].reverse().find(m => m.role === 'user');
  return m ? extractText(m.content) : '';
}

async function tavilySearch(query, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'basic', max_results: 5 }),
  });
  if (!res.ok) throw new Error('Tavily ' + res.status);
  const data = await res.json();
  return (data.results || []).map(r => '- ' + r.title + ': ' + (r.content || '') + ' (' + r.url + ')').join('\n');
}

function makeSSE(fn) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => w.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
  (async () => { try { await fn(send); } finally { w.close(); } })();
  return readable;
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  let body;
  try { body = JSON.parse(await req.text()); }
  catch (e) { return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }

  const messages    = body.messages || [];
  const model       = body.model || 'llama-3.3-70b-versatile';
  const forceWeb    = body.webSearch === true;
  const agentMode   = body.agentMode === true;
  const temperature = body.temperature != null ? body.temperature : 0.7;
  const maxTokens   = body.max_tokens || 1024;

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });

  const sseH = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };
  const userText = getLastUserText(messages);

  // DEBUG — visibile in Vercel Logs
  console.log('[AInstAIn] agentMode=' + agentMode + ' | userText=' + userText.slice(0, 80));

  // ══════════════════════════════════════════════════════════════════════
  // MODALITÀ AGENTE
  // ══════════════════════════════════════════════════════════════════════
  if (agentMode) {
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: false });
      let toolContext = '';
      let toolUsed = null;

      if (DATETIME_RE.test(userText)) {
        toolUsed = 'get_current_datetime';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['get_current_datetime'] });
        const now = new Date();
        toolContext = '\n\n[TOOL: get_current_datetime]\n' +
          now.toLocaleString('it-IT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }) +
          '\n[/TOOL]\n\nUsa questa informazione per rispondere.';
        console.log('[AInstAIn] Tool: get_current_datetime');
      }
      else if (CALC_RE.test(userText)) {
        toolUsed = 'calculate';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['calculate'] });
        try {
          const expr = userText
            .replace(/(\d+(?:[.,]\d+)?)\s*%\s*di\s*(\d+(?:[.,]\d+)?)/gi, (_, a, b) => '(' + a.replace(',', '.') + '/100*' + b.replace(',', '.') + ')')
            .replace(/[^0-9+\-*/().,]/g, ' ').trim();
          const result = Function('"use strict"; return (' + expr + ')')();
          toolContext = '\n\n[TOOL: calculate]\nRisultato: ' + result + '\n[/TOOL]\n\nUsa questo risultato per rispondere.';
        } catch(e) {
          toolContext = '\n\n[TOOL: calculate]\nImpossibile calcolare. Spiega come farlo.\n[/TOOL]';
        }
        console.log('[AInstAIn] Tool: calculate');
      }
      else if (REMEMBER_RE.test(userText)) {
        toolUsed = 'remember';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['remember'] });
        const note = userText.replace(REMEMBER_RE, '').trim();
        toolContext = '\n\n[TOOL: remember]\nInformazione salvata: "' + note + '"\n[/TOOL]\n\nConferma all\'utente che hai salvato questa informazione.';
        send({ type: 'agent_saved', note });
        console.log('[AInstAIn] Tool: remember | note=' + note.slice(0, 50));
      }
      else if (tavilyKey && (forceWeb || WEB_TRIGGERS.some(re => re.test(userText)))) {
        toolUsed = 'web_search';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['web_search'] });
        const year = new Date().getFullYear();
        const searchQuery = userText.slice(0, 150) + ' ' + year;
        console.log('[AInstAIn] Tool: web_search | query=' + searchQuery);
        try {
          const results = await tavilySearch(searchQuery, tavilyKey);
          const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
          toolContext = '\n\n[TOOL: web_search - ' + today + ']\n' + results + '\n[/TOOL]\n\nUsa questi risultati aggiornati per rispondere. Cita le fonti.';
          console.log('[AInstAIn] Tavily OK | results=' + results.slice(0, 100));
        } catch(e) {
          toolContext = '\n\n[TOOL: web_search]\nRicerca non disponibile: ' + e.message + '\n[/TOOL]';
          console.log('[AInstAIn] Tavily ERROR: ' + e.message);
        }
      } else {
        console.log('[AInstAIn] No tool matched for: ' + userText.slice(0, 80));
      }

      send({ type: 'agent_step', step: toolUsed ? 2 : 1, max: toolUsed ? 2 : 1 });

      let finalMsgs = [...messages];
      if (toolContext) {
        const agentSystem = 'Sei AInstAIn, un assistente AI italiano con accesso a tool.' + toolContext;
        const sysIdx = finalMsgs.findIndex(m => m.role === 'system');
        if (sysIdx !== -1) finalMsgs[sysIdx] = { ...finalMsgs[sysIdx], content: agentSystem };
        else finalMsgs.unshift({ role: 'system', content: agentSystem });
      }

      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: finalMsgs, max_tokens: maxTokens, temperature, stream: true }),
        });
        if (!groqRes.ok) {
          const err = await groqRes.text();
          console.log('[AInstAIn] Groq error: ' + groqRes.status + ' ' + err.slice(0, 100));
          send({ type: 'error', message: 'Groq ' + groqRes.status + ': ' + err });
          return;
        }
        const reader = groqRes.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            const t = line.trim();
            if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
            try {
              const j = JSON.parse(t.slice(6));
              const tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if (tok) send({ type: 'token', token: tok });
              if (j.choices && j.choices[0] && j.choices[0].finish_reason) send({ type: 'done' });
            } catch {}
          }
        }
      } catch(e) {
        console.log('[AInstAIn] Stream error: ' + e.message);
        send({ type: 'error', message: e.message });
      }
    });
    return new Response(readable, { status: 200, headers: sseH });
  }

  // ══════════════════════════════════════════════════════════════════════
  // STREAMING NORMALE
  // ══════════════════════════════════════════════════════════════════════
  let webCtx = '';
  const shouldSearch = tavilyKey && (forceWeb || WEB_TRIGGERS.some(re => re.test(userText)));
  if (shouldSearch) {
    try {
      const q = userText.replace(/---[\s\S]*?---/g, '').trim().slice(0, 200);
      const r = await tavilySearch(q, tavilyKey);
      if (r) {
        const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
        webCtx = '\n\n[RISULTATI WEB - ' + today + ']\nHo cercato: "' + q + '".\n' + r + '\n[Fine risultati]\n\nUsa queste informazioni. Cita le fonti.';
      }
    } catch(e) { console.error('Tavily:', e.message); }
  }

  let finalMsgs = [...messages];
  if (webCtx) {
    const si = finalMsgs.findIndex(m => m.role === 'system');
    if (si !== -1) finalMsgs[si] = { ...finalMsgs[si], content: finalMsgs[si].content + webCtx };
    else finalMsgs.unshift({ role: 'system', content: webCtx });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: finalMsgs, max_tokens: maxTokens, temperature, stream: true }),
    });
    if (!groqRes.ok) {
      const e = await groqRes.text();
      return new Response(JSON.stringify({ error: e }), { status: groqRes.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    const usedWeb = shouldSearch && !!webCtx;
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: usedWeb });
      const reader = groqRes.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
          try {
            const j = JSON.parse(t.slice(6));
            const tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (tok) send({ type: 'token', token: tok });
            if (j.choices && j.choices[0] && j.choices[0].finish_reason) send({ type: 'done' });
          } catch {}
        }
      }
    });
    return new Response(readable, { status: 200, headers: sseH });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
