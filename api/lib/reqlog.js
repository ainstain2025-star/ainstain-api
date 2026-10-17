// api/lib/reqlog.js — registro delle richieste a /api/chat (2026-10-17)
// Usa Upstash Redis via REST (le variabili le crea l'integrazione Vercel: UPSTASH_REDIS_REST_* oppure KV_REST_API_*).
// Salva: ultime 2000 richieste (lista) + totali per giorno (richieste, token stimati). L'IP non è salvato in chiaro: solo un'impronta di 8 caratteri.
// Se Redis non risponde, non succede nulla (la chat non deve mai dipendere dal registro).
const URL_ = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOK_ = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
export const LOG_KEY = 'ainstain:reqlog';

async function sha8(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('ainstain-log:' + String(s || '')));
  return Array.from(new Uint8Array(d)).slice(0, 4).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function redisPipeline(cmds) {
  const u = URL_(), t = TOK_();
  if (!u || !t) throw new Error('Redis non configurato');
  const r = await fetch(u.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  if (!r.ok) throw new Error('Redis ' + r.status);
  return r.json();
}

export async function logRequest(e) {
  try {
    if (!URL_() || !TOK_()) return;
    const day = String(e.t || new Date().toISOString()).slice(0, 10);
    const row = { t: e.t, ms: e.ms, p: e.premium ? 1 : 0, ip: await sha8(e.ip), q: e.q, mode: e.mode, test: e.test || undefined, nav: e.nav ? 1 : undefined,
      tin: e.tin, tout: e.tout, model: e.model || undefined, prov: e.provider || undefined, st: e.status, err: e.err || undefined };
    const k = 'ainstain:tok:' + day;
    await redisPipeline([
      ['LPUSH', LOG_KEY, JSON.stringify(row)],
      ['LTRIM', LOG_KEY, '0', '1999'],
      ['HINCRBY', k, 'req', '1'], ['HINCRBY', k, 'tin', String(e.tin || 0)], ['HINCRBY', k, 'tout', String(e.tout || 0)],
      ['HINCRBY', k, e.err ? 'err' : 'ok', '1'],
      ['EXPIRE', k, String(60 * 60 * 24 * 90)],
    ]);
  } catch (err) { console.log('[reqlog] non registrata:', err && err.message); }
}
