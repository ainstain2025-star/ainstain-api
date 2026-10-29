export const config = { runtime: 'edge' };

// api/account.js — 29 ott 2026 — Account PREMIUM PLUS (checklist 2.316, 2.317, 2.318, 2.321).
// Accesso con email + codice monouso a 6 cifre (nessuna password) e archivio dei riassunti delle chat.
// NON tocca chat.js. Usa solo servizi gratuiti già presenti: Vercel, Upstash Redis (come reqlog.js) e Resend (piano gratuito) per l'email.
//
// Variabili Vercel necessarie:
//   JWT_SECRET        (già esiste, la usa verify-premium.js)
//   RESEND_API_KEY    (da creare su resend.com, piano gratuito) — senza questa non parte l'email
//   MAIL_FROM         (facoltativa; default "AInstAIn <onboarding@resend.dev>": con questo mittente Resend consegna SOLO alla tua email di registrazione, ottimo per le prove)
//   PLUS_EMAILS       (facoltativa; elenco di email Plus separate da virgola, es. "tua@email.it,altra@email.it")
//   PLUS_ALL=1        (facoltativa; SOLO per le prove: ogni account registrato è Plus)
// Azioni (POST JSON {action, ...}): login, verify, me, mem_put, mem_list, mem_del, mem_clear, export, delete_account.
import { SignJWT, jwtVerify } from 'jose';
import { redisPipeline } from './lib/reqlog.js';
import { getClientIp } from './lib/rateLimit.js';

const P = 'ainstain:acc:';
const MAX_ENTRIES = 600;       // riassunti per utente
const MAX_ENTRY_CHARS = 2200;  // dimensione massima di un riassunto
const CODE_TTL = 600;          // 10 minuti
const SESSION = '90d';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function sha(s, n) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const h = Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
  return n ? h.slice(0, n) : h;
}
const validEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
function isPlus(email) {
  if (process.env.PLUS_ALL === '1') return true;
  const l = (process.env.PLUS_EMAILS || '').toLowerCase().split(/[,;\s]+/).filter(Boolean);
  return l.includes(email);
}
async function counter(key, ttl) {
  const r = await redisPipeline([['INCR', key]]);
  const n = Number(r && r[0] && r[0].result) || 0;
  if (n === 1) await redisPipeline([['EXPIRE', key, String(ttl)]]);
  return n;
}
function randomCode() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, '0');
}
async function sendMail(to, code) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'Invio email non configurato (manca RESEND_API_KEY su Vercel).' };
  const from = process.env.MAIL_FROM || 'AInstAIn <onboarding@resend.dev>';
  const html = '<div style="font-family:system-ui,sans-serif;max-width:480px"><h2>Il tuo codice di accesso</h2><p style="font-size:32px;letter-spacing:6px;font-weight:700">' + code +
    '</p><p>Scade tra 10 minuti. Se non l\'hai richiesto tu, ignora questa email.</p><p style="color:#666;font-size:13px">AInstAIn · https://ainstain.site</p></div>';
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: 'Il tuo codice di accesso AInstAIn: ' + code, html, text: 'Il tuo codice di accesso AInstAIn: ' + code + ' (scade tra 10 minuti).' }) });
    if (!r.ok) { let t = ''; try { t = (await r.text()).slice(0, 200); } catch {} return { ok: false, error: 'Invio email non riuscito (' + r.status + '). ' + t }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: 'Invio email non riuscito: ' + e.message }; }
}
async function sign(payload) {
  return await new SignJWT(payload).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime(SESSION).sign(new TextEncoder().encode(process.env.JWT_SECRET));
}
async function auth(req) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t || !process.env.JWT_SECRET) return null;
  try {
    const { payload } = await jwtVerify(t, new TextEncoder().encode(process.env.JWT_SECRET));
    if (!payload.acc || !payload.eh || !payload.email) return null;
    return { eh: String(payload.eh), email: String(payload.email) };
  } catch { return null; }
}
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const id = String(e.id || '').slice(0, 40); if (!/^[A-Za-z0-9_-]{3,40}$/.test(id)) return null;
  const out = { id, t: String(e.t || '').slice(0, 120), d: Number(e.d) || Date.now(), u: Number(e.u) || Date.now(),
    k: Array.isArray(e.k) ? e.k.slice(0, 24).map(x => String(x).slice(0, 30)) : [], s: String(e.s || '').slice(0, MAX_ENTRY_CHARS) };
  return out;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!process.env.JWT_SECRET) return json({ error: 'Configurazione server incompleta' }, 500);
  let b; try { b = JSON.parse(await req.text()); } catch { return json({ error: 'Richiesta non valida' }, 400); }
  const action = String(b.action || '');
  const ip = getClientIp(req);

  try {
    // ── Richiesta del codice ──
    if (action === 'login') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!validEmail(email)) return json({ error: 'Email non valida' }, 400);
      const eh = await sha(email, 32);
      const nIp = await counter(P + 'rl:ip:' + (await sha(ip, 12)), 3600);
      const nEm = await counter(P + 'rl:em:' + eh, 3600);
      if (nIp > 12 || nEm > 5) return json({ error: 'Troppe richieste. Riprova tra un\'ora.' }, 429);
      const code = randomCode();
      const h = await sha(code + ':' + eh + ':' + process.env.JWT_SECRET);
      await redisPipeline([['SET', P + 'code:' + eh, JSON.stringify({ h, tries: 0 }), 'EX', String(CODE_TTL)]]);
      const m = await sendMail(email, code);
      if (!m.ok) { await redisPipeline([['DEL', P + 'code:' + eh]]); return json({ error: m.error }, 502); }
      return json({ ok: true, ttl: CODE_TTL });
    }
    // ── Verifica del codice ──
    if (action === 'verify') {
      const email = String(b.email || '').trim().toLowerCase();
      const code = String(b.code || '').replace(/\D/g, '');
      if (!validEmail(email) || code.length !== 6) return json({ error: 'Codice non valido' }, 400);
      const eh = await sha(email, 32);
      const r = await redisPipeline([['GET', P + 'code:' + eh]]);
      const raw = r && r[0] && r[0].result;
      if (!raw) return json({ error: 'Codice scaduto o non richiesto. Richiedine uno nuovo.' }, 401);
      const d = JSON.parse(raw);
      if (d.tries >= 5) { await redisPipeline([['DEL', P + 'code:' + eh]]); return json({ error: 'Troppi tentativi. Richiedi un nuovo codice.' }, 429); }
      const h = await sha(code + ':' + eh + ':' + process.env.JWT_SECRET);
      if (h !== d.h) {
        d.tries++;
        await redisPipeline([['SET', P + 'code:' + eh, JSON.stringify(d), 'EX', String(CODE_TTL)]]);
        return json({ error: 'Codice errato' }, 401);
      }
      await redisPipeline([['DEL', P + 'code:' + eh], ['HSETNX', P + 'user:' + eh, 'email', email], ['HSETNX', P + 'user:' + eh, 'created', String(Date.now())]]);
      const token = await sign({ acc: true, eh, email });
      return json({ token, email, plus: isPlus(email) });
    }

    // ── Da qui serve l'accesso ──
    const u = await auth(req);
    if (!u) return json({ error: 'Accesso scaduto: rientra con la tua email.', auth: false }, 401);
    const plus = isPlus(u.email);
    const MEM = P + 'mem:' + u.eh;

    if (action === 'me') return json({ email: u.email, plus });

    if (action === 'delete_account') {
      await redisPipeline([['DEL', MEM], ['DEL', P + 'user:' + u.eh], ['DEL', P + 'code:' + u.eh]]);
      return json({ ok: true });
    }
    if (action === 'export') {
      const r = await redisPipeline([['HGETALL', MEM], ['HGETALL', P + 'user:' + u.eh]]);
      const flat = (r[0] && r[0].result) || [], rows = [];
      for (let i = 1; i < flat.length; i += 2) { try { rows.push(JSON.parse(flat[i])); } catch {} }
      return json({ email: u.email, plus, riassunti: rows });
    }

    // ── Archivio riassunti: solo Plus ──
    if (!plus) return json({ error: 'Funzione riservata a Premium Plus', plus: false }, 403);

    if (action === 'mem_put') {
      const arr = (Array.isArray(b.entries) ? b.entries : []).slice(0, 100).map(cleanEntry).filter(Boolean);
      if (!arr.length) return json({ ok: true, saved: 0 });
      const n = await redisPipeline([['HLEN', MEM]]);
      const have = Number(n && n[0] && n[0].result) || 0;
      if (have >= MAX_ENTRIES + arr.length) return json({ error: 'Archivio pieno: elimina qualche ricordo.' }, 413);
      const cmd = ['HSET', MEM];
      for (const e of arr) { cmd.push(e.id, JSON.stringify(e)); }
      await redisPipeline([cmd]);
      return json({ ok: true, saved: arr.length });
    }
    if (action === 'mem_list') {
      const r = await redisPipeline([['HGETALL', MEM]]);
      const flat = (r[0] && r[0].result) || [], rows = [];
      for (let i = 1; i < flat.length; i += 2) { try { rows.push(JSON.parse(flat[i])); } catch {} }
      rows.sort((a, b) => (b.u || 0) - (a.u || 0));
      return json({ entries: rows.slice(0, MAX_ENTRIES) });
    }
    if (action === 'mem_del') {
      const id = String(b.id || '').slice(0, 40);
      if (id) await redisPipeline([['HDEL', MEM, id]]);
      return json({ ok: true });
    }
    if (action === 'mem_clear') { await redisPipeline([['DEL', MEM]]); return json({ ok: true }); }

    return json({ error: 'Azione sconosciuta' }, 400);
  } catch (e) {
    return json({ error: 'Servizio non disponibile: ' + (e && e.message || e) }, 503);
  }
}
