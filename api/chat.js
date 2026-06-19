export const config = { runtime: 'edge' };

// ── Provider chain ────────────────────────────────────────────────────
const PROVIDER_CHAIN = [
  { name: 'Groq',       url: 'https://api.groq.com/openai/v1/chat/completions',       model: 'llama-3.3-70b-versatile',                    keyEnv: 'GROQ_API_KEY' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions',          model: 'meta-llama/llama-3.3-70b-instruct:free',     keyEnv: 'OPENROUTER_API_KEY', extraHeaders: { 'HTTP-Referer': 'https://ainstain.site', 'X-Title': 'AInstAIn' } },
];

const MULTI_MODELS = [
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3' },
  { id: 'gemma2-9b-it',            name: 'Gemma 2'   },
  { id: 'mixtral-8x7b-32768',      name: 'Mixtral'   },
];
const JUDGE_MODEL = 'llama-3.1-8b-instant';

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
const CALC_RE    = /(quanto\s+fa\s+|calcola\s+|\d+\s*%\s*di\s*\d+|(?<!\d{3})\d{1,3}\s*[+*/]\s*\d+(?!\d)|\b\d{1,3}\s*-\s*\d{1,3}\b(?!\s*\d))/i;
const IMAGE_RE   = /\b(genera|crea|disegna|illustra|mostrami|dipingi|produci)\s+(un[ao]?\s+)?(immagine|foto|illustrazione|dipinto|disegno|artwork|wallpaper|poster|logo)/i;
const DATETIME_RE= /\b(che ore|che giorno|che data|oggi è|giorno è|ora è|data oggi|orario)\b/i;
const REMEMBER_RE= /\b(ricorda che|memorizza|salva che|tieni a mente)\b/i;

// ── Cache risposte ────────────────────────────────────────────────────
const responseCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_MAX = 50;

function getCacheKey(messages, model) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = lastUser ? extractText(lastUser.content) : '';
  return model + ':' + text.slice(0, 200).toLowerCase().replace(/\s+/g, ' ').trim();
}
function getCached(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { responseCache.delete(key); return null; }
  return entry.text;
}
function setCache(key, text) {
  if (responseCache.size >= CACHE_MAX) {
    const oldest = [...responseCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) responseCache.delete(oldest[0]);
  }
  responseCache.set(key, { text, ts: Date.now() });
}

// ── Routing intelligente ──────────────────────────────────────────────
function selectBestModel(text, defaultModel) {
  if (!text) return defaultModel;
  if (/\b(scrivi|analizza|spiega.*dettagl|codice|programm|funzione|algoritmo|essay|articolo|relazione|riassunto lungo)\b/i.test(text)) return 'mixtral-8x7b-32768';
  if (/\b(perché|ragiona|confronta|differenza|vantaggio|svantaggio|pro.*contro|calcola|dimostra|argomenta)\b/i.test(text)) return 'gemma2-9b-it';
  return defaultModel;
}

// ── Helper functions ──────────────────────────────────────────────────
function extractText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text || '').join(' ');
  return '';
}
function getLastUserText(messages) {
  const m = [...messages].reverse().find(m => m.role === 'user');
  return m ? extractText(m.content) : '';
}
function buildPollinationsUrl(prompt) {
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=1024&height=1024&nologo=true&model=flux';
}

async function tavilySearch(query, apiKey) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: 5, include_answer: true }),
  });
  if (!res.ok) throw new Error('Tavily ' + res.status);
  const data = await res.json();
  const answer = data.answer ? 'Risposta diretta: ' + data.answer + '\n\n' : '';
  return answer + (data.results || []).map(r => '- ' + r.title + ': ' + (r.content || '') + ' (' + r.url + ')').join('\n');
}

function getProviders(env) {
  return PROVIDER_CHAIN.map(p => ({ ...p, apiKey: env[p.keyEnv] })).filter(p => p.apiKey);
}

function makeSSE(fn) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => w.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
  (async () => { try { await fn(send); } finally { w.close(); } })();
  return readable;
}

// ── Chiamata non-streaming con fallback ───────────────────────────────
async function callWithFallback(providers, messages, maxTokens, temperature, model) {
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) },
        body: JSON.stringify({ model: model || p.model, messages, max_tokens: maxTokens, temperature, stream: false }),
      });
      if (res.status === 429 || res.status === 503) { console.log('[AI] ' + p.name + ' rate limited, next...'); continue; }
      if (!res.ok) throw new Error(p.name + ' error ' + res.status);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      console.log('[AI] callWithFallback: used ' + p.name);
      return { text, provider: p.name };
    } catch(e) {
      if (e.message.includes('429')) { continue; }
      console.log('[AI] ' + p.name + ' error: ' + e.message);
    }
  }
  throw new Error('Tutti i provider non disponibili. Riprova tra qualche minuto.');
}

// ── Streaming con fallback ────────────────────────────────────────────
async function streamWithFallback(providers, messages, maxTokens, temperature, model, onToken, onDone) {
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) },
        body: JSON.stringify({ model: model || p.model, messages, max_tokens: maxTokens, temperature, stream: true }),
      });
      if (res.status === 429 || res.status === 503) { console.log('[AI] ' + p.name + ' rate limited, next...'); continue; }
      if (!res.ok) { const e = await res.text(); if (res.status === 429) continue; throw new Error(p.name + ': ' + e); }
      console.log('[AI] streamWithFallback: using ' + p.name);
      const reader = res.body.getReader();
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
            const tok = j.choices?.[0]?.delta?.content;
            if (tok) onToken(tok);
            if (j.choices?.[0]?.finish_reason) onDone(j.choices[0].finish_reason === 'length' ? 'truncated' : 'done');
          } catch {}
        }
      }
      return;
    } catch(e) {
      console.log('[AI] ' + p.name + ' stream error: ' + e.message);
      if (p === providers[providers.length - 1]) throw e;
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST')  return new Response('Method not allowed', { status: 405, headers: cors });

  let body;
  try { body = JSON.parse(await req.text()); }
  catch(e) { return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }

  const messages    = body.messages || [];
  const model       = body.model || 'llama-3.3-70b-versatile';
  const forceWeb    = body.webSearch === true;
  const agentMode   = body.agentMode === true;
  const multiMode   = body.multiMode || null;
  const temperature = body.temperature != null ? body.temperature : 0.7;
  const maxTokens   = body.max_tokens || 4096;

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });

  const providers  = getProviders(process.env);
  const userText   = getLastUserText(messages);
  const smartModel = selectBestModel(userText, model);
  const sseH       = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };

  console.log('[AI] agentMode=' + agentMode + ' multiMode=' + multiMode + ' smartModel=' + smartModel);

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH: MULTI-LLM (Fast o Best)
  // ══════════════════════════════════════════════════════════════════════
  if (multiMode) {
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: false });

      if (multiMode === 'fast') {
        send({ type: 'multi_start', models: MULTI_MODELS.map(m => m.name) });
        const race = MULTI_MODELS.map(m =>
          callWithFallback([{ ...providers[0], model: m.id }], messages, maxTokens, temperature, m.id)
            .then(r => r && r.text ? { model: m, text: r.text } : Promise.reject())
            .catch(() => null)
        );
        try {
          const result = await Promise.any(race.map(p => p.then(r => r || Promise.reject())));
          if (result) {
            send({ type: 'multi_winner', model: result.model.name });
            for (let i = 0; i < result.text.length; i += 4) send({ type: 'token', token: result.text.slice(i, i+4) });
            send({ type: 'done' });
          }
        } catch { send({ type: 'error', message: 'Tutti i modelli hanno fallito' }); }

      } else {
        // Best: tutti in parallelo + giudice
        send({ type: 'multi_start', models: MULTI_MODELS.map(m => m.name) });
        const results = await Promise.allSettled(
          MULTI_MODELS.map(m =>
            callWithFallback([{ ...providers[0], model: m.id }], messages, Math.min(maxTokens, 768), temperature, m.id)
              .then(r => ({ model: m.name, text: r.text }))
          )
        );
        const valid = results.filter(r => r.status === 'fulfilled' && r.value?.text).map(r => r.value);
        console.log('[AI] Best-of-N: ' + valid.length + '/' + MULTI_MODELS.length + ' responded');

        if (valid.length === 0) { send({ type: 'error', message: 'Nessun modello ha risposto' }); return; }
        if (valid.length === 1) {
          send({ type: 'multi_winner', model: valid[0].model });
          for (let i = 0; i < valid[0].text.length; i += 4) send({ type: 'token', token: valid[0].text.slice(i, i+4) });
          send({ type: 'done' }); return;
        }

        send({ type: 'multi_responses', responses: valid.map(v => ({ model: v.model, preview: v.text.slice(0, 150) + '...' })) });

        const judgePrompt = 'Domanda: "' + userText + '"\n\n' +
          valid.map((v,i) => 'Risposta ' + (i+1) + ' (' + v.model + '):\n' + v.text).join('\n\n---\n\n') +
          '\n\nSintetizza la risposta migliore in italiano, completa e precisa, senza citare i modelli.';

        send({ type: 'multi_judging' });
        const judgeResult = await callWithFallback(
          [{ ...providers[0], model: JUDGE_MODEL }],
          [{ role: 'system', content: 'Sintetizza risposte AI in italiano, preciso e completo.' }, { role: 'user', content: judgePrompt }],
          maxTokens, 0.3, JUDGE_MODEL
        );
        const synthesis = judgeResult.text;
        setCache(getCacheKey(messages, smartModel), synthesis);
        send({ type: 'multi_winner', model: 'Sintesi Multi-AI' });
        for (let i = 0; i < synthesis.length; i += 4) send({ type: 'token', token: synthesis.slice(i, i+4) });
        send({ type: 'done' });
      }
    });
    return new Response(readable, { status: 200, headers: sseH });
  }

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH: AGENTE
  // ══════════════════════════════════════════════════════════════════════
  if (agentMode) {
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: false });
      let toolContext = '', toolUsed = null;

      if (DATETIME_RE.test(userText)) {
        toolUsed = 'get_current_datetime';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['get_current_datetime'] });
        const now = new Date();
        toolContext = '\n\n[TOOL: get_current_datetime]\n' + now.toLocaleString('it-IT', { weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short' }) + '\n[/TOOL]\n\nUsa questa informazione per rispondere.';
      }
      else if (CALC_RE.test(userText)) {
        toolUsed = 'calculate';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['calculate'] });
        try {
          const expr = userText.replace(/(\d+(?:[.,]\d+)?)\s*%\s*di\s*(\d+(?:[.,]\d+)?)/gi, (_,a,b) => '('+a.replace(',','.')+'/100*'+b.replace(',','.')+')').replace(/[^0-9+\-*/().,]/g,' ').trim();
          const result = Function('"use strict"; return (' + expr + ')')();
          toolContext = '\n\n[TOOL: calculate]\nRisultato: ' + result + '\n[/TOOL]\n\nUsa questo risultato per rispondere.';
        } catch(e) { toolContext = '\n\n[TOOL: calculate]\nImpossibile calcolare. Spiega come farlo.\n[/TOOL]'; }
      }
      else if (REMEMBER_RE.test(userText)) {
        toolUsed = 'remember';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['remember'] });
        const note = userText.replace(REMEMBER_RE, '').trim();
        toolContext = '\n\n[TOOL: remember]\nInformazione salvata: "' + note + '"\n[/TOOL]\n\nConferma all\'utente che hai salvato questa informazione.';
        send({ type: 'agent_saved', note });
      }
      else if (IMAGE_RE.test(userText)) {
        send({ type: 'agent_step', step: 1, max: 1 });
        send({ type: 'agent_tools', tools: ['generate_image'] });
        const imgPrompt = userText.replace(IMAGE_RE, '').replace(/^[\s,.:]+/, '').trim() || userText;
        send({ type: 'agent_image', url: buildPollinationsUrl(imgPrompt + ', high quality, detailed, artistic'), prompt: imgPrompt });
        send({ type: 'done' }); return;
      }
      else if (tavilyKey && (forceWeb || WEB_TRIGGERS.some(re => re.test(userText)))) {
        toolUsed = 'web_search';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['web_search'] });
        try {
          const results = await tavilySearch(userText.slice(0, 150) + ' ' + new Date().getFullYear(), tavilyKey);
          const today = new Date().toLocaleDateString('it-IT', { day:'2-digit', month:'long', year:'numeric' });
          toolContext = '\n\n[TOOL: web_search - ' + today + ']\n' + results + '\n[/TOOL]\n\nUsa questi risultati aggiornati per rispondere. Cita le fonti.';
        } catch(e) { toolContext = '\n\n[TOOL: web_search]\nRicerca non disponibile: ' + e.message + '\n[/TOOL]'; }
      }

      send({ type: 'agent_step', step: toolUsed ? 2 : 1, max: toolUsed ? 2 : 1 });
      let finalMsgs = [...messages];
      if (toolContext) {
        const sys = finalMsgs.find(m => m.role === 'system');
        const base = sys ? sys.content : 'Sei AInstAIn, un assistente AI italiano. Rispondi SEMPRE in italiano.';
        const si = finalMsgs.findIndex(m => m.role === 'system');
        if (si !== -1) finalMsgs[si] = { ...finalMsgs[si], content: base + toolContext };
        else finalMsgs.unshift({ role: 'system', content: base + toolContext });
      }
      try {
        await streamWithFallback(providers, finalMsgs, maxTokens, temperature, model,
          tok => send({ type: 'token', token: tok }),
          reason => send({ type: reason || 'done' })
        );
      } catch(e) { send({ type: 'error', message: e.message }); }
    });
    return new Response(readable, { status: 200, headers: sseH });
  }

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH: STREAMING NORMALE
  // ══════════════════════════════════════════════════════════════════════

  // Cache check
  if (!forceWeb) {
    const cacheKey = getCacheKey(messages, smartModel);
    const cached = getCached(cacheKey);
    if (cached) {
      console.log('[AI] Cache HIT');
      const readable = makeSSE(async (send) => {
        send({ type: 'meta', webSearchUsed: false });
        for (let i = 0; i < cached.length; i += 4) send({ type: 'token', token: cached.slice(i, i+4) });
        send({ type: 'done' });
      });
      return new Response(readable, { status: 200, headers: sseH });
    }
  }

  // Web search
  let webCtx = '';
  const shouldSearch = tavilyKey && (forceWeb || WEB_TRIGGERS.some(re => re.test(userText)));
  if (shouldSearch) {
    try {
      const q = userText.replace(/---[\s\S]*?---/g, '').trim().slice(0, 200);
      const r = await tavilySearch(q, tavilyKey);
      if (r) {
        const today = new Date().toLocaleDateString('it-IT', { day:'2-digit', month:'long', year:'numeric' });
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
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: shouldSearch && !!webCtx });
      await streamWithFallback(providers, finalMsgs, maxTokens, temperature, smartModel,
        tok => send({ type: 'token', token: tok }),
        reason => send({ type: reason || 'done' })
      );
    });
    return new Response(readable, { status: 200, headers: sseH });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
