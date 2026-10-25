// api/provtest.js — prova dal vivo di ogni motore AI collegato (solo per il proprietario) — 2026-10-25
// /api/provtest?key=VISITS_ADMIN_KEY            → pagina con una riga per motore
// /api/provtest?key=...&format=json             → gli stessi dati in JSON
// Manda a ogni motore UNA domanda cortissima ("rispondi solo: ok") e riporta esito, tempo e risposta.
// Costo: pochi token per motore, dal piano gratuito. Non tocca chat.js e non salva nulla.
// Le chiavi restano su Vercel: la pagina NON le mostra mai. I nomi dei modelli sono gli stessi di chat.js
// (compresi gli override SAMBANOVA_MODEL, MISTRAL_MODEL, GEMINI_MODEL, CLOUDFLARE_MODEL).
export const config = { runtime: 'edge' };

const LIST = [
  { name: 'Groq',       url: 'https://api.groq.com/openai/v1/chat/completions',  model: 'openai/gpt-oss-120b', keyEnv: 'GROQ_API_KEY' },
  { name: 'Cloudflare', url: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/ai/v1/chat/completions', model: '@cf/openai/gpt-oss-120b', keyEnv: 'CLOUDFLARE_API_TOKEN', needEnv: 'CLOUDFLARE_ACCOUNT_ID' },
  { name: 'SambaNova',  url: 'https://api.sambanova.ai/v1/chat/completions',     model: 'DeepSeek-V3.1',       keyEnv: 'SAMBANOVA_API_KEY' },
  { name: 'Mistral',    url: 'https://api.mistral.ai/v1/chat/completions',       model: 'mistral-small-latest', keyEnv: 'MISTRAL_API_KEY' },
  { name: 'Gemini',     url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY' },
  { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions',    model: 'openrouter/free',     keyEnv: 'OPENROUTER_API_KEY', extraHeaders: { 'HTTP-Referer': 'https://ainstain.site', 'X-Title': 'AInstAIn' } },
];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function provaUno(p, env) {
  const apiKey = env[p.keyEnv];
  if (!apiKey || (p.needEnv && !env[p.needEnv])) return { name: p.name, stato: 'SPENTO', dettaglio: 'chiave non presente su Vercel (' + p.keyEnv + (p.needEnv ? ' + ' + p.needEnv : '') + ')' };
  const model = (p.name !== 'Groq' && env[p.name.toUpperCase() + '_MODEL']) ? env[p.name.toUpperCase() + '_MODEL'] : p.model;
  const url = p.needEnv ? p.url.replace('{ACCOUNT}', encodeURIComponent(env[p.needEnv])) : p.url;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json', ...(p.extraHeaders || {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Rispondi solo con la parola: ok' }], max_tokens: 200, temperature: 0, stream: false }),
      signal: AbortSignal.timeout(20000),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    if (!res.ok) {
      const msg = (j && ((j.error && j.error.message) || j.message)) || txt.slice(0, 200);
      const sug = res.status === 401 || res.status === 403 ? 'chiave non accettata o senza permesso' : res.status === 404 ? 'modello non trovato: cambia ' + p.name.toUpperCase() + '_MODEL su Vercel' : res.status === 429 ? 'quota o limite raggiunto' : '';
      return { name: p.name, stato: 'ERRORE ' + res.status, ms, modello: model, dettaglio: String(msg).slice(0, 220) + (sug ? ' — ' + sug : '') };
    }
    const risp = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { name: p.name, stato: risp ? 'OK' : 'VUOTA', ms, modello: (j && j.model) || model, dettaglio: risp ? String(risp).slice(0, 80) : 'risposta senza testo (può capitare con i modelli che ragionano: non è un errore della chiave)' };
  } catch (e) {
    return { name: p.name, stato: 'ERRORE', ms: Date.now() - t0, modello: model, dettaglio: String(e && e.message || e).slice(0, 200) };
  }
}

export default async function handler(req) {
  const u = new URL(req.url);
  const admin = process.env.VISITS_ADMIN_KEY || '';
  if (!admin || (u.searchParams.get('key') || '') !== admin) return new Response('Non autorizzato', { status: 401 });
  const out = await Promise.all(LIST.map(p => provaUno(p, process.env)));
  if (u.searchParams.get('format') === 'json') return new Response(JSON.stringify(out, null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  const col = s => s === 'OK' ? '#1f7a3a' : s === 'SPENTO' ? '#666' : s === 'VUOTA' ? '#b07a00' : '#b3261e';
  const rows = out.map(r => '<tr><td><b>' + esc(r.name) + '</b></td><td><span style="background:' + col(r.stato) + ';color:#fff;padding:2px 10px;border-radius:12px;font-weight:700">' + esc(r.stato) + '</span></td><td>' + (r.ms == null ? '' : r.ms + ' ms') + '</td><td>' + esc(r.modello || '') + '</td><td>' + esc(r.dettaglio) + '</td></tr>').join('');
  const html = '<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Prova motori AI</title><style>body{font-family:Segoe UI,Arial,sans-serif;background:#0f0f0f;color:#ddd;margin:0;padding:24px}h1{color:#FF8C42;font-size:22px}table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;color:#FF8C42;padding:8px;border-bottom:1px solid #333}td{padding:8px;border-bottom:1px solid #222;vertical-align:top}p{color:#999;font-size:13px;line-height:1.6}</style></head><body><h1>Prova dei motori AI</h1><p>Una domanda cortissima a ogni motore collegato. SPENTO = manca la chiave su Vercel. Ricarica la pagina per ripetere la prova.</p><table><tr><th>Motore</th><th>Esito</th><th>Tempo</th><th>Modello</th><th>Dettaglio</th></tr>' + rows + '</table></body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
