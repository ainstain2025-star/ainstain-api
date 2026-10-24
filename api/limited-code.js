export const config = { runtime: 'edge' };

// api/limited-code.js — 2026-10-24. Pagina RISERVATA di VinDimax per creare e revocare i codici personali PREMIUM_LIMITED.
//   Crea:   /api/limited-code?key=VISITS_ADMIN_KEY&email=nome@esempio.it&days=30
//   Revoca: /api/limited-code?key=VISITS_ADMIN_KEY&revoke=AIA-XXXX-XXXX
//   Elenco: /api/limited-code?key=VISITS_ADMIN_KEY&list=1
// L'email è salvata su Redis insieme al codice (serve per sapere a chi lo hai dato) e sparisce da sola alla scadenza.
import { redisPipeline } from './lib/reqlog.js';

const LCODE_PREFIX = 'ainstain:lcode:';
const INDEX_KEY = 'ainstain:lcode:index';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza 0/O/1/I per evitare errori di battitura

function randomPart(n) {
  const a = new Uint8Array(n); crypto.getRandomValues(a);
  return Array.from(a, b => ALPHABET[b % ALPHABET.length]).join('');
}
function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default async function handler(req) {
  const url = new URL(req.url);
  const adminKey = process.env.VISITS_ADMIN_KEY;
  if (!adminKey || url.searchParams.get('key') !== adminKey) return json({ error: 'Non autorizzato' }, 401);

  const revoke = (url.searchParams.get('revoke') || '').trim().toUpperCase();
  if (revoke) {
    await redisPipeline([['DEL', LCODE_PREFIX + revoke], ['HDEL', INDEX_KEY, revoke]]);
    return json({ revocato: revoke });
  }

  if (url.searchParams.get('list')) {
    const r = await redisPipeline([['HGETALL', INDEX_KEY]]);
    const flat = (r && r[0] && r[0].result) || [];
    const rows = [];
    for (let i = 0; i < flat.length; i += 2) {
      try { const d = JSON.parse(flat[i + 1]); rows.push({ codice: flat[i], email: d.email, scade: new Date(d.exp).toISOString(), scaduto: d.exp < Date.now() }); } catch {}
    }
    return json({ totale: rows.length, codici: rows });
  }

  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Serve una email valida: &email=nome@esempio.it' }, 400);
  const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 90);
  const exp = Date.now() + days * 86400000;
  const code = 'AIA-' + randomPart(4) + '-' + randomPart(4);
  const val = JSON.stringify({ email, exp });
  await redisPipeline([
    ['SET', LCODE_PREFIX + code, val, 'EX', days * 86400 + 3600],
    ['HSET', INDEX_KEY, code, val],
  ]);
  return json({ codice: code, email, giorni: days, scade: new Date(exp).toISOString(),
    testo_email: 'Ciao! Ecco il tuo accesso gratuito a AInstAIn Premium per ' + days + ' giorni: vai su https://ainstain.site, clicca su Premium e inserisci il codice ' + code + '. Il codice è personale e scade il ' + new Date(exp).toLocaleDateString('it-IT') + '. Grazie per il tuo tempo!' });
}
