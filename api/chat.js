export const config = { runtime: 'edge', maxDuration: 60 };

import { jwtVerify } from 'jose';
import { freeDailyLimiter, abuseLimiter, getClientIp } from './lib/rateLimit.js';

// ── Provider chain ────────────────────────────────────────────────────
// NOTA su OpenRouter (fallback): il catalogo dei modelli gratuiti cambia
// spesso, anche senza preavviso — a inizio agosto 2026 hanno eliminato
// l'intero livello gratuito Llama (compreso quello usato qui prima),
// causando un errore 404/400 ogni volta che scattava il fallback.
// "openrouter/free" è il selettore automatico ufficiale di OpenRouter:
// sceglie da solo un modello gratuito disponibile in quel momento,
// così il fallback non si rompe più se un modello specifico sparisce
// dal loro catalogo. Compromesso accettato: la risposta del fallback
// può variare leggermente di modello in modello — accettabile perché
// OpenRouter qui è solo la riserva, non il provider principale.
const PROVIDER_CHAIN = [
  { name: 'Groq',       url: 'https://api.groq.com/openai/v1/chat/completions',       model: 'llama-3.3-70b-versatile',                    keyEnv: 'GROQ_API_KEY' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions',          model: 'openrouter/free',                            keyEnv: 'OPENROUTER_API_KEY', extraHeaders: { 'HTTP-Referer': 'https://ainstain.site', 'X-Title': 'AInstAIn' } },
];

// NOTA 2026-08-23: gemma2-9b-it (deprecato ott. 2025) e mixtral-8x7b-32768
// (deprecato mar. 2025) erano usati qui ma non più disponibili su Groq da
// mesi — la modalità Multi-AI girava di fatto con un solo modello su 3,
// in modo silenzioso (Promise.allSettled scarta i falliti senza errore
// visibile). Sostituiti con GPT-OSS 120B/20B, modelli attualmente attivi
// (verificato su console.groq.com/docs/models), diversi da Llama per una
// vera diversità di "opinioni" nel confronto Best-of-N.
const MULTI_MODELS = [
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3'   },
  { id: 'openai/gpt-oss-120b',     name: 'GPT-OSS 120B' },
  { id: 'openai/gpt-oss-20b',      name: 'GPT-OSS 20B'  },
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
// Le regex CALC_RE/IMAGE_RE/DATETIME_RE/REMEMBER_RE del vecchio dispatcher
// a singolo tool non servono più: ora è l'AI stessa a scegliere lo
// strumento leggendo la descrizione nel prompt del loop ReAct (vedi sotto).

// ── LOOP ReAct: istruzioni, parsing, esecuzione strumenti ─────────────
// Non usiamo il tool-calling nativo di Groq (in passato causava bug di
// formato) — l'agente ragiona in testo strutturato che analizziamo noi:
// classico schema ReAct (Thought → Action → Observation, ripetuto) usato
// dai framework agentici prima dell'arrivo del function-calling nativo.
const MAX_REACT_STEPS = 8;

function buildReActSystemPrompt(baseSystemPrompt) {
  return baseSystemPrompt + `

---
MODALITÀ AGENTE (ragionamento multi-step). Risolvi la richiesta ragionando passo dopo passo.

Strumenti disponibili:
- web_search: cerca informazioni aggiornate sul web. USALO SEMPRE per: meteo/previsioni, notizie, prezzi/quotazioni, eventi recenti, orari di apertura, disponibilità, o qualunque informazione che cambia nel tempo e che non conosci con certezza dai tuoi dati di addestramento. Non rifiutare mai una richiesta di questo tipo dicendo che non hai accesso a dati in tempo reale: prova PRIMA con questo strumento. Input: la query di ricerca (es. "meteo Napoli oggi", "previsioni Milano domani").
- get_current_datetime: restituisce data e ora attuali in UTC. Input: scrivi "-" (non serve altro). Se l'utente ha bisogno dell'ora nel suo fuso orario locale (non UTC) e non l'ha già indicato nella conversazione, NON calcolarla a caso: chiedigli prima in che città o fuso orario si trova, poi calcola tu la conversione da UTC una volta che te lo dice.
- calculate: esegue un calcolo matematico VERO (es. "150 * 0.20", "34 + 12"). NON usarlo per domande di comprensione testuale che contengono solo numeri/importi/date come parte del testo (es. scegliere l'opzione corretta tra alternative, confrontare due frasi, verificare una trascrizione) — quelle si risolvono ragionando, non calcolando.
- remember: salva un'informazione permanente sull'utente. Input: l'informazione da salvare.
- generate_image: genera un'immagine (termina sempre il turno). Input: descrizione dell'immagine.

Per OGNI passo rispondi ESATTAMENTE in uno di questi due formati, niente altro testo prima o dopo:

Per usare uno strumento:
THOUGHT: <ragionamento breve, una frase>
ACTION: <nome esatto dello strumento>
ACTION_INPUT: <input per lo strumento>

Per dare la risposta finale (quando hai già tutte le informazioni necessarie):
THOUGHT: <ragionamento breve>
FINAL_ANSWER: <risposta completa e ben scritta per l'utente, in italiano>

REGOLA PIÙ IMPORTANTE: la maggior parte delle domande NON richiede nessuno strumento — domande di conoscenza generale, ragionamento, scelta multipla, confronto tra testi, opinioni, spiegazioni, scrittura creativa, ecc. vanno risolte SUBITO con FINAL_ANSWER al primo passo. Usa uno strumento SOLO se ti serve davvero un dato che non hai (es. informazioni aggiornate dal web, data/ora reale, un calcolo aritmetico vero, salvare un ricordo). Nel dubbio, preferisci rispondere direttamente piuttosto che usare uno strumento inutile.

REGOLA COMPLEMENTARE: se invece la richiesta riguarda un'informazione in tempo reale che NON conosci con certezza (meteo, notizie, prezzi, eventi recenti, orari, disponibilità, ecc.), NON rifiutare subito dicendo che non hai accesso a dati in tempo reale — prova SEMPRE prima con web_search. Rifiutare senza aver provato lo strumento disponibile è un errore.

Altre regole: usa uno strumento alla volta, aspetta sempre l'Observation prima di continuare — non inventare mai risultati. Se hai già usato uno strumento e il risultato non ti aiuta a procedere, NON ripetere la stessa azione: passa a FINAL_ANSWER con il ragionamento migliore che hai a disposizione, anche se non perfetto. Hai al massimo ${MAX_REACT_STEPS} passi totali — arrivare a un buon FINAL_ANSWER entro il limite è sempre meglio che restare bloccato.
---`;
}

function parseReActStep(text) {
  const t = text || '';
  const thoughtMatch = t.match(/THOUGHT:\s*([\s\S]*?)(?=\n(?:ACTION|FINAL_ANSWER):|$)/i);
  const thought = thoughtMatch ? thoughtMatch[1].trim() : '';
  const finalMatch = t.match(/FINAL_ANSWER:\s*([\s\S]*)/i);
  if (finalMatch) return { thought, finalAnswer: finalMatch[1].trim() };
  const actionMatch = t.match(/ACTION:\s*([a-zA-Z_]+)/i);
  const inputMatch  = t.match(/ACTION_INPUT:\s*([\s\S]*)/i);
  if (actionMatch) return { thought, action: actionMatch[1].trim(), actionInput: inputMatch ? inputMatch[1].trim() : '' };
  // Formato non riconosciuto: trattalo come risposta finale invece di bloccare il loop
  return { thought, finalAnswer: t.trim() };
}

async function executeReActTool(name, input, ctx) {
  switch (name) {
    case 'get_current_datetime': {
      const now = new Date();
      return now.toLocaleString('it-IT', { timeZone: 'UTC', weekday:'long',year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit' }) + ' UTC';
    }
    case 'calculate': {
      try {
        const expr = (input || '').replace(/(\d+(?:[.,]\d+)?)\s*%\s*di\s*(\d+(?:[.,]\d+)?)/gi, (_,a,b) => '('+a.replace(',','.')+'/100*'+b.replace(',','.')+')').replace(/[^0-9+\-*/().,]/g,' ').trim();
        const result = Function('"use strict"; return (' + expr + ')')();
        return 'Risultato: ' + result;
      } catch { return 'Impossibile calcolare questa espressione.'; }
    }
    case 'remember':
      return 'Informazione salvata: "' + (input || '') + '"';
    case 'web_search': {
      if (!ctx.tavilyKey) return 'Ricerca web non disponibile in questo momento.';
      try { return await tavilySearch((input || '').slice(0, 150), ctx.tavilyKey); }
      catch (e) { return 'Ricerca fallita: ' + e.message; }
    }
    default:
      return 'Strumento "' + name + '" non riconosciuto.';
  }
}

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
  // NOTA 2026-08-23: mixtral-8x7b-32768 e gemma2-9b-it (deprecati, non più
  // disponibili su Groq) sostituiti con GPT-OSS 120B/20B — vedi nota sopra
  // su MULTI_MODELS per i dettagli. Questo bug faceva sì che OGNI richiesta
  // di codice fallisse su Groq (modello inesistente) e cadesse sempre sul
  // fallback OpenRouter, più lento — invisibile all'utente ma reale.
  if (/\b(scrivi|analizza|spiega.*dettagl|codice|programm|funzione|algoritmo|essay|articolo|relazione|riassunto lungo)\b/i.test(text)) return 'openai/gpt-oss-120b';
  if (/\b(perché|ragiona|confronta|differenza|vantaggio|svantaggio|pro.*contro|calcola|dimostra|argomenta)\b/i.test(text)) return 'openai/gpt-oss-20b';
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
  // referrer: metodo di autenticazione ufficiale per app web (nessuna
  // registrazione necessaria) — migliora il riconoscimento del rate limit.
  // enhance=true: un modello lato Pollinations arricchisce il prompt prima
  // della generazione, aiuta con anatomia/proporzioni.
  const seed = Math.floor(Math.random() * 1000000);
  return 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=1024&height=1024&nologo=true&model=flux&enhance=true&seed=' + seed + '&referrer=ainstain.site';
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
  (async () => {
    try {
      await fn(send);
    } catch (e) {
      // FIX: prima, se fn() falliva (es. tutti i provider AI non disponibili),
      // lo stream si chiudeva silenziosamente senza mandare nulla al client,
      // che restava con una bolla vuota senza nessun messaggio di errore.
      try { send({ type: 'error', message: e && e.message ? e.message : 'Errore imprevisto del server.' }); } catch {}
    } finally {
      w.close();
    }
  })();
  return readable;
}

// ── NUOVO: validazione Premium server-side ────────────────────────────
// Verifica il JWT firmato da api/verify-premium.js. Non ci fidiamo più
// di un flag mandato dal client: se il token manca, è scaduto o è
// firmato male, l'utente viene trattato come Free.
async function verifyPremiumToken(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !process.env.JWT_SECRET) return false;
  try {
    const secretKey = new TextEncoder().encode(process.env.JWT_SECRET);
    const { payload } = await jwtVerify(token, secretKey);
    return payload.premium === true;
  } catch {
    return false; // token assente, scaduto o manomesso
  }
}

// ── Validazione risposta ────────────────────────────────────────────
// FIX 2026-08-24: openrouter/free (usato come riserva) sceglie un modello
// gratuito A CASO tra quelli disponibili — a volte può selezionare un
// modello di moderazione/classificazione contenuti (es. tipo Llama-Guard)
// invece di un vero modello di chat. Questi modelli, se interrogati come
// un normale completamento chat, rispondono con roba tipo "Safety: safe"
// invece di una risposta vera — e l'utente vedeva quel testo assurdo al
// posto di una risposta. Questo controllo riconosce questi casi e li
// tratta come un fallimento del provider (si passa al successivo, o se
// non ce ne sono altri, si mostra un errore pulito — mai testo assurdo).
function looksLikeInvalidCompletion(text) {
  if (!text || text.trim().length < 3) return true;
  const t = text.trim();
  // Deve corrispondere all'INTERA risposta (con eventuali codici categoria
  // tipo "S1,S2" su una seconda riga, tipico di Llama-Guard), non solo
  // all'inizio — altrimenti frasi normali come "Safe travels!" o "User
  // feedback is..." scatterebbero come falsi positivi.
  if (/^(safe|unsafe)(\s*\n\s*(s\d+,?\s*)+)?$/i.test(t)) return true;
  if (/^safety\s*:\s*(safe|unsafe)\s*$/i.test(t)) return true;
  if (/^user$/i.test(t)) return true;
  return false;
}

// ── Chiamata non-streaming con fallback ───────────────────────────────
async function callWithFallback(providers, messages, maxTokens, temperature, model) {
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    // FIX BUG CRITICO: prima "model || p.model" usava lo stesso nome
    // modello per TUTTI i provider — ma ogni provider ha una propria
    // nomenclatura (es. Groq: "llama-3.3-70b-versatile", OpenRouter:
    // "meta-llama/llama-3.3-70b-instruct:free"). Quando Groq falliva e
    // scattava il fallback su OpenRouter, gli veniva chiesto un modello
    // che non esiste per lui → OpenRouter rispondeva 400, il fallback
    // falliva del tutto, e l'utente vedeva un errore 500 grezzo.
    // Ora l'override personalizzato (es. da selectBestModel) si applica
    // SOLO al provider principale (il primo, Groq); i provider di
    // riserva usano sempre il proprio nome modello corretto.
    const useModel = i === 0 ? (model || p.model) : p.model;
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) },
        body: JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, temperature, stream: false }),
      });
      if (res.status === 429 || res.status === 503) { console.log('[AI] ' + p.name + ' rate limited, next...'); continue; }
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(p.name + ' error ' + res.status + (errBody ? ' — ' + errBody.slice(0, 200) : ''));
      }
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || '';
      if (looksLikeInvalidCompletion(text)) {
        console.log('[AI] ' + p.name + ' risposta non valida (probabile modello di moderazione, non di chat): "' + text.slice(0, 80) + '" — provo il prossimo provider');
        continue;
      }
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
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    const useModel = i === 0 ? (model || p.model) : p.model; // stesso fix di callWithFallback
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + p.apiKey, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) },
        body: JSON.stringify({ model: useModel, messages, max_tokens: maxTokens, temperature, stream: true }),
      });
      if (res.status === 429 || res.status === 503) { console.log('[AI] ' + p.name + ' rate limited, next...'); continue; }
      if (!res.ok) { const e = await res.text(); if (res.status === 429) continue; throw new Error(p.name + ': ' + e); }
      console.log('[AI] streamWithFallback: using ' + p.name);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      // FIX 2026-08-24: stessa protezione di callWithFallback, applicata
      // allo streaming — accumula i primi ~20 caratteri prima di inoltrarli
      // al client, verifica che non siano l'inizio di una risposta "non di
      // chat" (es. modello di moderazione selezionato a caso da
      // openrouter/free), poi procede normalmente. Evita di mostrare
      // testo assurdo tipo "Safety: safe" all'utente. Il rilevamento usa un
      // flag (non un throw diretto) perché siamo dentro un try/catch di
      // parsing JSON che altrimenti lo ingoierebbe silenziosamente — il
      // throw vero avviene fuori da quel blocco, dove risale correttamente
      // al codice che gestisce il passaggio al provider successivo.
      let pendingText = '';
      let validated = false;
      let invalidDetected = false;
      const CHECK_THRESHOLD = 20;
      streamLoop:
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
            if (tok) {
              if (!validated) {
                pendingText += tok;
                if (pendingText.length >= CHECK_THRESHOLD) {
                  if (looksLikeInvalidCompletion(pendingText)) {
                    invalidDetected = true;
                  } else {
                    validated = true;
                    onToken(pendingText);
                    pendingText = '';
                  }
                }
              } else {
                onToken(tok);
              }
            }
            if (!invalidDetected && j.choices?.[0]?.finish_reason) {
              if (!validated && pendingText) {
                if (looksLikeInvalidCompletion(pendingText)) invalidDetected = true;
                else { onToken(pendingText); pendingText = ''; }
              }
              if (!invalidDetected) onDone(j.choices[0].finish_reason === 'length' ? 'truncated' : 'done');
            }
          } catch {}
          if (invalidDetected) break streamLoop;
        }
      }
      if (invalidDetected) {
        console.log('[AI] ' + p.name + ' streaming non valido (probabile modello di moderazione): "' + pendingText.slice(0, 80) + '" — provo il prossimo provider');
        throw new Error(p.name + ': risposta non valida (modello di moderazione)');
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
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST')  return new Response('Method not allowed', { status: 405, headers: cors });

  // ── NUOVO: chi è davvero questo utente? (verifica server-side, non fidarsi del client) ──
  const isPremiumServer = await verifyPremiumToken(req);
  const clientIp = getClientIp(req);

  // FIX: prima, se Upstash Redis aveva anche un piccolo intoppo momentaneo,
  // questi controlli non gestiti mandavano in crash l'intera funzione con
  // un errore 500 grezzo — capitava su QUALSIASI richiesta, semplice o
  // complessa, in modo imprevedibile. "Fail open": se il rate limiter
  // stesso non risponde, la richiesta passa comunque (meglio permettere
  // un abuso occasionale che bloccare tutti per un problema tecnico).

  // ── NUOVO: rate limit anti-abuso, per IP, vale per TUTTI (anche Premium) ──
  try {
    const abuseCheck = await abuseLimiter.limit(clientIp);
    if (!abuseCheck.success) {
      return new Response(JSON.stringify({ error: 'Troppe richieste in poco tempo. Rallenta un attimo.', rateLimited: true }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
  } catch (e) {
    console.log('[ratelimit] abuseLimiter non disponibile, richiesta passata comunque:', e.message);
  }

  // ── NUOVO: tetto giornaliero solo per utenti Free (i Premium non hanno questo limite) ──
  if (!isPremiumServer) {
    try {
      const freeCheck = await freeDailyLimiter.limit(clientIp);
      if (!freeCheck.success) {
        return new Response(JSON.stringify({
          error: 'Hai raggiunto il limite giornaliero di messaggi Free. Passa a Premium per continuare senza limiti.',
          rateLimited: true,
          limitReached: true,
        }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
    } catch (e) {
      console.log('[ratelimit] freeDailyLimiter non disponibile, richiesta passata comunque:', e.message);
    }
  }

  let body;
  try { body = JSON.parse(await req.text()); }
  catch(e) { return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }

  const messages    = body.messages || [];
  const model       = body.model || 'llama-3.3-70b-versatile';
  // ── NUOVO: forceWeb e multiMode sono feature Premium. Anche se il client
  // li manda, li onoriamo SOLO se isPremiumServer è vero (verificato sopra).
  const forceWeb    = isPremiumServer && body.webSearch === true;
  const agentMode   = body.agentMode === true;
  const multiMode   = isPremiumServer ? (body.multiMode || null) : null;
  const temperature = body.temperature != null ? body.temperature : 0.7;
  const maxTokens   = body.max_tokens || 4096;

  const groqKey   = process.env.GROQ_API_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!groqKey) return new Response(JSON.stringify({ error: 'GROQ_API_KEY mancante' }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });

  const providers  = getProviders(process.env);
  const userText   = getLastUserText(messages);
  const smartModel = selectBestModel(userText, model);
  const sseH       = { ...cors, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' };

  console.log('[AI] premium=' + isPremiumServer + ' agentMode=' + agentMode + ' multiMode=' + multiMode + ' smartModel=' + smartModel);

  // ══════════════════════════════════════════════════════════════════════
  // BRANCH: NON-STREAMING (risposta JSON diretta, non SSE)
  // Usato per compiti "di supporto" veloci: titolo automatico chat,
  // miglioramento prompt per generazione immagini, ecc.
  // FIX: prima questo branch non esisteva — qualsiasi richiesta con
  // stream:false riceveva comunque uno stream SSE, che il client provava
  // a leggere con res.json() fallendo silenziosamente (es. il titolo
  // automatico delle chat non ha mai funzionato per questo motivo).
  // ══════════════════════════════════════════════════════════════════════
  if (body.stream === false && !multiMode && !agentMode) {
    try {
      const result = await callWithFallback(providers, messages, maxTokens, temperature, smartModel);
      return new Response(JSON.stringify({ choices: [{ message: { content: result.text } }] }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
    }
  }

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
  // BRANCH: AGENTE (loop ReAct multi-step — max MAX_REACT_STEPS passi)
  // ══════════════════════════════════════════════════════════════════════
  if (agentMode) {
    const readable = makeSSE(async (send) => {
      const sys = messages.find(m => m.role === 'system');
      const baseSystemPrompt = sys ? sys.content : 'Sei AInstAIn, un assistente AI italiano. Rispondi SEMPRE in italiano.';
      const reactSystemPrompt = buildReActSystemPrompt(baseSystemPrompt);

      let reactMessages = [{ role: 'system', content: reactSystemPrompt }, ...messages.filter(m => m.role !== 'system')];
      let usedWeb = false;
      let finalAnswer = null;
      let lastActionSignature = null;

      for (let step = 1; step <= MAX_REACT_STEPS; step++) {
        send({ type: 'agent_step', step, max: MAX_REACT_STEPS });

        let stepText;
        try {
          const r = await callWithFallback(providers, reactMessages, 700, 0.3, model);
          stepText = r.text;
        } catch (e) {
          send({ type: 'error', message: e.message });
          return;
        }

        const parsed = parseReActStep(stepText);
        if (parsed.thought) send({ type: 'agent_thought', thought: parsed.thought, step });

        // Risposta finale: il loop termina qui
        if (parsed.finalAnswer) { finalAnswer = parsed.finalAnswer; break; }

        // Generazione immagine: termina sempre il turno (comportamento invariato rispetto a prima)
        if (parsed.action === 'generate_image') {
          send({ type: 'agent_tools', tools: ['generate_image'] });
          const imgPrompt = parsed.actionInput || userText;
          send({ type: 'agent_image', url: buildPollinationsUrl(imgPrompt + ', high quality, detailed, artistic'), prompt: imgPrompt });
          return;
        }

        if (parsed.action) {
          send({ type: 'agent_tools', tools: [parsed.action] });
          if (parsed.action === 'remember') send({ type: 'agent_saved', note: parsed.actionInput });
          if (parsed.action === 'web_search') usedWeb = true;

          const observation = await executeReActTool(parsed.action, parsed.actionInput, { tavilyKey });
          send({ type: 'agent_observation', tool: parsed.action, observation: String(observation).slice(0, 300) });

          // Guardia anti-loop: se l'azione è identica alla precedente, avvisa
          // esplicitamente invece di lasciare che l'AI la ripeta all'infinito
          // fino a esaurire tutti i passaggi disponibili.
          const actionSignature = parsed.action + '::' + parsed.actionInput;
          const isRepeat = actionSignature === lastActionSignature;
          lastActionSignature = actionSignature;

          // Aggiungi il passo (ragionamento+azione dell'assistente, poi l'osservazione)
          // alla conversazione, cosi il prossimo step del loop li vede entrambi.
          reactMessages.push({ role: 'assistant', content: stepText });
          reactMessages.push({
            role: 'user',
            content: 'OBSERVATION: ' + observation + '\n\n' + (
              isRepeat
                ? '(Hai già provato questa stessa azione con lo stesso input: non aiuta a procedere. NON ripeterla di nuovo — rispondi ORA con FINAL_ANSWER usando il tuo miglior giudizio con le informazioni che hai.)'
                : '(Continua il ragionamento. Se hai già abbastanza informazioni, rispondi con FINAL_ANSWER.)'
            )
          });
        } else {
          // Non dovrebbe succedere (parseReActStep ha sempre un fallback), ma per sicurezza:
          finalAnswer = stepText;
          break;
        }
      }

      if (!finalAnswer) {
        // FIX: prima, se si esauriva il limite di passaggi, l'utente vedeva
        // solo un messaggio di resa ("non sono arrivato a una risposta").
        // Ora, invece di arrendersi, si fa un ultimo tentativo: si chiede
        // all'AI di sintetizzare la MIGLIOR risposta possibile con tutto
        // quello che ha raccolto finora, fuori dal formato ReAct (una
        // risposta diretta è sempre meglio di nessuna risposta).
        try {
          const synthesisMessages = [
            { role: 'system', content: baseSystemPrompt + '\n\nHai ragionato più volte su questa richiesta senza arrivare a una conclusione netta. Dai ORA la tua migliore risposta possibile all\'utente, in italiano, usando tutto il ragionamento fatto finora. Non ripetere il formato THOUGHT/ACTION: scrivi direttamente la risposta finale come faresti normalmente in una chat.' },
            ...reactMessages.filter(m => m.role !== 'system')
          ];
          const synthResult = await callWithFallback(providers, synthesisMessages, maxTokens, temperature, model);
          finalAnswer = synthResult.text;
        } catch (e) {
          finalAnswer = '⚠️ Ho ragionato a lungo su questa richiesta senza arrivare a una conclusione netta. Prova a riformulare la richiesta in modo più specifico, o disattiva la modalità Agente per una risposta diretta.';
        }
      }

      send({ type: 'meta', webSearchUsed: usedWeb });
      for (let i = 0; i < finalAnswer.length; i += 4) send({ type: 'token', token: finalAnswer.slice(i, i + 4) });
      send({ type: 'done' });
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
        const today = new Date().toLocaleDateString('it-IT', { timeZone: 'UTC', day:'2-digit', month:'long', year:'numeric' });
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
