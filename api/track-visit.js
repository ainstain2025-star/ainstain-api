export const config = { runtime: 'edge' };

import { redis } from './lib/rateLimit.js';

// Registra una visita: incrementa un contatore totale e uno per la
// giornata odierna. Nessun dato personale salvato — solo numeri
// aggregati e anonimi (nessun IP, nessun identificativo utente).
export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });

  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await redis.incr('ainstain:visits:total');
    const dayKey = 'ainstain:visits:day:' + today;
    await redis.incr(dayKey);
    await redis.expire(dayKey, 60 * 60 * 24 * 120); // tieni 120 giorni di storico, poi si autopulisce
  } catch (e) {
    // Non deve MAI rompere l'esperienza dell'utente: se il conteggio
    // fallisce, ignoriamo silenziosamente e rispondiamo comunque 200.
    console.log('[visits] errore incremento:', e.message);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
