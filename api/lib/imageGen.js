// ════════════════════════════════════════════════════════════════════════
// lib/imageGen.js — Generazione immagini con retry + provider di backup
// ════════════════════════════════════════════════════════════════════════
// Creato 2026-09-19, aggiornato 2026-09-20 dopo due scoperte concrete con
// test dal vivo:
//   1. Pollinations, nell'arco di pochi minuti, può rispondere con errori
//      diversi e scorrelati (500, timeout, 429) sulla stessa identica
//      richiesta che prima funzionava — instabilità reale e intermittente,
//      non un bug nostro. Un secondo tentativo spesso basta.
//   2. Il vecchio endpoint Hugging Face "api-inference.huggingface.co" non
//      esiste più (DNS non risolve: "getaddrinfo ENOTFOUND") — Hugging Face
//      lo ha sostituito con un sistema di "Inference Providers" instradato
//      dietro router.huggingface.co, richiede la loro libreria ufficiale
//      invece di un URL REST fisso (la struttura cambia in base al modello
//      e al provider di calcolo scelto). Vedi package.json: serve la
//      dipendenza "@huggingface/inference".
//
// Ora questo modulo:
//   1. Prova Pollinations FINO A 2 VOLTE (con una breve pausa tra i tentativi),
//      verificando DAVVERO che risponda con un'immagine valida.
//   2. Se fallisce comunque, prova Hugging Face come riserva (via libreria
//      ufficiale) — stesso principio già usato per il testo con Groq+OpenRouter.
//   3. Se anche quello fallisce (o non è configurato), propaga l'errore
//      così il chiamante può mostrare un messaggio onesto.
//
// CONFIGURAZIONE RICHIESTA per il fallback (opzionale ma consigliata):
// 1. variabile d'ambiente HUGGINGFACE_API_KEY su Vercel — gratuita:
//    huggingface.co → Settings → Access Tokens → New token, permesso
//    "Make calls to Inference Providers".
// 2. dipendenza "@huggingface/inference" aggiunta a package.json.
// Senza queste due cose, il modulo funziona comunque, usando solo
// Pollinations (ma con verifica reale e retry, non più alla cieca).

export function buildPollinationsUrl(prompt, opts = {}) {
  const width  = opts.width  || 1024;
  const height = opts.height || 1024;
  const seed   = opts.seed != null ? opts.seed : Math.floor(Math.random() * 1000000);
  const encoded = encodeURIComponent(prompt);
  // NOTA 2026-09-19: enhance=true rimosso — duplicava un arricchimento del
  // prompt che facciamo già a monte (lato client/agente), e nei test diretti
  // aumentava la frequenza di errori 500/timeout senza alcun beneficio reale.
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&nologo=true&model=flux&seed=${seed}&referrer=ainstain.site`;
}

// Prova a scaricare davvero l'immagine da un URL, con timeout, verificando
// che la risposta sia effettivamente un'immagine valida (non un errore
// travestito da 200, e non una pagina di errore HTML).
async function verifyImageUrlOnce(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('Content-Type non immagine: ' + contentType);
    return true;
  } finally {
    clearTimeout(t);
  }
}

// NUOVO 2026-09-20: fino a `attempts` tentativi con pausa breve tra uno e
// l'altro — dato che i fallimenti osservati sono intermittenti (non sempre
// lo stesso errore sulla stessa identica richiesta), un secondo tentativo
// ha buone probabilità di funzionare quando il primo fallisce.
async function verifyImageUrlWithRetry(url, attempts = 2, timeoutMs = 12000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await verifyImageUrlOnce(url, timeoutMs);
      return;
    } catch (e) {
      lastErr = e;
      console.log('[imageGen] Pollinations tentativo', i + 1, 'di', attempts, 'fallito:', e.message);
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

// Fallback: Hugging Face, via libreria ufficiale "@huggingface/inference".
// NOTA 2026-09-20: prima chiamavamo direttamente "api-inference.huggingface.co"
// con fetch() — quel dominio non esiste più (DNS non risolve). Hugging Face
// ha spostato tutto dietro un sistema di "Inference Providers" (router.huggingface.co)
// la cui struttura varia per modello/provider di calcolo, quindi usiamo la
// loro libreria ufficiale invece di indovinare l'URL a mano.
async function generateWithHuggingFace(prompt, hfKey) {
  const cleanHfKey = String(hfKey || '').trim();
  let InferenceClient;
  try {
    ({ InferenceClient } = await import('@huggingface/inference'));
  } catch (importErr) {
    throw new Error(
      'Libreria "@huggingface/inference" non installata — aggiungila a package.json ' +
      '(dependencies) e fai un nuovo deploy. Dettaglio: ' + String(importErr.message || importErr)
    );
  }
  const client = new InferenceClient(cleanHfKey);
  // FLUX.1-schnell: variante veloce, adatta al livello gratuito dei provider
  // dietro Inference Providers (la stessa famiglia di modello già usata da
  // Pollinations, quindi qualità comparabile).
  const blob = await client.textToImage({
    model: 'black-forest-labs/FLUX.1-schnell',
    inputs: prompt,
  });
  const arrayBuf = await blob.arrayBuffer();
  const contentType = blob.type || 'image/jpeg';
  const base64 = Buffer.from(arrayBuf).toString('base64'); // Node.js runtime: Buffer disponibile
  return `data:${contentType};base64,${base64}`;
}

/**
 * Genera un'immagine con retry + fallback automatico tra provider.
 * @returns {Promise<{url: string, provider: string}>}
 */
export async function generateImageWithFallback(prompt, opts = {}) {
  const pollinationsUrl = buildPollinationsUrl(prompt, opts);

  try {
    await verifyImageUrlWithRetry(pollinationsUrl, 2);
    console.log('[imageGen] Pollinations OK');
    return { url: pollinationsUrl, provider: 'Pollinations' };
  } catch (errPollinations) {
    console.log('[imageGen] Pollinations fallito dopo i retry:', errPollinations.message, '| hfKey presente:', !!opts.hfKey);
    if (opts.hfKey) {
      try {
        const dataUrl = await generateWithHuggingFace(prompt, opts.hfKey);
        console.log('[imageGen] Hugging Face OK');
        return { url: dataUrl, provider: 'Hugging Face (backup)' };
      } catch (errHf) {
        console.log('[imageGen] Hugging Face fallito:', errHf.message);
        throw new Error(
          'Entrambi i provider immagine hanno fallito. Pollinations: ' + errPollinations.message +
          ' | Hugging Face: ' + errHf.message
        );
      }
    }
    // Nessun fallback configurato: propaga l'errore originale di Pollinations.
    throw errPollinations;
  }
}
