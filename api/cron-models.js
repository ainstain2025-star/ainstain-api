// api/cron-models.js — AGGIUNTO 2026-10-06
// Controllo notturno dei modelli AI. Chiamato da Vercel Cron (vedi vercel.json)
// con "Authorization: Bearer <CRON_SECRET>". Per provarlo a mano:
//   https://ainstain-api.vercel.app/api/cron-models?key=<CRON_SECRET>&dry=1
// (dry=1 = prova a secco: testa tutto ma NON salva nulla.)
export const config = { runtime: 'edge', maxDuration: 60 };

import { runNightlyCheck } from './lib/modelUpdater.js';
import { loadConfig, saveConfig, pushReport, redisConfigured } from './lib/modelConfig.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
});

async function sendAlertMail(env, report) {
  const key = env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY mancante' };
  const to = env.ALERT_EMAIL || 'ainstain2025@gmail.com';
  const from = env.MAIL_FROM || 'AInstAIn <onboarding@resend.dev>';
  const icon = report.severity === 'critical' ? '🔴' : '🟡';
  const li = (report.alerts || []).map(a => '<li>' + String(a).replace(/</g, '&lt;') + '</li>').join('');
  const ac = (report.actions || []).map(a => '<li>' + String(a).replace(/</g, '&lt;') + '</li>').join('');
  const html = '<div style="font-family:system-ui,sans-serif;max-width:560px"><h2>' + icon + ' Controllo modelli AInstAIn</h2><p>' + report.summary + '</p>' +
    (li ? '<h3>Avvisi</h3><ul>' + li + '</ul>' : '') + (ac ? '<h3>Azioni automatiche</h3><ul>' + ac + '</ul>' : '') +
    '<p><a href="https://ainstain-api.vercel.app/api/models-report">Apri il rapporto completo</a></p></div>';
  try {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: icon + ' AInstAIn: controllo modelli — ' + report.severity, html }) });
    return { ok: r.ok, status: r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req) {
  const env = process.env;
  const secret = env.CRON_SECRET;
  if (!secret) return json({ error: 'CRON_SECRET non configurato su Vercel' }, 500);
  const url = new URL(req.url);
  const auth = req.headers.get('authorization') || '';
  if (auth !== 'Bearer ' + secret && url.searchParams.get('key') !== secret) return json({ error: 'Non autorizzato' }, 401);

  const groqKey = env.GROQ_API_KEY;
  if (!groqKey) return json({ error: 'GROQ_API_KEY mancante' }, 500);
  const dry = url.searchParams.get('dry') === '1';
  if (!dry && !redisConfigured(env)) return json({ error: 'Redis non configurato: senza non posso salvare la configurazione. Usa ?dry=1 per provare.' }, 500);

  const deps = {
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    async listModels() {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + groqKey } });
      if (!r.ok) throw new Error('Groq elenco modelli HTTP ' + r.status);
      const d = await r.json();
      return (d.data || []).filter(m => m.active !== false).map(m => m.id);
    },
    async chat(modelId, messages, maxTokens) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST', signal: ctrl.signal,
          headers: { Authorization: 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, messages, max_tokens: maxTokens, temperature: 0.2, stream: false }),
        });
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          const e = new Error('HTTP ' + r.status + ' ' + t.slice(0, 120));
          e.transient = r.status === 429 || r.status >= 500;
          throw e;
        }
        const d = await r.json();
        return d.choices?.[0]?.message?.content || '';
      } catch (e) {
        if (e.name === 'AbortError') { const x = new Error('timeout 20s'); x.transient = true; throw x; }
        if (e.transient === undefined && /fetch|network/i.test(e.message)) e.transient = true;
        throw e;
      } finally { clearTimeout(timer); }
    },
    store: {
      load: () => loadConfig(env),
      save: (c) => saveConfig(env, c),
      push: (rep) => pushReport(env, rep),
    },
  };

  try {
    const report = await runNightlyCheck(deps, { dry });
    // Modello usato in modalità cartella: deve esistere su Groq (altrimenti il fallback sostituisce in silenzio)
    const fm = env.FOLDER_MODEL || 'qwen/qwen3.8-27b';
    if (Array.isArray(report.available) && report.available.length && !report.available.includes(fm)) {
      report.alerts.push('Il modello della modalità cartella "' + fm + '" NON è più disponibile su Groq: la modalità cartella userebbe un modello di riserva.');
      report.severity = 'critical';
    }
    // Avviso via email se c'è qualcosa che non va (non in prova a secco, salvo ?mail=1)
    let mail = null;
    if (report.severity !== 'ok' && (!dry || url.searchParams.get('mail') === '1')) mail = await sendAlertMail(env, report);
    return json({ summary: report.summary, severity: report.severity, actions: report.actions, alerts: report.alerts, dry, mail });
  } catch (e) {
    return json({ error: 'Controllo fallito: ' + e.message }, 500);
  }
}
