// api/lib/modelUpdater.js — AGGIUNTO 2026-10-06
//
// Motore del controllo notturno dei modelli (usato da api/cron-models.js).
//
// Cosa fa, in ordine:
//  1. chiede a Groq l'elenco dei modelli attivi;
//  2. per ogni modello usato da AInstAIn: è sparito? esiste una versione più
//     recente della stessa famiglia e taglia (es. qwen3.6-27b -> qwen3.8-27b)?
//  3. il candidato viene messo alla prova con una batteria di test (italiano,
//     uso dei risultati web, formato dell'Agente, lettura di una foto, assenza
//     di token "grezzi"). SOLO se supera tutto viene adottato;
//  4. controlla anche la salute dei modelli già attivi: se uno fallisce in modo
//     definitivo e il precedente è ancora valido, torna indietro da solo;
//  5. salva la nuova configurazione (solo se qualcosa è cambiato) e un rapporto.
//
// Regola di fondo: nel dubbio NON cambia nulla. Un test "inconcludente"
// (limite di traffico, timeout) non promuove e non fa tornare indietro.

import { planUpdates, applyReplacement, validateConfig } from './modelConfig.js';

const VISION_TEST_PNG = 'data:image/png;base64,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';

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const RAW_TOKENS = /<\|[a-z_]+\|>|<think>|<\/think>/i;

// ── Batteria di test ────────────────────────────────────────────────────
// applies: per quali ruoli ha senso. check(text) -> true/false (+ dettaglio)
export const TESTS = [
  {
    name: 'italiano',
    applies: () => true,
    build: () => ({
      messages: [{ role: 'user', content: "Rispondi SOLO in italiano, con una frase: qual è la capitale d'Italia e quale fiume la attraversa?" }],
      maxTokens: 900,
    }),
    check: (t) => /roma/i.test(t) && /tevere/i.test(t) && !CJK.test(t)
      ? { ok: true } : { ok: false, detail: 'risposta non corretta o non in italiano: "' + t.slice(0, 80) + '"' },
  },
  {
    name: 'pulizia',
    applies: () => true,
    build: () => ({
      messages: [{ role: 'user', content: 'Scrivi in italiano due frasi sul mare.' }],
      maxTokens: 900,
    }),
    check: (t) => t.trim().length > 20 && !RAW_TOKENS.test(t) && !CJK.test(t)
      ? { ok: true } : { ok: false, detail: 'risposta vuota o con token grezzi/caratteri estranei: "' + t.slice(0, 80) + '"' },
  },
  {
    name: 'uso risultati web',
    applies: (roles) => roles.some(r => ['main', 'multi', 'judge'].includes(r)),
    build: () => ({
      messages: [
        { role: 'system', content: '[RISULTATI WEB - oggi]\nHo cercato: "meteo Napoli oggi".\n- Meteo Napoli: oggi 23 gradi, cielo sereno, vento debole (https://esempio.it/meteo)\n[Fine risultati]\n\nUsa queste informazioni. Cita le fonti.' },
        { role: 'user', content: 'Che tempo fa oggi a Napoli?' },
      ],
      maxTokens: 900,
    }),
    check: (t) => /23/.test(t) && !/non dispongo|non ho accesso|non posso (fornire|accedere)/i.test(t)
      ? { ok: true } : { ok: false, detail: 'ignora i risultati web forniti: "' + t.slice(0, 80) + '"' },
  },
  {
    name: 'formato Agente (ReAct)',
    applies: (roles) => roles.includes('main'),
    build: () => ({
      messages: [
        { role: 'system', content: "Rispondi ESATTAMENTE in questo formato, senza altro testo:\nTHOUGHT: <breve ragionamento>\nACTION: web_search\nACTION_INPUT: <query di ricerca>" },
        { role: 'user', content: "Chi ha vinto l'ultimo Giro d'Italia?" },
      ],
      maxTokens: 900,
    }),
    check: (t) => /ACTION:\s*web_search/i.test(t) && /ACTION_INPUT:/i.test(t)
      ? { ok: true } : { ok: false, detail: 'non rispetta il formato ReAct: "' + t.slice(0, 80) + '"' },
  },
  {
    name: 'lettura foto',
    applies: (roles) => roles.includes('vision') || roles.includes('multi'),
    build: () => ({
      messages: [{ role: 'user', content: [
        { type: 'text', text: "Quale testo e quali numeri sono scritti nell'immagine? Rispondi solo con quello che leggi." },
        { type: 'image_url', image_url: { url: VISION_TEST_PNG } },
      ] }],
      maxTokens: 900,
    }),
    check: (t) => /4821/.test(t.replace(/\s/g, ''))
      ? { ok: true } : { ok: false, detail: 'non legge la foto di prova: "' + t.slice(0, 80) + '"' },
  },
];

// ── Esecuzione di un test (un solo ritentativo su errori temporanei) ────
async function runTest(deps, modelId, test) {
  const t0 = Date.now();
  const { messages, maxTokens } = test.build();
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await deps.chat(modelId, messages, maxTokens);
      const r = test.check(String(text || ''));
      return { name: test.name, status: r.ok ? 'pass' : 'fail', detail: r.detail || '', ms: Date.now() - t0 };
    } catch (e) {
      lastErr = e;
      if (!e.transient) return { name: test.name, status: 'fail', detail: 'errore: ' + e.message, ms: Date.now() - t0 };
      if (attempt === 0) await deps.sleep(2500);
    }
  }
  return { name: test.name, status: 'inconclusive', detail: 'errore temporaneo: ' + (lastErr && lastErr.message), ms: Date.now() - t0 };
}

export async function runBattery(deps, modelId, roles) {
  const tests = TESTS.filter(t => t.applies(roles));
  const results = await Promise.all(tests.map(t => runTest(deps, modelId, t)));
  const verdict = results.some(r => r.status === 'fail') ? 'fail'
                : results.some(r => r.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return { modelId, roles, verdict, results };
}

const NOT_CHAT = /whisper|tts|guard|embed|orpheus|playai|moderation|transcri/i;

// ── Controllo notturno ──────────────────────────────────────────────────
export async function runNightlyCheck(deps, opts = {}) {
  const report = { at: deps.now(), dry: !!opts.dry, ok: true, severity: 'ok', summary: '', configSource: '', available: [], actions: [], alerts: [], batteries: [] };
  const alert = (msg, sev) => { report.alerts.push(msg); if (sev === 'critical' || report.severity === 'ok') report.severity = sev; };

  // 1. elenco modelli
  let available;
  try {
    available = (await deps.listModels()).filter(id => !NOT_CHAT.test(id));
    if (!available.length) throw new Error('elenco vuoto');
  } catch (e) {
    report.ok = false;
    alert('Impossibile leggere l\'elenco dei modelli da Groq (' + e.message + '). Nessuna modifica fatta.', 'warning');
    report.summary = 'Controllo non riuscito: ' + e.message;
    return finish(deps, report, opts);
  }
  report.available = available;

  // 2. configurazione attuale
  const loaded = await deps.store.load();
  let config = loaded.config;
  report.configSource = loaded.source;
  const originalVersion = config.version || 0;
  const batteryByModel = {};
  const test = async (id, roles) => {
    const key = id + '|' + [...roles].sort().join(',');
    if (!batteryByModel[key]) { batteryByModel[key] = await runBattery(deps, id, roles); report.batteries.push(batteryByModel[key]); }
    return batteryByModel[key];
  };

  // 3. candidati: modelli spariti / aggiornamenti disponibili
  const plan = planUpdates(config, available);
  for (const [oldId, p] of Object.entries(plan)) {
    if (!p.successor) {
      alert('Il modello "' + oldId + '" (ruoli: ' + p.roles.join(', ') + ') non è più disponibile e non c\'è un successore della stessa famiglia: serve una scelta manuale.', 'critical');
      continue;
    }
    const b = await test(p.successor, p.roles);
    if (b.verdict === 'pass') {
      config = applyReplacement(config, oldId, p.successor);
      report.actions.push((p.missing ? 'SOSTITUITO (non più disponibile)' : 'AGGIORNATO') + ': ' + oldId + ' -> ' + p.successor + ' (ruoli: ' + p.roles.join(', ') + ')');
    } else if (b.verdict === 'fail') {
      alert('Il candidato "' + p.successor + '" per sostituire "' + oldId + '" NON ha superato le prove (' + b.results.filter(r => r.status === 'fail').map(r => r.name).join(', ') + '): non adottato.' + (p.missing ? ' ATTENZIONE: il modello attuale non esiste più!' : ''), p.missing ? 'critical' : 'warning');
    } else {
      alert('Prove inconcludenti per "' + p.successor + '" (limiti di traffico o timeout): riproverò stanotte.', 'warning');
    }
  }

  // 4. salute dei modelli attivi + ritorno indietro automatico
  const active = {};
  const addActive = (id, role) => { (active[id] = active[id] || []).push(role); };
  addActive(config.roles.main, 'main'); addActive(config.roles.fast, 'fast');
  addActive(config.roles.vision, 'vision'); addActive(config.roles.judge, 'judge');
  config.roles.multi.forEach(id => addActive(id, 'multi'));
  for (const [id, roles] of Object.entries(active)) {
    if (!available.includes(id)) continue; // già segnalato al punto 3
    const b = await test(id, [...new Set(roles)]);
    if (b.verdict === 'fail') {
      const prev = (config.rollback || {})[id];
      if (prev && available.includes(prev)) {
        const pb = await test(prev, [...new Set(roles)]);
        if (pb.verdict === 'pass') {
          config = applyReplacement(config, id, prev);
          report.actions.push('TORNATO INDIETRO: ' + id + ' -> ' + prev + ' (il modello attivo ha fallito: ' + b.results.filter(r => r.status === 'fail').map(r => r.name).join(', ') + ')');
          continue;
        }
      }
      alert('Il modello attivo "' + id + '" ha fallito le prove (' + b.results.filter(r => r.status === 'fail').map(r => r.name + ': ' + r.detail).join(' | ') + ') e non c\'è un precedente valido a cui tornare.', 'critical');
    } else if (b.verdict === 'inconclusive') {
      alert('Controllo di salute inconcludente per "' + id + '" (errori temporanei).', 'warning');
    }
  }

  // 5. salvataggio (solo se cambiato e valido)
  if ((config.version || 0) !== originalVersion) {
    if (!validateConfig(config)) { alert('La nuova configurazione risulta non valida: NON salvata.', 'critical'); }
    else if (!opts.dry) {
      try { await deps.store.save(config); report.actions.push('Configurazione salvata (versione ' + config.version + ').'); }
      catch (e) { alert('Salvataggio della configurazione non riuscito: ' + e.message, 'critical'); }
    } else report.actions.push('(prova a secco: nessun salvataggio)');
  }
  report.activeRoles = config.roles;
  report.summary = report.actions.length ? report.actions.length + ' azione/i. ' : 'Nessun cambiamento. ';
  report.summary += report.alerts.length ? report.alerts.length + ' avviso/i.' : 'Tutto regolare.';
  return finish(deps, report, opts);
}

async function finish(deps, report, opts) {
  if (!opts.dry) { try { await deps.store.push(report); } catch (e) { report.alerts.push('Rapporto non salvato: ' + e.message); } }
  return report;
}
