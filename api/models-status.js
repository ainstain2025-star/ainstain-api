// api/models-status.js — AGGIUNTO 2026-11-09
// Stato PUBBLICO e sintetico dei modelli (semaforo per la pagina llm.html).
// Non espone nomi di modelli né dettagli dei rapporti: solo livello, data e numero di avvisi.
export const config = { runtime: 'edge' };
import { loadReports, redisConfigured } from './lib/modelConfig.js';

const H = { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' };

export default async function handler() {
  const env = process.env;
  if (!redisConfigured(env)) return new Response(JSON.stringify({ level: 'unknown' }), { headers: H });
  try {
    const reps = (await loadReports(env, 5)).filter(r => !r.dry);
    if (!reps.length) return new Response(JSON.stringify({ level: 'unknown' }), { headers: H });
    const r = reps[0];
    const level = r.severity === 'critical' ? 'red' : r.severity === 'warning' ? 'yellow' : 'green';
    const ageH = (Date.now() - new Date(r.at).getTime()) / 36e5;
    return new Response(JSON.stringify({ level, at: r.at, alerts: (r.alerts || []).length, actions: (r.actions || []).length, stale: ageH > 36 }), { headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ level: 'unknown' }), { headers: H });
  }
}
