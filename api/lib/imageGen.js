// ════════════════════════════════════════════════════════════════════════
// lib/imageGen.js — Generazione immagini con provider di backup
// ════════════════════════════════════════════════════════════════════════
// Creato 2026-09-19 dopo aver confermato (con chiamate dirette di test)
// che Pollinations, nell'arco di pochi minuti, può rispondere con errori
// diversi e scorrelati tra loro (500, timeout, 429 rate-limit) sulla stessa
// identica richiesta che prima funzionava — un'instabilità reale e attuale
// del servizio gratuito, non un bug nostro. Prima, la generazione immagine
// non veniva MAI verificata lato server: il backend costruiva l'URL e lo
// mandava al client senza sapere se avrebbe funzionato.
//
// Ora questo modulo:
//   1. Prova Pollinations, verificando DAVVERO che risponda con un'immagine
//      valida (non solo costruendo l'URL alla cieca).
//   2. Se fallisce, prova un secondo provider gratuito indipendente
//      (Hugging Face Inference API, modello stabilityai/sd-turbo) come
//      riserva — stesso principio già usato per il testo con Groq+OpenRouter.
//   3. Se anche quello fallisce (o non è configurato), propaga l'errore
//      così il chiamante può mostrare un messaggio onesto.
//
// CONFIGURAZIONE RICHIESTA per il fallback (opzionale ma consigliata):
// variabile d'ambiente HUGGINGFACE_API_KEY su Vercel — gratuita:
// huggingface.co → Settings → Access Tokens → New token (permessi "Read").
// Senza questa chiave, il modulo funziona comunque, usando solo Pollinations
// (comportamento equivalente a prima, ma con verifica reale invece che alla cieca).

// Edge Runtime non ha Buffer (Node.js); usiamo btoa (API web-standard)
// convertendo prima l'ArrayBuffer in una stringa binaria byte-per-byte.
function arrayBufferToBase64(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

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
async function verifyImageUrl(url, timeoutMs = 15000) {
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

// Fallback: Hugging Face Inference API, modello leggero e veloce (sd-turbo).
// x-wait-for-model: true → se il modello è "in caricamento" (cold start),
// HF aspetta invece di rispondere subito 503 (evita un fallimento inutile
// al primo utilizzo dopo un periodo di inattività del modello).
async function generateWithHuggingFace(prompt, hfKey, timeoutMs = 25000) {
  // DIFESA 2026-09-20: una chiave incollata da Vercel/HF può portarsi dietro
  // uno spazio o un a-capo accidentale — un header Authorization con un
  // carattere di controllo non è valido e fetch() lo rifiuta con un errore
  // generico ("internal error") che non spiega la vera causa.
  const cleanHfKey = String(hfKey || '').trim();
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch('https://api-inference.huggingface.co/models/stabilityai/sd-turbo', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + cleanHfKey,
        'Content-Type': 'application/json',
        'x-wait-for-model': 'true',
      },
      body: JSON.stringify({ inputs: prompt }),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    // Errore a livello di rete/trasporto (non una risposta HTTP con status):
    // catturiamo nome + messaggio + eventuale "cause" per capire la vera origine
    // invece del generico "internal error" che altrimenti arriverebbe nudo.
    throw new Error(
      'Hugging Face — errore di rete prima di ricevere risposta: ' +
      (fetchErr && fetchErr.name ? fetchErr.name + ': ' : '') +
      (fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr)) +
      (fetchErr && fetchErr.cause ? ' | cause: ' + String(fetchErr.cause) : '')
    );
  } finally {
    clearTimeout(t);
  }
  try {
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error('Hugging Face ' + res.status + ' ' + errText.slice(0, 200));
    }
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) {
      const errText = await res.text().catch(() => '');
      throw new Error('Hugging Face risposta non-immagine: ' + errText.slice(0, 200));
    }
    const buf = await res.arrayBuffer();
    // NOTA: questo file gira su Vercel Edge Runtime, che NON ha l'oggetto
    // Buffer di Node.js — serve una conversione manuale in base64 con API
    // web-standard (btoa), altrimenti la funzione crasha silenziosamente.
    const base64 = arrayBufferToBase64(buf);
    return `data:${contentType};base64,${base64}`;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Genera un'immagine con fallback automatico tra provider.
 * @returns {Promise<{url: string, provider: string}>}
 */
export async function generateImageWithFallback(prompt, opts = {}) {
  const pollinationsUrl = buildPollinationsUrl(prompt, opts);

  try {
    await verifyImageUrl(pollinationsUrl);
    console.log('[imageGen] Pollinations OK');
    return { url: pollinationsUrl, provider: 'Pollinations' };
  } catch (errPollinations) {
    console.log('[imageGen] Pollinations fallito:', errPollinations.message, '| hfKey presente:', !!opts.hfKey);
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
