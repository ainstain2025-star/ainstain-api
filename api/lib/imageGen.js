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

// ── DIZIONARIO STILI DI NICCHIA/RECENTI (2026-09-21) ─────────────────────
// Stessa logica già aggiunta lato client in index_AI.html (modalità diretta,
// enhanceImagePrompt) — replicata qui perché la modalità Agente NON passa da
// enhanceImagePrompt: costruisce il prompt immagine da sola in chat.js e lo
// manda direttamente a questo modulo. Duplicare qui evita che l'Agente perda
// lo stesso fix. Vedi checklist sezione 16 per il dettaglio del problema
// originale (stile "genmoji" non fedele perché il modello non conosce il
// termine, indipendentemente da chi arricchisce il prompt).
const NICHE_STYLE_HINTS = {
  'genmoji': '3D soft clay-like rendering, glossy plastic/clay material, thick white outline border, rounded minimal shapes, big simple eyes, cute Apple Genmoji sticker aesthetic, isolated on plain white background',
};

function applyNicheStyleHints(prompt) {
  const lower = String(prompt || '').toLowerCase();
  let result = prompt;
  for (const keyword in NICHE_STYLE_HINTS) {
    if (lower.includes(keyword)) {
      result += `, ${NICHE_STYLE_HINTS[keyword]}`;
    }
  }
  return result;
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

// ════════════════════════════════════════════════════════════════════════
// EDITING REALE DI IMMAGINI CARICATE (image-to-image) — aggiunto 2026-09-27
// ════════════════════════════════════════════════════════════════════════
// Gap scoperto in test dal vivo: l'utente carica una foto e chiede di
// trasformarla (stile, sfondo, aggiunte) — prima d'ora AInstAIn non aveva
// NESSUNA pipeline che accettasse un'immagine in ingresso E restituisse
// un'immagine modificata in uscita. La "analisi immagine" (Qwen Vision)
// legge un'immagine e produce solo testo; `generateImageWithFallback` sopra
// genera un'immagine nuova da zero, ma non accetta un'immagine di partenza.
//
// Qui usiamo lo stesso principio/libreria già in uso per il fallback di
// generazione (@huggingface/inference), ma il metodo `imageToImage` invece
// di `textToImage`, col modello black-forest-labs/FLUX.1-Kontext-dev
// (pensato apposta per l'editing guidato da istruzioni testuali, mantiene
// il soggetto/composizione originale invece di reinventare l'immagine).
//
// COSTO REALE VERIFICATO (2026-09-27, da documentazione ufficiale Hugging
// Face): un account HF gratuito riceve $0.10/mese di credito per "Inference
// Providers" — condiviso con QUALSIASI altra chiamata a questa stessa API,
// incluso il fallback di generazione testo→immagine già in uso sopra. Non è
// "gratis illimitato": è una quota molto piccola e condivisa. L'editing
// (modello più pesante di FLUX.1-schnell) probabilmente consuma quella
// quota più in fretta della generazione normale. Nessun costo per attivare
// la funzione (stessa chiave già configurata), ma la capacità reale è
// limitata — da monitorare, non da trattare come risorsa infinita.
async function editWithHuggingFace(imageInput, mimeType, instruction, hfKey) {
  const cleanHfKey = String(hfKey || '').trim();
  if (!cleanHfKey) {
    throw new Error(
      'Editing immagini non configurato: manca HUGGINGFACE_API_KEY. ' +
      'Senza questa chiave l\'editing di immagini caricate non è disponibile ' +
      '(a differenza della generazione da testo, che ha Pollinations come principale).'
    );
  }
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
  // FIX 2026-09-27 (trovato dopo il primo test dal vivo, fallito): la
  // documentazione ufficiale della libreria specifica che `inputs` deve
  // essere un vero oggetto Blob, non un Buffer Node.js grezzo — passare
  // direttamente il Buffer (come nel primo tentativo) probabilmente veniva
  // rifiutato o gestito male dalla libreria, causando il fallimento visto
  // in produzione ("Non sono riuscito a modificare l'immagine").
  const imageBlob = new Blob([imageInput], { type: mimeType || 'image/jpeg' });
  const outputBlob = await client.imageToImage({
    model: 'black-forest-labs/FLUX.1-Kontext-dev',
    inputs: imageBlob,
    parameters: { prompt: instruction },
  });
  const arrayBuf = await outputBlob.arrayBuffer();
  const contentType = outputBlob.type || 'image/jpeg';
  const base64 = Buffer.from(arrayBuf).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

/**
 * Modifica un'immagine esistente in base a un'istruzione testuale
 * (image-to-image). A differenza di generateImageWithFallback, NON ha
 * Pollinations come opzione: Pollinations genera solo da testo, non
 * accetta un'immagine di partenza da modificare. Hugging Face è quindi
 * l'UNICO provider per questa funzione — se non configurato o se fallisce,
 * l'errore va propagato onestamente (nessun secondo fallback disponibile
 * oggi per questa capacità specifica).
 * @param {string} imageDataUrl - data URL (data:image/...;base64,...) dell'immagine caricata dall'utente
 * @param {string} instruction - istruzione testuale (es. "trasforma in stile anime, rimuovi lo sfondo")
 * @param {{hfKey?: string}} opts
 * @returns {Promise<{url: string, provider: string}>}
 */
export async function editImageWithFallback(imageDataUrl, instruction, opts = {}) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(imageDataUrl || ''));
  if (!match) {
    throw new Error('Formato immagine non valido: atteso un data URL base64 (data:image/...;base64,...).');
  }
  const mimeType = match[1];
  const imageBuffer = Buffer.from(match[2], 'base64');

  try {
    const dataUrl = await editWithHuggingFace(imageBuffer, mimeType, instruction, opts.hfKey);
    console.log('[imageGen] Editing Hugging Face OK');
    return { url: dataUrl, provider: 'Hugging Face (FLUX.1 Kontext)' };
  } catch (err) {
    console.log('[imageGen] Editing Hugging Face fallito:', err.message);
    throw err;
  }
}

/**
 * Genera un'immagine con retry + fallback automatico tra provider.
 * @returns {Promise<{url: string, provider: string}>}
 */
export async function generateImageWithFallback(prompt, opts = {}) {
  const augmentedPrompt = applyNicheStyleHints(prompt);
  const pollinationsUrl = buildPollinationsUrl(augmentedPrompt, opts);

  try {
    await verifyImageUrlWithRetry(pollinationsUrl, 2);
    console.log('[imageGen] Pollinations OK');
    return { url: pollinationsUrl, provider: 'Pollinations' };
  } catch (errPollinations) {
    console.log('[imageGen] Pollinations fallito dopo i retry:', errPollinations.message, '| hfKey presente:', !!opts.hfKey);
    if (opts.hfKey) {
      try {
        const dataUrl = await generateWithHuggingFace(augmentedPrompt, opts.hfKey);
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
