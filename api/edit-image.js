// FIX/FEATURE 2026-09-27: come api/generate-image.js, funzione Node.js
// standard (non Edge) — Hugging Face non è affidabile sotto Edge Runtime
// (vedi note in generate-image.js e imageGen.js per il dettaglio scoperto
// nella sessione precedente). Questo endpoint non fa streaming, quindi
// Node.js va benissimo (chat.js resta su Edge per l'SSE).

export const config = { maxDuration: 60 };

import { editImageWithFallback } from './lib/imageGen.js';

// ════════════════════════════════════════════════════════════════════════
// api/edit-image.js — Editing reale di un'immagine caricata (image-to-image)
// ════════════════════════════════════════════════════════════════════════
// Creato 2026-09-27 per colmare un gap scoperto in test dal vivo: l'utente
// caricava una foto e chiedeva di trasformarla (stile, sfondo, aggiunte),
// ma AInstAIn aveva solo due pipeline separate — analisi immagine (Qwen
// Vision, immagine→testo) e generazione immagine (Pollinations/HF,
// testo→immagine nuova) — nessuna delle due accetta un'immagine di
// partenza da modificare davvero. Questo endpoint usa Hugging Face
// (FLUX.1-Kontext-dev, via api/lib/imageGen.js) per l'editing vero e
// proprio: immagine + istruzione → nuova immagine modificata.
//
// IMPORTANTE (onestà sui limiti, vedi imageGen.js per il dettaglio):
// - Richiede HUGGINGFACE_API_KEY configurata — senza, l'editing non è
//   disponibile (a differenza della generazione da testo, che ha
//   Pollinations gratuito come principale).
// - La quota gratuita Hugging Face ($0.10/mese per account free) è
//   condivisa con il fallback di generazione testo→immagine già in uso —
//   non è una risorsa illimitata, va monitorata.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const body = req.body || {};
  const image = String(body.image || '').trim();       // data URL base64 dell'immagine caricata
  const prompt = String(body.prompt || '').trim();      // istruzione di modifica

  if (!image) { res.status(400).json({ error: 'immagine mancante' }); return; }
  if (!prompt) { res.status(400).json({ error: 'istruzione di modifica mancante' }); return; }

  const hfKey = process.env.HUGGINGFACE_API_KEY;
  console.log('[edit-image] runtime: nodejs | hfKey presente:', !!hfKey, '| prompt:', prompt.slice(0, 60));

  if (!hfKey) {
    res.status(503).json({
      error: 'La modifica di immagini caricate non è ancora configurata su questo deploy (manca HUGGINGFACE_API_KEY).',
      detail: 'HUGGINGFACE_API_KEY non impostata',
    });
    return;
  }

  try {
    const result = await editImageWithFallback(image, prompt, { hfKey });
    console.log('[edit-image] successo, provider:', result.provider);
    res.status(200).json({ url: result.url, provider: result.provider });
  } catch (err) {
    console.log('[edit-image] fallito:', String(err.message || err));
    res.status(502).json({
      error: 'Modifica immagine fallita. Il servizio di editing (Hugging Face) potrebbe essere temporaneamente sovraccarico, oppure la quota gratuita mensile potrebbe essere esaurita.',
      detail: String(err.message || err),
    });
  }
}
