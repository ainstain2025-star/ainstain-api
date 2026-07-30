export const config = { runtime: 'edge' };

import { redis } from './lib/rateLimit.js';

// Endpoint di sola consultazione, protetto da una chiave segreta
// (env var VISITS_ADMIN_KEY). Non è collegato a nessun pulsante o
// pagina del sito: per vederlo devi visitare direttamente l'URL con
// la chiave giusta, es:
// https://ainstain-api.vercel.app/api/visits?key=LA_TUA_CHIAVE
export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });

  const url = new URL(req.url);
  const key = url.searchParams.get('key');
  if (!process.env.VISITS_ADMIN_KEY || key !== process.env.VISITS_ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'Non autorizzato' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  try {
    const total = (await redis.get('ainstain:visits:total')) || 0;

    // Ultimi 7 giorni, giorno per giorno
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      const count = (await redis.get('ainstain:visits:day:' + dateStr)) || 0;
      days.push({ date: dateStr, visits: Number(count) });
    }

    return new Response(JSON.stringify({ total: Number(total), last7days: days }, null, 2), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
}
