export const config = { runtime: 'edge', maxDuration: 60 };

import { generateImageWithFallback } from './lib/imageGen.js';

// ════════════════════════════════════════════════════════════════════════
// api/generate-image.js — Endpoint dedicato alla generazione immagine
// ════════════════════════════════════════════════════════════════════════
// Creato 2026-09-19 per la modalità diretta (non-Agente): prima il frontend
// costruiva l'URL Pollinations da solo e lo caricava alla cieca con
// <img src>, senza nessuna verifica o riserva lato server. Ora passa da qui,
// che verifica davvero la generazione e prova un secondo provider gratuito
// (Hugging Face) se Pollinations non risponde — stesso meccanismo già usato
// in api/chat.js per la modalità Agente.
export default async function handler(req) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'JSON non valido' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }

  const prompt = (body.prompt || '').trim();
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'prompt mancante' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
  const width  = Number.isFinite(body.width)  ? body.width  : 1024;
  const height = Number.isFinite(body.height) ? body.height : 1024;
  const seed   = Number.isFinite(body.seed)   ? body.seed   : undefined;

  const hfKey = process.env.HUGGINGFACE_API_KEY; // opzionale — vedi lib/imageGen.js

  try {
    const result = await generateImageWithFallback(prompt, { width, height, seed, hfKey });
    return new Response(JSON.stringify({ url: result.url, provider: result.provider }), {
      status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: 'Generazione immagine fallita su tutti i provider disponibili' + (hfKey ? ' (Pollinations e Hugging Face)' : ' (solo Pollinations configurato)') + '.',
      detail: String(err.message || err),
    }), { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
}
