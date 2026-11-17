export const config = { runtime: 'edge' };

// api/emergenza.js — 2026-11-17 — «Non sto bene»: avvisa i familiari di papà con Telegram + email.
// Lo chiama SOLO il tablet di papà (token Premium emesso dal codice PAPA_CODE: who = 'papa').
// Variabili Vercel:
//   TELEGRAM_BOT_TOKEN   token del bot (da @BotFather)
//   TELEGRAM_CHAT_IDS    id chat dei destinatari, separati da virgola (es. "123456789,987654321")
//   EMERGENCY_EMAIL      email dei destinatari, separate da virgola
//   RESEND_API_KEY, MAIL_FROM   già usate da account.js (con onboarding@resend.dev Resend consegna solo alla email dell'account Resend)
//   JWT_SECRET           già esistente
import { jwtVerify } from 'jose';
import { redisPipeline } from './lib/reqlog.js';

const json = (o, s, c) => new Response(JSON.stringify(o), { status: s, headers: { ...c, 'Content-Type': 'application/json' } });
const clean = (t, n) => String(t == null ? '' : t).replace(/[\u0000-\u001f<>]/g, ' ').slice(0, n);

async function tg(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN, ids = (process.env.TELEGRAM_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!tok || !ids.length) return { ok: false, why: 'telegram non configurato' };
  let okN = 0;
  for (const id of ids) {
    try {
      const r = await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: id, text, disable_notification: false }) });
      if (r.ok) okN++;
    } catch {}
  }
  return { ok: okN > 0, n: okN };
}
async function mail(subject, text) {
  const key = process.env.RESEND_API_KEY, to = (process.env.EMERGENCY_EMAIL || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!key || !to.length) return { ok: false, why: 'email non configurata' };
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.MAIL_FROM || 'AInstAIn <onboarding@resend.dev>', to, subject, text }) });
    return { ok: r.ok };
  } catch { return { ok: false }; }
}

export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);

  // solo il tablet di papà (token con who = 'papa')
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  try {
    if (!token || !process.env.JWT_SECRET) throw new Error('no token');
    const { payload } = await jwtVerify(token, new TextEncoder().encode(process.env.JWT_SECRET));
    if (payload.premium !== true || payload.who !== 'papa') throw new Error('not papa');
  } catch { return json({ error: 'Non autorizzato' }, 401, cors); }

  let body; try { body = JSON.parse(await req.text()); } catch { return json({ error: 'Invalid body' }, 400, cors); }

  // al massimo 8 avvisi all'ora (se Redis non risponde, si manda comunque: meglio un avviso in più che uno in meno)
  try {
    const k = 'ainstain:sos:' + new Date().toISOString().slice(0, 13);
    const r = await redisPipeline([['INCR', k], ['EXPIRE', k, 4000]]);
    if (Number(r && r[0] && r[0].result) > 8) return json({ error: 'Troppi avvisi', ok: false }, 429, cors);
  } catch {}

  const ora = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const city = (() => { try { return decodeURIComponent(req.headers.get('x-vercel-ip-city') || ''); } catch { return ''; } })();
  const frase = clean(body.frase, 160), glic = clean(body.glicemia, 120), prova = body.prova === true;
  const text = (prova ? '🧪 PROVA (non è un\'emergenza)\n' : '🚨 EMERGENZA — papà non sta bene\n') +
    'Ha detto: «' + frase + '»\nQuando: ' + ora + '\n' +
    (glic ? 'Ultima glicemia: ' + glic + '\n' : '') +
    (city ? 'Rete del tablet: zona di ' + city + ' (approssimata)\n' : '') +
    (prova ? '' : '👉 Chiamalo subito. Se non risponde, chiama il 112.');
  const [t, m] = await Promise.all([tg(text), mail(prova ? 'PROVA avviso papà' : '🚨 Papà non sta bene', text)]);
  return json({ ok: !!(t.ok || m.ok), telegram: !!t.ok, email: !!m.ok }, 200, cors);
}
