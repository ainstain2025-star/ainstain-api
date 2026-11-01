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
  // FIX #2 2026-09-27 (trovato dai log Vercel del secondo test dal vivo, ancora
  // fallito): l'errore reale era "Task 'image-to-image' not supported for
  // provider 'fal-ai'" — con provider lasciato su "auto", la libreria aveva
  // scelto 'fal-ai' per il modello FLUX.1-Kontext-dev, ma quella combinazione
  // specifica su Hugging Face Inference Providers non espone il task
  // image-to-image (nonostante fal.ai stesso, usato direttamente, supporti
  // Kontext per l'editing — è un limite dell'instradamento attuale di HF, non
  // del modello in sé). Cambiato a `black-forest-labs/FLUX.2-klein-9B` con
  // `provider: 'fal-ai'` ESPLICITO (non più "auto") — è esattamente la
  // combinazione modello+provider usata come esempio ufficiale nella
  // documentazione Hugging Face per image-to-image, quindi confermata
  // funzionante lato loro. Se anche questa combinazione dovesse fallire, il
  // prossimo passo è provare `provider: 'replicate'` o `'together'` (elencati
  // come endpoint compatibili con FLUX.1 Kontext nella pagina del modello).
  const outputBlob = await client.imageToImage({
    model: 'black-forest-labs/FLUX.2-klein-9B',
    provider: 'fal-ai',
    inputs: imageBlob,
    parameters: { prompt: instruction },
  });
  const arrayBuf = await outputBlob.arrayBuffer();
  const contentType = outputBlob.type || 'image/jpeg';
  const base64 = Buffer.from(arrayBuf).toString('base64');
  return `data:${contentType};base64,${base64}`;
}

// ── Cloudflare Workers AI: FLUX.2 klein 4B (aggiunto 2026-10-31) ──────────
// Secondo motore per la modifica di immagini. Il piano gratuito Cloudflare dà
// 10.000 "neuron" al giorno (si azzerano alle 00:00 UTC), molto più dei $0.10/mese
// di Hugging Face. Dalla documentazione Cloudflare (changelog 2026-01-15): il modello
// accetta fino a 4 immagini in ingresso (campi multipart input_image_0..3), ciascuna
// più piccola di 512x512; width/height in uscita da 256 a 1920; steps fisso a 4.
// Per questo il client invia anche una copia ridotta (imageSmall) e le dimensioni
// dell'originale (w, h) per mantenere le proporzioni in uscita.
// NON ancora provato dal vivo (nessun accesso a Cloudflare da qui): prova con una
// vera richiesta dopo il deploy. Se fallisce, si passa a Hugging Face.
function cfOutputSize(w, h, maxSide) {
  maxSide = maxSide || 768;
  const W = Number(w) || 0, H = Number(h) || 0;
  if (!W || !H) return { width: maxSide, height: maxSide };
  const k = maxSide / Math.max(W, H);
  const r16 = (v) => Math.min(1920, Math.max(256, Math.round((v * k) / 16) * 16));
  return { width: r16(W), height: r16(H) };
}

async function editWithCloudflare(smallDataUrl, instruction, cf) {
  if (!cf || !cf.token || !cf.account) {
    throw new Error('Cloudflare non configurato: mancano CLOUDFLARE_API_TOKEN e/o CLOUDFLARE_ACCOUNT_ID.');
  }
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(smallDataUrl || ''));
  if (!m) throw new Error('Cloudflare: manca la copia ridotta dell\'immagine (imageSmall).');
  const buf = Buffer.from(m[2], 'base64');
  const { width, height } = cfOutputSize(cf.w, cf.h, cf.maxSide);
  const form = new FormData();
  form.append('prompt', String(instruction).slice(0, 1000));
  form.append('input_image_0', new Blob([buf], { type: m[1] || 'image/jpeg' }), 'input.jpg');
  form.append('width', String(width));
  form.append('height', String(height));
  const url = 'https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(cf.account) +
              '/ai/run/@cf/black-forest-labs/flux-2-klein-4b';
  const res = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + cf.token }, body: form });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error('Cloudflare HTTP ' + res.status + ' ' + detail);
  }
  if (ct.startsWith('image/')) {
    const b = Buffer.from(await res.arrayBuffer());
    return 'data:' + ct.split(';')[0] + ';base64,' + b.toString('base64');
  }
  const j = await res.json().catch(() => null);
  const img = j && j.result && (typeof j.result === 'string' ? j.result : j.result.image);
  if (!j || j.success === false || !img) {
    throw new Error('Cloudflare: risposta senza immagine ' + JSON.stringify(j && j.errors || j).slice(0, 200));
  }
  const mime = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + img;
}

/**
 * Modifica un'immagine esistente in base a un'istruzione testuale
 * (image-to-image). Pollinations non è usabile (genera solo da testo).
 * Motori, in ordine (cambiabile con la variabile EDIT_PRIMARY = "hf" o "cf"):
 *   1. Cloudflare FLUX.2 klein 4B (gratuito, 10.000 neuron/giorno) — default
 *   2. Hugging Face FLUX.2 klein 9B (qualità migliore, ma credito gratuito di $0.10/mese)
 * Se il primo fallisce passa al secondo; se falliscono entrambi l'errore è propagato.
 * @param {string} imageDataUrl - data URL dell'immagine (originale, anche grande)
 * @param {string} instruction
 * @param {{hfKey?: string, cfToken?: string, cfAccount?: string, imageSmall?: string, imageMid?: string, w?: number, h?: number, primary?: string}} opts
 * @returns {Promise<{url: string, provider: string}>}
 */
export async function editImageWithFallback(imageDataUrl, instruction, opts = {}) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(String(imageDataUrl || ''));
  if (!match) {
    throw new Error('Formato immagine non valido: atteso un data URL base64 (data:image/...;base64,...).');
  }
  const mimeType = match[1];
  const imageBuffer = Buffer.from(match[2], 'base64');

  const engines = {
    cf: {
      ok: !!(opts.cfToken && opts.cfAccount),
      label: 'Cloudflare (FLUX.2 klein)',
      // 2026-11-01: prima prova con la copia grande (~1024 px: più pixel per ogni volto, meno deformazioni);
      // se Cloudflare la rifiuta (la sua pagina parla di limite 512 px) ripiega sulla copia piccola.
      run: async () => {
        const base = { token: opts.cfToken, account: opts.cfAccount, w: opts.w, h: opts.h };
        if (opts.imageMid) {
          try {
            const u = await editWithCloudflare(opts.imageMid, instruction, { ...base, maxSide: 1024 });
            engines.cf.label = 'Cloudflare (FLUX.2 klein, input grande)';
            return u;
          } catch (e) {
            console.log('[imageGen] Cloudflare con input grande fallito, riprovo con input piccolo:', String(e.message || e).slice(0, 200));
          }
        }
        const u = await editWithCloudflare(opts.imageSmall, instruction, { ...base, maxSide: 768 });
        engines.cf.label = 'Cloudflare (FLUX.2 klein, input piccolo)';
        return u;
      },
    },
    hf: {
      ok: !!opts.hfKey,
      label: 'Hugging Face (FLUX.2 klein)',
      run: () => editWithHuggingFace(imageBuffer, mimeType, instruction, opts.hfKey),
    },
  };
  const order = (opts.primary === 'hf' ? ['hf', 'cf'] : ['cf', 'hf']).filter((k) => engines[k].ok);
  if (!order.length) throw new Error('Nessun motore di editing configurato (servono CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID oppure HUGGINGFACE_API_KEY).');

  const errors = [];
  for (const k of order) {
    try {
      const url = await engines[k].run();
      console.log('[imageGen] Editing OK con', engines[k].label);
      return { url, provider: engines[k].label };
    } catch (err) {
      console.log('[imageGen] Editing fallito con', engines[k].label + ':', err.message);
      errors.push(engines[k].label + ': ' + String(err.message || err).slice(0, 200));
    }
  }
  throw new Error(errors.join(' | '));
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
