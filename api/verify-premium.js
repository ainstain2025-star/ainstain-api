export const config = { runtime: 'edge' };

import { SignJWT } from 'jose';
import { premiumAttemptLimiter, getClientIp } from './lib/rateLimit.js';
import { redisPipeline } from './lib/reqlog.js';

// Durata del token Premium: 180 giorni. Dopo la scadenza il frontend
// mostrerà di nuovo il modale del codice (l'utente lo reinserisce una volta).
const TOKEN_TTL = '180d';

// 2026-10-24: livello PREMIUM_LIMITED (tutte le opzioni Premium ma con tetti, applicati da chat.js).
// 1) Codici pubblici a tempo (come HALLOWEEN26). Orari in UTC: 31 ott 00:00 ora italiana = 30 ott 23:00 UTC;
//    fine 2 nov 24:00 ora italiana = 2 nov 23:00 UTC. Per aggiungerne altri senza toccare il codice:
//    variabile Vercel LIMITED_PUBLIC = "CODICE|2026-10-30T23:00:00Z|2026-11-02T23:00:00Z;ALTRO|...|..."
const LIMITED_PUBLIC_DEFAULT = [
  { code: 'HALLOWEEN26', from: '2026-10-30T23:00:00Z', to: '2026-11-02T23:00:00Z' },
];
function limitedPublicList(env) {
  const list = LIMITED_PUBLIC_DEFAULT.slice();
  const raw = (env.LIMITED_PUBLIC || '').trim();
  if (raw) {
    for (const part of raw.split(';')) {
      const [code, from, to] = part.split('|').map(x => (x || '').trim());
      if (code && from && to) list.push({ code: code.toUpperCase(), from, to });
    }
  }
  return list;
}
// 2) Codici personali (uno per email, 30 giorni): salvati su Redis da api/limited-code.js con scadenza.
const LCODE_PREFIX = 'ainstain:lcode:';

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

async function signToken(jwtSecret, payload, expiration) {
  const secretKey = new TextEncoder().encode(jwtSecret);
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(secretKey);
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

  // Protezione anti brute-force: max 5 tentativi ogni 10 minuti per IP.
  const ip = getClientIp(req);
  const { success } = await premiumAttemptLimiter.limit(ip);
  if (!success) return json({ error: 'Troppi tentativi. Riprova più tardi.' }, 429, cors);

  let body;
  try { body = JSON.parse(await req.text()); }
  catch { return json({ error: 'Invalid body' }, 400, cors); }

  const code = (body.code || '').trim();
  const premiumSecret = process.env.PREMIUM_SECRET;
  const jwtSecret = process.env.JWT_SECRET;

  if (!premiumSecret || !jwtSecret) return json({ error: 'Configurazione server incompleta' }, 500, cors);

  // ── Premium pieno (invariato) ──
  if (code && code === premiumSecret) {
    const token = await signToken(jwtSecret, { premium: true }, TOKEN_TTL);
    return json({ token }, 200, cors);
  }

  const up = code.toUpperCase();
  if (up) {
    const now = Date.now();

    // ── PREMIUM_LIMITED: codice pubblico a tempo ──
    const pub = limitedPublicList(process.env).find(c => c.code === up);
    if (pub) {
      const from = Date.parse(pub.from), to = Date.parse(pub.to);
      if (now < from) return json({ error: 'Questo codice non è ancora attivo.' }, 401, cors);
      if (now >= to)  return json({ error: 'Questo codice è scaduto.' }, 401, cors);
      const token = await signToken(jwtSecret, { premium: true, tier: 'limited' }, Math.floor(to / 1000));
      return json({ token, tier: 'limited', expires: new Date(to).toISOString() }, 200, cors);
    }

    // ── PREMIUM_LIMITED: codice personale (una email = un codice) ──
    if (/^[A-Z0-9-]{6,32}$/.test(up)) {
      try {
        const r = await redisPipeline([['GET', LCODE_PREFIX + up]]);
        const val = r && r[0] && r[0].result;
        if (val) {
          const d = JSON.parse(val);
          if (d && d.exp > now) {
            const token = await signToken(jwtSecret, { premium: true, tier: 'limited' }, Math.floor(d.exp / 1000));
            return json({ token, tier: 'limited', expires: new Date(d.exp).toISOString() }, 200, cors);
          }
        }
      } catch (e) { console.log('[premium] Redis non disponibile per il codice personale:', e.message); }
    }
  }

  return json({ error: 'Codice non valido' }, 401, cors);
}
