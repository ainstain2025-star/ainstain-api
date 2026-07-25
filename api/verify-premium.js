export const config = { runtime: 'edge' };

import { SignJWT } from 'jose';
import { premiumAttemptLimiter, getClientIp } from '../lib/rateLimit.js';

// Durata del token Premium: 180 giorni. Dopo la scadenza il frontend
// mostrerà di nuovo il modale del codice (l'utente lo reinserisce una volta).
const TOKEN_TTL = '180d';

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Protezione anti brute-force: max 5 tentativi ogni 10 minuti per IP.
  const ip = getClientIp(req);
  const { success } = await premiumAttemptLimiter.limit(ip);
  if (!success) {
    return new Response(JSON.stringify({ error: 'Troppi tentativi. Riprova più tardi.' }), {
      status: 429, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  let body;
  try { body = JSON.parse(await req.text()); }
  catch { return new Response(JSON.stringify({ error: 'Invalid body' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } }); }

  const code = (body.code || '').trim();
  const premiumSecret = process.env.PREMIUM_SECRET;
  const jwtSecret = process.env.JWT_SECRET;

  if (!premiumSecret || !jwtSecret) {
    return new Response(JSON.stringify({ error: 'Configurazione server incompleta' }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  if (!code || code !== premiumSecret) {
    return new Response(JSON.stringify({ error: 'Codice non valido' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  // Codice corretto: firma un JWT che il frontend userà come Bearer token.
  const secretKey = new TextEncoder().encode(jwtSecret);
  const token = await new SignJWT({ premium: true })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secretKey);

  return new Response(JSON.stringify({ token }), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
