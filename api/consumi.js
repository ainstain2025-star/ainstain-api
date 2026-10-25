// api/consumi.js — monitor dei consumi giorno per giorno (solo per il proprietario) — 2026-10-25
// /api/consumi?key=VISITS_ADMIN_KEY                    → pagina del giorno di oggi (giorno UTC)
// /api/consumi?key=...&day=2026-10-25                  → pagina di un altro giorno
// /api/consumi?key=...&day=2026-10-25&format=json      → gli stessi dati in JSON
// Legge SOLO il registro già esistente (lib/reqlog.js): non tocca chat.js. Token = stima (caratteri ÷ 3,6), come nel registro.
// Il giorno è UTC come quello di Groq e Cloudflare: i loro tetti si azzerano a mezzanotte UTC (01:00 o 02:00 in Italia).
import { redisPipeline, LOG_KEY } from './lib/reqlog.js';
export const config = { runtime: 'edge' };

// Tetti dei piani gratuiti (verificati il 25/10/2026, vedi Allegato 1). Si cambiano qui.
const LIM = {
  groqTokPerModel: 200000,        // token al giorno per ciascun modello Groq
  groqReqPerModel: 1000,          // richieste al giorno per modello
  cfNeuron: 10000,                // neuron al giorno Cloudflare Workers AI
  orReq: 50,                      // richieste al giorno OpenRouter (modelli :free)
};
const CF_IN = 31818 / 1e6, CF_OUT = 68182 / 1e6; // neuron per token, GPT-OSS 120B

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n0 = v => Number(v || 0).toLocaleString('it-IT');
const ora = t => { try { return new Date(t).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { return String(t || '').slice(11, 19); } };

export default async function handler(req) {
  const u = new URL(req.url);
  const admin = process.env.VISITS_ADMIN_KEY || '';
  const key = u.searchParams.get('key') || '';
  if (!admin || key !== admin) return new Response('Non autorizzato', { status: 401 });

  const today = new Date().toISOString().slice(0, 10);
  let day = u.searchParams.get('day') || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = today;

  let out;
  try { out = await redisPipeline([['LRANGE', LOG_KEY, '0', '1999'], ['HGETALL', 'ainstain:tok:' + day]]); }
  catch (e) { return new Response('Registro non disponibile: ' + e.message, { status: 500 }); }

  const all = (out[0].result || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  const rows = all.filter(r => String(r.t || '').slice(0, 10) === day).sort((a, b) => String(a.t).localeCompare(String(b.t)));
  const oldest = all.length ? String(all[all.length - 1].t || '').slice(0, 10) : '';
  const truncated = all.length >= 2000 && oldest > day; // il registro tiene solo le ultime 2000 richieste

  // Totali del giorno (contatori di Redis, completi anche oltre le 2000 righe)
  const a = out[1].result || [], h = {}; for (let j = 0; j < a.length; j += 2) h[a[j]] = parseInt(a[j + 1], 10);

  // Per entità e modello
  const ent = {};
  const add = (nome, r) => {
    const e = ent[nome] || (ent[nome] = { nome, req: 0, tin: 0, tout: 0, err: 0 });
    e.req++; e.tin += r.tin || 0; e.tout += r.tout || 0; if (r.err) e.err++;
  };
  for (const r of rows) {
    const nome = r.prov ? r.prov + (r.model ? ' · ' + String(r.model).replace(/^@cf\//, '').replace(/^openai\//, '') : '') : (r.nav ? 'Risposta rapida (nessun modello)' : 'Nessun modello (errore o servizio)');
    r._ent = nome; add(nome, r);
  }
  const lista = Object.values(ent).sort((x, y) => (y.tin + y.tout) - (x.tin + x.tout));
  const sum = lista.reduce((s, e) => ({ req: s.req + e.req, tin: s.tin + e.tin, tout: s.tout + e.tout }), { req: 0, tin: 0, tout: 0 });

  // Confronto con i tetti
  const tetti = [];
  for (const e of lista) {
    const tot = e.tin + e.tout;
    if (/^Groq/.test(e.nome)) tetti.push({ nome: e.nome, usato: tot, limite: LIM.groqTokPerModel, unita: 'token', req: e.req, reqLim: LIM.groqReqPerModel });
    else if (/^Cloudflare/.test(e.nome)) tetti.push({ nome: e.nome, usato: Math.round(e.tin * CF_IN + e.tout * CF_OUT), limite: LIM.cfNeuron, unita: 'neuron (stima)', req: e.req });
    else if (/^OpenRouter/.test(e.nome)) tetti.push({ nome: e.nome, usato: e.req, limite: LIM.orReq, unita: 'richieste', req: e.req });
  }

  const dayNum = new Date(day + 'T00:00:00Z').getTime();
  const iso = d => new Date(d).toISOString().slice(0, 10);
  const prev = iso(dayNum - 86400000), next = iso(dayNum + 86400000);

  if (u.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ day, nota: 'token stimati (caratteri/3,6)', totali: { richieste: h.req || 0, token_in: h.tin || 0, token_out: h.tout || 0, errori: h.err || 0 }, entita: lista, tetti, righe: rows }, null, 1), { headers: { 'Content-Type': 'application/json' } });
  }

  const pct = t => Math.min(100, Math.round(100 * t.usato / t.limite));
  const cls = p => p >= 100 ? 'r' : p >= 70 ? 'a' : 'v';
  const k = base => '/api/consumi?key=' + encodeURIComponent(key) + '&day=' + base;

  const html = '<!doctype html><html lang="it"><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Monitor consumi AInstAIn</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:16px;color:#1c2333;background:#fbfbf8}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px}small,.m{color:#5a6478}' +
    'nav{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}nav a,nav button{padding:6px 12px;border:1px solid #c5cbd8;border-radius:8px;background:#fff;color:#14213d;text-decoration:none;font:inherit;cursor:pointer}' +
    'table{border-collapse:collapse;width:100%;background:#fff}td,th{border-bottom:1px solid #e1e4ec;padding:6px 8px;text-align:left;vertical-align:top}th{background:#14213d;color:#fff;font-weight:600;position:sticky;top:0}td.n,th.n{text-align:right;white-space:nowrap}' +
    '.bar{height:10px;background:#e8ebf2;border-radius:5px;overflow:hidden;min-width:120px}.bar i{display:block;height:100%}.v i{background:#2e8b57}.a i{background:#e0a21a}.r i{background:#c0392b}' +
    '.e{color:#b00020}.p{color:#0a7;font-weight:600}.box{background:#fff;border:1px solid #e1e4ec;border-radius:10px;padding:10px 14px;margin:8px 0}.w{background:#fff6e0;border-color:#e0a21a}' +
    '@media(max-width:700px){td,th{padding:4px}.hide{display:none}}</style>' +
    '<h1>Monitor consumi AInstAIn</h1><small>Giorno UTC ' + esc(day) + ' (da mezzanotte UTC, cioè 01:00 o 02:00 in Italia; i tetti di Groq e Cloudflare si azzerano a quell\'ora). Token = stima (caratteri ÷ 3,6): non contano il ragionamento nascosto dei modelli, né le chiamate multiple di Multi-AI e Agente, né i risultati web. I consumi reali sono più alti.</small>' +
    '<nav><a href="' + k(prev) + '">← ' + prev + '</a><a href="' + k(today) + '">Oggi</a>' + (next <= today ? '<a href="' + k(next) + '">' + next + ' →</a>' : '') +
    '<select id="fe" onchange="f()"><option value="">Tutte le entità</option>' + lista.map(e => '<option>' + esc(e.nome) + '</option>').join('') + '</select><span class="m">' + rows.length + ' richieste mostrate</span></nav>' +
    (truncated ? '<div class="box w">Il registro conserva solo le ultime 2.000 richieste: per questo giorno l\'elenco è incompleto. I totali qui sotto vengono dai contatori giornalieri.</div>' : '') +
    '<div class="box"><b>Totali del giorno:</b> ' + n0(h.req || rows.length) + ' richieste (' + n0(h.err || 0) + ' con errore) · token in ' + n0(h.tin != null ? h.tin : sum.tin) + ' · token out ' + n0(h.tout != null ? h.tout : sum.tout) + '</div>' +
    '<h2>Consumo contro i tetti dei piani gratuiti</h2>' +
    (tetti.length ? '<table><tr><th>Entità</th><th class="n">Usato</th><th class="n">Tetto</th><th>Percentuale</th></tr>' + tetti.map(t => { const p = pct(t); return '<tr><td>' + esc(t.nome) + '</td><td class="n">' + n0(t.usato) + ' ' + esc(t.unita) + '</td><td class="n">' + n0(t.limite) + '</td><td><div class="bar ' + cls(p) + '"><i style="width:' + p + '%"></i></div> <small>' + p + '%</small></td></tr>'; }).join('') + '</table>' : '<div class="box m">Nessun consumo di modelli registrato in questo giorno.</div>') +
    '<small>Non registrati ancora: Tavily, Serper, Upstash e Vercel (servono modifiche a chat.js: fase 2). Tetti: Groq ' + n0(LIM.groqTokPerModel) + ' token e ' + n0(LIM.groqReqPerModel) + ' richieste per modello al giorno; Cloudflare ' + n0(LIM.cfNeuron) + ' neuron; OpenRouter ' + LIM.orReq + ' richieste.</small>' +
    '<h2>Per entità</h2><table><tr><th>Entità (provider · modello)</th><th class="n">Richieste</th><th class="n">Errori</th><th class="n">Token in</th><th class="n">Token out</th><th class="n">Totale</th></tr>' +
    lista.map(e => '<tr><td>' + esc(e.nome) + '</td><td class="n">' + n0(e.req) + '</td><td class="n ' + (e.err ? 'e' : '') + '">' + n0(e.err) + '</td><td class="n">' + n0(e.tin) + '</td><td class="n">' + n0(e.tout) + '</td><td class="n"><b>' + n0(e.tin + e.tout) + '</b></td></tr>').join('') + '</table>' +
    '<h2>Richieste del giorno</h2><table id="t"><tr><th>Ora (Italia)</th><th class="hide">Utente</th><th>Testo del prompt</th><th>Entità coinvolta</th><th class="n">Token in</th><th class="n">Token out</th><th class="n">Totale</th><th class="hide">Esito</th></tr>' +
    rows.map(r => '<tr data-e="' + esc(r._ent) + '"><td>' + esc(ora(r.t)) + '</td><td class="hide">' + (r.p ? '<span class="p">Premium</span>' : 'Free') + ' <small>' + esc(r.ip) + '</small></td><td>' + esc(r.q) + (r.mode && r.mode !== 'chat' ? ' <small>[' + esc(r.mode) + ']</small>' : '') + (r.test ? ' <small>[test ' + esc(r.test) + ']</small>' : '') + '</td><td>' + esc(r._ent) + '</td><td class="n">' + n0(r.tin) + '</td><td class="n">' + n0(r.tout) + '</td><td class="n"><b>' + n0((r.tin || 0) + (r.tout || 0)) + '</b></td><td class="hide ' + (r.err ? 'e' : '') + '">' + esc(r.err || 'ok') + '</td></tr>').join('') + '</table>' +
    '<script>function f(){var v=document.getElementById("fe").value,r=document.querySelectorAll("#t tr[data-e]");for(var i=0;i<r.length;i++)r[i].style.display=(!v||r[i].getAttribute("data-e")===v)?"":"none"}</script></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
