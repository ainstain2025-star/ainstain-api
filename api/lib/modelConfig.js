// api/lib/modelConfig.js — AGGIUNTO 2026-10-06
//
// Configurazione DINAMICA dei modelli AI di AInstAIn.
//
// Perché esiste: i nomi dei modelli (Groq ecc.) cambiano o spariscono senza
// preavviso — ad agosto 2026 e il 4 ottobre 2026 questo ha rotto la chat
// per giorni senza che nessuno se ne accorgesse. Invece di avere i nomi
// scritti nel codice in 6-7 punti diversi, i "ruoli" (modello principale,
// veloce, foto, giudice, i 3 del multi-modello) vivono in UN solo posto
// (Redis) e un controllo notturno (api/cron-models.js) li aggiorna SOLO se
// il modello nuovo supera una batteria di prove.
//
// SICUREZZA: se Redis non è raggiungibile o la configurazione salvata è
// malformata, si usa DEFAULT_CONFIG (i modelli attuali). Il sistema non può
// quindi essere peggiore di com'era prima di questo file.

export const DEFAULT_CONFIG = {
  version: 0,
  updatedAt: null,
  roles: {
    main:   'openai/gpt-oss-120b',
    fast:   'openai/gpt-oss-20b',
    vision: 'qwen/qwen3.8-27b',
    judge:  'openai/gpt-oss-20b',
    multi:  ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
  },
  // nome vecchio -> nome attuale (aggiunto automaticamente a ogni promozione)
  aliases: { 'qwen/qwen3.6-27b': 'qwen/qwen3.8-27b' },
  // per il ritorno indietro automatico: modello attivo -> modello che sostituiva
  rollback: {},
};

const KEY_CONFIG  = 'ainstain:models:config';
const KEY_REPORTS = 'ainstain:models:reports';

// ── Redis (REST di Upstash) — nessuna dipendenza esterna ────────────────
function redisEnv(env) {
  return {
    url:   env.UPSTASH_REDIS_REST_URL   || env.KV_REST_API_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN,
  };
}
export function redisConfigured(env) {
  const { url, token } = redisEnv(env);
  return !!(url && token);
}
async function redis(env, command) {
  const { url, token } = redisEnv(env);
  if (!url || !token) throw new Error('Redis non configurato');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error('Redis HTTP ' + res.status);
  const data = await res.json();
  if (data.error) throw new Error('Redis: ' + data.error);
  return data.result;
}

// ── Validazione ─────────────────────────────────────────────────────────
const isId = (s) => typeof s === 'string' && /^[\w.\-]+\/[\w.\-:]+$/.test(s);

export function validateConfig(c) {
  if (!c || typeof c !== 'object') return false;
  const r = c.roles;
  if (!r || typeof r !== 'object') return false;
  for (const k of ['main', 'fast', 'vision', 'judge']) if (!isId(r[k])) return false;
  if (!Array.isArray(r.multi) || r.multi.length < 1 || r.multi.length > 5 || !r.multi.every(isId)) return false;
  if (c.aliases && (typeof c.aliases !== 'object' || !Object.entries(c.aliases).every(([a, b]) => isId(a) && isId(b)))) return false;
  return true;
}

// Restituisce SEMPRE una configurazione utilizzabile (mai lancia).
export async function loadConfig(env) {
  try {
    const raw = await redis(env, ['GET', KEY_CONFIG]);
    if (!raw) return { config: structuredClone(DEFAULT_CONFIG), source: 'default (nessuna config salvata)' };
    const parsed = JSON.parse(raw);
    if (!validateConfig(parsed)) return { config: structuredClone(DEFAULT_CONFIG), source: 'default (config salvata non valida)' };
    return { config: { ...structuredClone(DEFAULT_CONFIG), ...parsed, aliases: { ...DEFAULT_CONFIG.aliases, ...(parsed.aliases || {}) }, rollback: parsed.rollback || {} }, source: 'redis' };
  } catch (e) {
    return { config: structuredClone(DEFAULT_CONFIG), source: 'default (' + e.message + ')' };
  }
}

export async function saveConfig(env, config) {
  if (!validateConfig(config)) throw new Error('Configurazione non valida: non salvata');
  await redis(env, ['SET', KEY_CONFIG, JSON.stringify(config)]);
}

export async function pushReport(env, report) {
  await redis(env, ['LPUSH', KEY_REPORTS, JSON.stringify(report)]);
  await redis(env, ['LTRIM', KEY_REPORTS, '0', '13']); // ultimi 14 rapporti
}
export async function loadReports(env, n = 14) {
  const rows = await redis(env, ['LRANGE', KEY_REPORTS, '0', String(n - 1)]);
  return (rows || []).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}

// ── Nomi leggibili e "famiglie" di modelli ──────────────────────────────
export function prettyName(id) {
  // 'qwen/qwen3.8-27b' -> 'Qwen 3.8 27B' ; 'openai/gpt-oss-120b' -> 'GPT-OSS 120B'
  const base = id.split('/').pop();
  if (/^gpt-oss-/i.test(base)) return 'GPT-OSS ' + base.replace(/^gpt-oss-/i, '').toUpperCase();
  const m = base.match(/^([a-z][a-z\-]*?)-?(\d+(?:\.\d+)*)?(?:-(\d+(?:\.\d+)?b))?(?:-(.+))?$/i);
  if (!m) return base;
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  return [cap(m[1]), m[2], m[3] && m[3].toUpperCase(), m[4]].filter(Boolean).join(' ');
}

// Famiglia = prefisso fino alla prima cifra ("qwen/qwen3.6-27b" -> "qwen/qwen")
export const familyOf  = (id) => id.replace(/[0-9][\s\S]*$/, '');
// Taglia = numero seguito da "b" ("27b", "120b")
export const sizeOf    = (id) => { const m = id.match(/(\d+(?:\.\d+)?)b(?![a-z])/i); return m ? m[1].toLowerCase() + 'b' : null; };
// Versione = primi numeri a punti DOPO aver tolto la taglia ("qwen3.6-27b" -> [3,6])
export function versionOf(id) {
  const size = sizeOf(id);
  const rest = (size ? id.replace(new RegExp(size.replace('.', '\\.'), 'i'), '') : id).slice(familyOf(id).length);
  const m = rest.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1].split('.').map(Number) : [];
}
export function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// Cerca il successore di un modello: stessa famiglia e stessa taglia.
//  - se il modello attuale è sparito: va bene il migliore rimasto della famiglia
//  - se esiste ancora: serve una versione STRETTAMENTE più recente (aggiornamento)
export function findSuccessor(currentId, availableIds, currentIsMissing) {
  const fam = familyOf(currentId), size = sizeOf(currentId), cur = versionOf(currentId);
  const cands = availableIds.filter(id =>
    id !== currentId && familyOf(id) === fam && sizeOf(id) === size &&
    (currentIsMissing || compareVersions(versionOf(id), cur) > 0));
  if (!cands.length) return null;
  cands.sort((x, y) => compareVersions(versionOf(y), versionOf(x)));
  return cands[0];
}

// Per ogni modello usato, decide se c'è qualcosa da provare.
//  -> { [idAttuale]: { missing: bool, successor: id|null, roles: [..] } } (solo se c'è qualcosa da dire)
export function planUpdates(config, availableIds) {
  const roleUse = {}; // id -> ruoli
  const add = (id, role) => { (roleUse[id] = roleUse[id] || []).push(role); };
  const r = config.roles;
  add(r.main, 'main'); add(r.fast, 'fast'); add(r.vision, 'vision'); add(r.judge, 'judge');
  r.multi.forEach(id => add(id, 'multi'));
  const plan = {};
  for (const [id, roles] of Object.entries(roleUse)) {
    const missing = !availableIds.includes(id);
    const successor = findSuccessor(id, availableIds, missing);
    if (missing || successor) plan[id] = { missing, successor, roles: [...new Set(roles)] };
  }
  return plan;
}

// Sostituisce 'da' con 'a' in tutti i ruoli. Restituisce una NUOVA config.
export function applyReplacement(config, from, to) {
  const c = structuredClone(config);
  for (const k of ['main', 'fast', 'vision', 'judge']) if (c.roles[k] === from) c.roles[k] = to;
  c.roles.multi = [...new Set(c.roles.multi.map(id => id === from ? to : id))];
  c.aliases = { ...(c.aliases || {}), [from]: to };
  // se 'from' era a sua volta un sostituto, gli alias già puntati a lui seguono
  for (const [old, cur] of Object.entries(c.aliases)) if (cur === from) c.aliases[old] = to;
  c.rollback = { ...(c.rollback || {}), [to]: from };
  c.version = (c.version || 0) + 1;
  c.updatedAt = new Date().toISOString();
  return c;
}
