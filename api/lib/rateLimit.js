// lib/rateLimit.js
// Modulo condiviso per rate limiting server-side (Upstash Redis).
// Import da api/chat.js e api/verify-premium.js.
// Richiede le env var UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN
// (dal dashboard Upstash, sezione "REST API" del tuo database).

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Esportato per riuso diretto (es. api/track-visit.js, api/visits.js)
export { redis };

// Limite giornaliero per utenti Free (allineato al FREE_MSG_LIMIT del frontend).
export const freeDailyLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(Number(process.env.FREE_DAILY_LIMIT || 20), '1 d'),
  analytics: true,
  prefix: 'ainstain:free-daily',
});

// Limite anti-abuso generale, per IP, valido ANCHE per gli utenti Premium.
// Protegge da bot/script che spammano richieste indipendentemente dal piano.
export const abuseLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(Number(process.env.ABUSE_LIMIT_PER_MIN || 30), '1 m'),
  analytics: true,
  prefix: 'ainstain:abuse',
});

// Limite tentativi sul codice Premium, per proteggere da brute-force.
export const premiumAttemptLimiter = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(5, '10 m'),
  analytics: true,
  prefix: 'ainstain:premium-attempts',
});

// Estrae l'IP del client dagli header standard di Vercel Edge.
export function getClientIp(req) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}
