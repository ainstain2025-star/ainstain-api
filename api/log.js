// api/log.js — consultazione del registro richieste (solo per il proprietario, stessa chiave delle visite)
// /api/log?key=VISITS_ADMIN_KEY            → pagina leggibile (ultime 100 richieste + totali 14 giorni)
// /api/log?key=...&format=json&n=300       → JSON
import { redisPipeline, LOG_KEY } from './lib/reqlog.js';
export const config = { runtime: 'edge' };

export default async function handler(req) {
  const u = new URL(req.url);
  const key = u.searchParams.get('key') || '';
  const admin = process.env.VISITS_ADMIN_KEY || '';
  if (!admin || key !== admin) return new Response('Non autorizzato', { status: 401 });
  const n = Math.max(1, Math.min(500, parseInt(u.searchParams.get('n') || '100', 10) || 100));
  const days = [];
  for (let i = 0; i < 14; i++) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  let out;
  try { out = await redisPipeline([['LRANGE', LOG_KEY, '0', String(n - 1)], ...days.map(d => ['HGETALL', 'ainstain:tok:' + d])]); }
  catch (e) { return new Response('Registro non disponibile: ' + e.message, { status: 500 }); }
  const rows = (out[0].result || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const tot = days.map((d, i) => { const a = out[i + 1].result || [], o = {}; for (let j = 0; j < a.length; j += 2) o[a[j]] = parseInt(a[j + 1], 10); return { date: d, req: o.req || 0, ok: o.ok || 0, err: o.err || 0, tin: o.tin || 0, tout: o.tout || 0, tok_per_req: o.req ? Math.round(((o.tin || 0) + (o.tout || 0)) / o.req) : 0 }; });
  if (u.searchParams.get('format') === 'json') return new Response(JSON.stringify({ note: 'token stimati (caratteri/3,6)', totals: tot, last: rows }, null, 1), { headers: { 'Content-Type': 'application/json' } });
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const k = v => v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : String(v);
  const html = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Registro richieste</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;width:100%;margin:10px 0 24px}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}th{background:#f4f4f4}.e{color:#b00020}.p{color:#0a7}small{color:#666}</style>' +
    '<h2>Registro richieste AInstAIn</h2><small>Token = stima (caratteri ÷ 3,6). L\'IP è solo un\'impronta di 8 caratteri. Ultimi ' + rows.length + ' messaggi.</small>' +
    '<h3>Totali per giorno</h3><table><tr><th>Giorno</th><th>Richieste</th><th>Errori</th><th>Token in</th><th>Token out</th><th>Token/richiesta</th></tr>' +
    tot.map(t => '<tr><td>' + t.date + '</td><td>' + t.req + '</td><td class="' + (t.err ? 'e' : '') + '">' + t.err + '</td><td>' + k(t.tin) + '</td><td>' + k(t.tout) + '</td><td>' + k(t.tok_per_req) + '</td></tr>').join('') + '</table>' +
    '<h3>Ultime richieste</h3><table><tr><th>Ora (UTC)</th><th>Utente</th><th>Domanda</th><th>Modo</th><th>Token in/out</th><th>Sec</th><th>Modello</th><th>Esito</th></tr>' +
    rows.map(r => '<tr><td>' + esc(String(r.t || '').slice(5, 19).replace('T', ' ')) + '</td><td>' + (r.p ? '<span class="p">Premium</span>' : 'Free') + ' <small>' + esc(r.ip) + '</small></td><td>' + esc(r.q) + (r.test ? ' <small>[test ' + esc(r.test) + ']</small>' : '') + '</td><td>' + esc(r.mode) + (r.nav ? ' ⚡' : '') + '</td><td>' + k(r.tin || 0) + ' / ' + k(r.tout || 0) + '</td><td>' + Math.round((r.ms || 0) / 1000) + '</td><td><small>' + esc(r.model || '') + '</small></td><td class="' + (r.err ? 'e' : '') + '">' + esc(r.err || 'ok') + '</td></tr>').join('') + '</table>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
