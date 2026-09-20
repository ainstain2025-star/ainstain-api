// FIX 2026-09-20: cambiato da Edge Function a funzione Node.js standard.
// La chiamata a Hugging Face falliva con un generico "internal error" DI RETE
// (fetch() falliva prima di ricevere qualunque risposta HTTP, senza dettagli
// utili) — un limite noto del motore di rete delle Vercel Edge Functions su
// certe destinazioni esterne. Le funzioni Node.js usano uno stack di rete
// più maturo (undici) e non hanno bisogno del runtime edge qui: questo
// endpoint non fa streaming (a differenza di chat.js, che resta su Edge).
//
// NOTA IMPORTANTE: le funzioni Node.js "classiche" di Vercel usano la firma
// (req, res) in stile Node/Express — NON gli oggetti Request/Response del
// Web (quelli sono specifici del runtime Edge). Da qui il riscritto completo
// invece di un semplice cambio di config.
export const config = { maxDuration: 60 };

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
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  // Vercel (Node.js runtime) fa già il parsing automatico del body JSON in
  // req.body quando Content-Type è application/json — a differenza di Edge,
  // dove serve chiamare req.json() manualmente.
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) {
    res.status(400).json({ error: 'prompt mancante' });
    return;
  }
  const width  = Number.isFinite(body.width)  ? body.width  : 1024;
  const height = Number.isFinite(body.height) ? body.height : 1024;
  const seed   = Number.isFinite(body.seed)   ? body.seed   : undefined;

  const hfKey = process.env.HUGGINGFACE_API_KEY; // opzionale — vedi lib/imageGen.js
  // LOG DIAGNOSTICO 2026-09-20: mai loggare la chiave stessa, solo se è presente.
  console.log('[generate-image] runtime: nodejs | hfKey presente:', !!hfKey, '| prompt:', prompt.slice(0, 60));

  try {
    const result = await generateImageWithFallback(prompt, { width, height, seed, hfKey });
    console.log('[generate-image] successo, provider:', result.provider);
    res.status(200).json({ url: result.url, provider: result.provider });
  } catch (err) {
    console.log('[generate-image] fallito:', String(err.message || err));
    res.status(502).json({
      error: 'Generazione immagine fallita su tutti i provider disponibili' + (hfKey ? ' (Pollinations e Hugging Face)' : ' (solo Pollinations configurato)') + '.',
      detail: String(err.message || err),
    });
  }
}
