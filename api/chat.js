export const config = { runtime: 'edge' };

// ── Provider chain per fallback automatico (Piano C) ─────────────────
// Se Groq è al limite (429), passa automaticamente al provider successivo.
// Tutti i provider usano il formato OpenAI-compatible.
const PROVIDER_CHAIN = [
  {
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    keyEnv: 'GROQ_API_KEY',
  },
  {
    name: 'Together',
    url: 'https://api.together.xyz/v1/chat/completions',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    keyEnv: 'TOGETHER_API_KEY',
  },
  {
    name: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    keyEnv: 'OPENROUTER_API_KEY',
    extraHeaders: { 'HTTP-Referer': 'https://ainstain.site', 'X-Title': 'AInstAIn' },
  },
];

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

const CALC_RE = /(quanto\s+fa\s+|calcola\s+|\d+\s*%\s*di\s*\d+|(?<!\d{3})\d{1,3}\s*[+*/]\s*\d+(?!\d)|\b\d{1,3}\s*-\s*\d{1,3}\b(?!\s*\d))/i;
const IMAGE_RE = /\b(genera|crea|disegna|illustra|mostrami|dipingi|produci)\s+(un[ao]?\s+)?(immagine|foto|illustrazione|dipinto|disegno|artwork|wallpaper|poster|logo)/i;
const DATETIME_RE = /\b(che ore|che giorno|che data|oggi è|giorno è|ora è|data oggi|orario)\b/i;
const REMEMBER_RE = /\b(ricorda che|memorizza|salva che|tieni a mente)\b/i;

// ── Modelli Multi-LLM ─────────────────────────────────────────────────
const MULTI_MODELS = [
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3' },
  { id: 'gemma2-9b-it',            name: 'Gemma 2'   },
  { id: 'mixtral-8x7b-32768',      name: 'Mixtral'   },
];
const JUDGE_MODEL = 'llama-3.1-8b-instant';

function buildPollinationsUrl(prompt) {
  const encoded = encodeURIComponent(prompt);
  return 'https://image.pollinations.ai/prompt/' + encoded + '?width=1024&height=1024&nologo=true&model=flux';
}

// ── Trova il provider disponibile (con fallback automatico) ──────────
// Ritorna { provider, apiKey } o null se tutti esauriti.
function getProviders(env) {
  return PROVIDER_CHAIN
    .map(p => ({ ...p, apiKey: env[p.keyEnv] }))
    .filter(p => p.apiKey);
}

// ── Chiamata con fallback automatico (non-streaming) ──────────────────
async function callWithFallback(providers, messages, maxTokens, temperature, model) {
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + p.apiKey,
          'Content-Type': 'application/json',
          ...(p.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: model || p.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }),
      });
      if (res.status === 429 || res.status === 503) {
        console.log('[AInstAIn] ' + p.name + ' rate limited, trying next...');
        continue; // prova il prossimo
      }
      if (!res.ok) throw new Error(p.name + ' error ' + res.status);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      console.log('[AInstAIn] callWithFallback: used ' + p.name);
      return { text, provider: p.name };
    } catch(e) {
      if (e.message.includes('rate limit') || e.message.includes('429')) {
        console.log('[AInstAIn] ' + p.name + ' rate limited, trying next...');
        continue;
      }
      console.log('[AInstAIn] ' + p.name + ' error: ' + e.message);
    }
  }
  throw new Error('Tutti i provider AI sono temporaneamente non disponibili. Riprova tra qualche minuto.');
}

// ── Streaming con fallback automatico ────────────────────────────────
async function streamWithFallback(providers, messages, maxTokens, temperature, model, onToken, onDone) {
  for (const p of providers) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + p.apiKey,
          'Content-Type': 'application/json',
          ...(p.extraHeaders || {}),
        },
        body: JSON.stringify({
          model: model || p.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: true,
        }),
      });
      if (res.status === 429 || res.status === 503) {
        console.log('[AInstAIn] ' + p.name + ' rate limited, trying next...');
        continue;
      }
      if (!res.ok) {
        const err = await res.text();
        if (res.status === 429) { console.log('[AInstAIn] ' + p.name + ' 429, next...'); continue; }
        throw new Error(p.name + ' ' + res.status + ': ' + err);
      }
      console.log('[AInstAIn] streamWithFallback: using ' + p.name);
      // Stream SSE
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
            if (j.choices?.[0]?.finish_reason) {
              onDone(j.choices[0].finish_reason === 'length' ? 'truncated' : 'done');
            }
          } catch {}
        }
      }
      return; // successo, esci dal loop
    } catch(e) {
      console.log('[AInstAIn] ' + p.name + ' stream error: ' + e.message);
      if (p === providers[providers.length - 1]) throw e; // ultimo provider, rilancia
    }
  }
}

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
    body: JSON.stringify({ api_key: apiKey, query, search_depth: 'advanced', max_results: 5, include_answer: true }),
  });
  if (!res.ok) throw new Error('Tavily ' + res.status);
  const data = await res.json();
  const answer = data.answer ? 'Risposta diretta: ' + data.answer + '\n\n' : '';
  const results = (data.results || []).map(r => '- ' + r.title + ': ' + (r.content || '') + ' (' + r.url + ')').join('\n');
  return answer + results;
}

function makeSSE(fn) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const send = obj => w.write(enc.encode('data: ' + JSON.stringify(obj) + '\n\n'));
  (async () => { try { await fn(send); } finally { w.close(); } })();
  return readable;
}

// ── Chiama un singolo modello Groq (non-streaming) ────────────────────
async function callGroq(model, messages, maxTokens, temperature, groqKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: false }),
  });
  if (!res.ok) throw new Error(model + ' error ' + res.status);
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

// ── Streaming da un modello Groq ──────────────────────────────────────
async function streamGroq(model, messages, maxTokens, temperature, groqKey, onToken, onDone) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, stream: true }),
  });
  if (!res.ok) { const e = await res.text(); throw new Error(model + ' ' + res.status + ': ' + e); }
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
        const tok = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (tok) onToken(tok);
        if (j.choices && j.choices[0] && j.choices[0].finish_reason) {
          if (j.choices[0].finish_reason === 'length') {
            // Risposta troncata per limite token
            onDone('truncated');
          } else {
            onDone('done');
          }
        }
      } catch {}
    }
  }
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
  const multiMode   = body.multiMode || null; // 'fast' | 'best' | null
  const temperature = body.temperature != null ? body.temperature : 0.7;
  const maxTokens   = body.max_tokens || 1024;

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  // Provider chain con fallback automatico
  const providers = getProviders(process.env);

  const sseH = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };
  const userText = getLastUserText(messages);
  console.log('[AInstAIn] agentMode=' + agentMode + ' multiMode=' + multiMode + ' | ' + userText.slice(0, 60));

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH MULTI-LLM
  // ══════════════════════════════════════════════════════════════════════
  if (multiMode) {
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: false });

      if (multiMode === 'fast') {
        // Modalità Fast: gara tra i 3 modelli, vince il primo che risponde
        send({ type: 'multi_start', models: MULTI_MODELS.map(m => m.name) });
        let winner = null;
        let fullText = '';

        const race = MULTI_MODELS.map(m =>
          callWithFallback([{ ...providers[0], model: m.id }], messages, maxTokens, temperature, m.id)
            .then(r => r && r.text ? { model: m, text: r.text } : Promise.reject())
            .catch(() => null)
        );

        const result = await Promise.any(race.map(p => p.then(r => r && r.text ? r : Promise.reject())));
        if (result) {
          winner = result.model;
          fullText = result.text;
          send({ type: 'multi_winner', model: winner.name });
          // Simula streaming del testo
          for (let i = 0; i < fullText.length; i += 4) {
            send({ type: 'token', token: fullText.slice(i, i + 4) });
          }
          send({ type: 'done' });
          console.log('[AInstAIn] Fast winner: ' + winner.name);
        } else {
          send({ type: 'error', message: 'Tutti i modelli hanno fallito' });
        }

      } else if (multiMode === 'best') {
        // Modalità Best: chiama tutti in parallelo, giudice sceglie/sintetizza
        send({ type: 'multi_start', models: MULTI_MODELS.map(m => m.name) });

        const results = await Promise.allSettled(
          MULTI_MODELS.map(m =>
            callWithFallback([{ ...providers[0], model: m.id }], messages, Math.min(maxTokens, 512), temperature, m.id)
              .then(r => ({ model: m.name, text: r.text }))
          )
        );

        const valid = results
          .filter(r => r.status === 'fulfilled' && r.value.text)
          .map(r => r.value);

        if (valid.length === 0) { send({ type: 'error', message: 'Nessun modello ha risposto' }); return; }
        if (valid.length === 1) {
          // Solo uno: usa direttamente
          send({ type: 'multi_winner', model: valid[0].model });
          for (let i = 0; i < valid[0].text.length; i += 4) send({ type: 'token', token: valid[0].text.slice(i, i + 4) });
          send({ type: 'done' });
          return;
        }

        // Invia le risposte intermedie al client
        send({ type: 'multi_responses', responses: valid.map(v => ({ model: v.model, preview: v.text.slice(0, 120) + '...' })) });

        // Giudice: sintetizza la risposta migliore
        const judgePrompt = 'Hai ricevuto queste risposte da diversi modelli AI alla domanda: "' + userText + '"\n\n' +
          valid.map((v, i) => 'Modello ' + (i+1) + ' (' + v.model + '):\n' + v.text).join('\n\n---\n\n') +
          '\n\nSintetizza la risposta più accurata, completa e utile in italiano. ' +
          'Integra il meglio di ogni risposta senza citare i modelli. ' +
          'Rispondi direttamente senza preamboli.';

        send({ type: 'multi_judging' });
        console.log('[AInstAIn] Best mode: judging ' + valid.length + ' responses');

        try {
          const judgeResult = await callWithFallback([{ ...providers[0], model: JUDGE_MODEL }], [
            { role: 'system', content: 'Sei un sintetizzatore di risposte AI. Produci sempre testo in italiano.' },
            { role: 'user', content: judgePrompt }
          ], maxTokens, 0.3, JUDGE_MODEL);
          const synthesis = judgeResult.text;
          send({ type: 'multi_winner', model: 'Sintesi Multi-AI' });
          for (let i = 0; i < synthesis.length; i += 4) send({ type: 'token', token: synthesis.slice(i, i + 4) });
          send({ type: 'done' });
        } catch(e) {
          // Fallback: usa la prima risposta valida
          send({ type: 'multi_winner', model: valid[0].model });
          for (let i = 0; i < valid[0].text.length; i += 4) send({ type: 'token', token: valid[0].text.slice(i, i + 4) });
          send({ type: 'done' });
        }
      }
    });
    return new Response(readable, { status: 200, headers: sseH });
  }

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
        toolUsed = 'generate_image';
        send({ type: 'agent_step', step: 1, max: 1 });
        send({ type: 'agent_tools', tools: ['generate_image'] });
        const imgPrompt = userText.replace(IMAGE_RE, '').replace(/^[\s,.:]+/, '').trim() || userText;
        const imgUrl = buildPollinationsUrl(imgPrompt + ', high quality, detailed, artistic');
        send({ type: 'agent_image', url: imgUrl, prompt: imgPrompt });
        send({ type: 'done' });
        return;
      }
      else if (tavilyKey && (forceWeb || WEB_TRIGGERS.some(re => re.test(userText)))) {
        toolUsed = 'web_search';
        send({ type: 'agent_step', step: 1, max: 2 });
        send({ type: 'agent_tools', tools: ['web_search'] });
        const searchQuery = userText.slice(0, 150) + ' ' + new Date().getFullYear();
        try {
          const results = await tavilySearch(searchQuery, tavilyKey);
          const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
          toolContext = '\n\n[TOOL: web_search - ' + today + ']\n' + results + '\n[/TOOL]\n\nUsa questi risultati aggiornati per rispondere. Cita le fonti.';
        } catch(e) {
          toolContext = '\n\n[TOOL: web_search]\nRicerca non disponibile: ' + e.message + '\n[/TOOL]';
        }
      }

      send({ type: 'agent_step', step: toolUsed ? 2 : 1, max: toolUsed ? 2 : 1 });
      let finalMsgs = [...messages];
      if (toolContext) {
        const originalSystem = finalMsgs.find(m => m.role === 'system');
        const baseSystem = originalSystem ? originalSystem.content : 'Sei AInstAIn, un assistente AI italiano. Rispondi SEMPRE in italiano.';
        const agentSystem = baseSystem + toolContext;
        const sysIdx = finalMsgs.findIndex(m => m.role === 'system');
        if (sysIdx !== -1) finalMsgs[sysIdx] = { ...finalMsgs[sysIdx], content: agentSystem };
        else finalMsgs.unshift({ role: 'system', content: agentSystem });
      }

      try {
        await streamWithFallback(providers, finalMsgs, maxTokens, temperature, model,
          tok => send({ type: 'token', token: tok }),
          reason => send({ type: reason || 'done' })
        );
      } catch(e) {
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
    const readable = makeSSE(async (send) => {
      send({ type: 'meta', webSearchUsed: shouldSearch && !!webCtx });
      await streamWithFallback(providers, finalMsgs, maxTokens, temperature, model,
        tok => send({ type: 'token', token: tok }),
        reason => send({ type: reason || 'done' })
      );
    });
    return new Response(readable, { status: 200, headers: sseH });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
