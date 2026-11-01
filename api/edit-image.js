// api/edit-image.js — Modifica di un'immagine caricata (image-to-image)
// 2026-09-27: creato (Hugging Face). 2026-10-31: aggiunto Cloudflare come motore
// principale gratuito + limite giornaliero per IP (per proteggere i 10.000 neuron/giorno).
// Funzione Node.js standard (non Edge), come generate-image.js.
export const config = { maxDuration: 60 };

import { editImageWithFallback } from './lib/imageGen.js';

const EDIT_DAILY_LIMIT = Number(process.env.EDIT_DAILY_LIMIT || 10); // modifiche al giorno per IP

// Limite per IP su Upstash Redis. Se Redis non è configurato o dà errore, NON blocca (fail-open).
async function underLimit(ip) {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) return true;
  try {
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');
    const rl = new Ratelimit({
      redis: Redis.fromEnv(),
      limiter: Ratelimit.slidingWindow(EDIT_DAILY_LIMIT, '1 d'),
      prefix: 'ainstain:edit-image',
    });
    const r = await rl.limit(ip);
    return r.success;
  } catch (e) {
    console.log('[edit-image] limiter non disponibile:', String(e.message || e));
    return true;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const body = req.body || {};
  const image = String(body.image || '').trim();              // data URL dell'immagine (originale)
  const imageSmall = String(body.imageSmall || '').trim();    // copia ridotta (480 px) per Cloudflare
  const imageMid = String(body.imageMid || '').trim();        // copia media (1024 px): provata per prima, meno deformazioni sui visi
  const prompt = String(body.prompt || '').trim();            // istruzione di modifica
  const w = Number(body.w) || 0, h = Number(body.h) || 0;    // dimensioni dell'originale

  if (!image) { res.status(400).json({ error: 'immagine mancante' }); return; }
  if (!prompt) { res.status(400).json({ error: 'istruzione di modifica mancante' }); return; }

  const hfKey = process.env.HUGGINGFACE_API_KEY;
  const cfToken = process.env.CLOUDFLARE_API_TOKEN;
  const cfAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  console.log('[edit-image] hf:', !!hfKey, '| cf:', !!(cfToken && cfAccount), '| prompt:', prompt.slice(0, 60));

  if (!hfKey && !(cfToken && cfAccount)) {
    res.status(503).json({
      error: 'La modifica di immagini non è ancora configurata su questo deploy.',
      detail: 'Servono CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID oppure HUGGINGFACE_API_KEY',
    });
    return;
  }

  const fwd = req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  const ip = String(fwd || 'unknown').split(',')[0].trim();
  if (!(await underLimit(ip))) {
    res.status(429).json({
      error: 'Hai raggiunto il limite giornaliero di modifiche immagine (' + EDIT_DAILY_LIMIT + '). Riprova domani.',
      rateLimited: true,
    });
    return;
  }

  try {
    const result = await editImageWithFallback(image, prompt, {
      hfKey, cfToken, cfAccount, imageSmall, imageMid, w, h, primary: process.env.EDIT_PRIMARY,
    });
    res.status(200).json({ url: result.url, provider: result.provider });
  } catch (err) {
    console.log('[edit-image] fallito:', String(err.message || err));
    res.status(502).json({
      error: 'Modifica immagine fallita. I servizi di editing potrebbero essere temporaneamente sovraccarichi o la quota gratuita giornaliera esaurita.',
      detail: String(err.message || err),
    });
  }
}
