// api/models-report.js — AGGIUNTO 2026-10-06
// Pagina RISERVATA con gli ultimi rapporti del controllo notturno dei modelli.
// Apri: https://ainstain-api.vercel.app/api/models-report?key=<CRON_SECRET>
export const config = { runtime: 'edge' };

import { loadConfig, loadReports, redisConfigured, prettyName } from './lib/modelConfig.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const H = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

export default async function handler(req) {
  const env = process.env;
  const key = new URL(req.url).searchParams.get('key');
  if (!env.CRON_SECRET || key !== env.CRON_SECRET) return new Response('Non autorizzato', { status: 401, headers: H });

  let reports = [], err = '';
  const { config: cfg, source } = await loadConfig(env);
  if (!redisConfigured(env)) err = 'Redis non configurato.';
  else { try { reports = await loadReports(env, 14); } catch (e) { err = e.message; } }

  const colors = { ok: '#2e9d57', warning: '#d98b00', critical: '#d63b3b' };
  const roles = cfg.roles;
  const roleRows = [['Principale', roles.main], ['Veloce', roles.fast], ['Foto', roles.vision], ['Giudice', roles.judge], ['Multi-modello', roles.multi.join(', ')]]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td><code>${esc(v)}</code></td></tr>`).join('');
  const cards = reports.map(r => `
    <div class="card" style="border-left:6px solid ${colors[r.severity] || '#888'}">
      <b>${esc(new Date(r.at).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }))}</b>${r.dry ? ' <i>(prova a secco)</i>' : ''}
      — ${esc(r.summary)}
      ${(r.actions || []).map(a => `<div class="act">✅ ${esc(a)}</div>`).join('')}
      ${(r.alerts || []).map(a => `<div class="alt">⚠️ ${esc(a)}</div>`).join('')}
      <details><summary>Dettaglio prove</summary>${(r.batteries || []).map(b => `<p><code>${esc(b.modelId)}</code> [${esc((b.roles || []).join(', '))}] → <b>${esc(b.verdict)}</b><br>${(b.results || []).map(t => esc(t.name) + ': ' + esc(t.status) + (t.detail ? ' (' + esc(t.detail) + ')' : '') + ' ' + t.ms + 'ms').join('<br>')}</p>`).join('') || '<p>Nessuna prova eseguita.</p>'}</details>
    </div>`).join('') || '<p>Nessun rapporto ancora: il primo arriverà dopo il primo controllo notturno.</p>';

  return new Response(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>AInstAIn – Modelli</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:20px auto;padding:0 14px;background:#0d0d0f;color:#eee}code{background:#222;padding:1px 5px;border-radius:4px}table{border-collapse:collapse}td{padding:4px 12px 4px 0}.card{background:#17171b;margin:12px 0;padding:12px 14px;border-radius:8px}.act{color:#7fe3a0;margin-top:6px}.alt{color:#ffcc66;margin-top:6px}summary{cursor:pointer;margin-top:8px;color:#aaa}</style></head><body>
<h1>Modelli di AInstAIn</h1><p>Configurazione attiva (versione ${esc(cfg.version)}, fonte: ${esc(source)}${cfg.updatedAt ? ', aggiornata ' + esc(cfg.updatedAt) : ''})</p>
<table>${roleRows}</table>${err ? '<p class="alt">⚠️ ' + esc(err) + '</p>' : ''}<h2>Ultimi controlli notturni</h2>${cards}</body></html>`, { headers: H });
}
