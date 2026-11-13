/**
 * Zugangsprüfung am Eingang des HTTP-Servers.
 *
 * Ein Request wird erst verarbeitet, wenn weclapp den mitgeschickten Token
 * als gültig für den konfigurierten Mandanten bestätigt hat. Ergebnisse werden
 * kurz zwischengespeichert; Fehlversuche werden pro IP-Adresse begrenzt.
 */
import { createHash } from 'node:crypto';
import { TOKEN_PATTERN, WeclappClient, WeclappError, type Entity } from './weclapp/client.ts';

export type Verdict = { ok: true; user: Entity } | { ok: false; reason: 'invalid' | 'unavailable' };

const VALID_TTL_MS = 5 * 60_000;
const INVALID_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1000;

/** Liest den Token aus "Authorization: Bearer <token>". */
export function bearerToken(header: string | undefined): string | undefined {
  const token = header?.match(/^Bearer +(\S+) *$/i)?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

export class TokenVerifier {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, { verdict: Verdict; expires: number }>();
  readonly #pending = new Map<string, Promise<Verdict>>();

  constructor(baseUrl: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Prüft den Token gegen weclapp (GET /user/currentUser). */
  verify(token: string): Promise<Verdict> {
    // Im Cache liegt nur der Hash, nie der Token selbst
    const key = createHash('sha256').update(token).digest('hex');
    const cached = this.#cache.get(key);
    if (cached && cached.expires > this.#now()) return Promise.resolve(cached.verdict);

    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#check(token)
        .then((verdict) => {
          if (verdict.ok || verdict.reason === 'invalid') this.#remember(key, verdict);
          return verdict;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, pending);
    }
    return pending;
  }

  async #check(token: string): Promise<Verdict> {
    try {
      const user = await new WeclappClient(this.#baseUrl, token, { fetch: this.#fetch, timeoutMs: 10_000 }).currentUser();
      if (!user || typeof user.id !== 'string') return { ok: false, reason: 'unavailable' };
      return { ok: true, user };
    } catch (error) {
      if (error instanceof WeclappError && (error.status === 401 || error.status === 403)) return { ok: false, reason: 'invalid' };
      return { ok: false, reason: 'unavailable' };
    }
  }

  #remember(key: string, verdict: Verdict): void {
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const now = this.#now();
      for (const [k, v] of this.#cache) if (v.expires <= now) this.#cache.delete(k);
      // Immer noch voll: älteste Einträge verwerfen (Map behält die Einfügereihenfolge)
      for (const k of this.#cache.keys()) {
        if (this.#cache.size < MAX_CACHE_ENTRIES) break;
        this.#cache.delete(k);
      }
    }
    this.#cache.set(key, { verdict, expires: this.#now() + (verdict.ok ? VALID_TTL_MS : INVALID_TTL_MS) });
  }
}

/** Begrenzt Fehlversuche pro Schlüssel (IP-Adresse) in einem festen Zeitfenster. */
export class FailureLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { count: number; resetAt: number }>();

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = options.max ?? 10;
    this.#windowMs = options.windowMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  /** Sekunden bis zur Freigabe, oder 0 wenn nicht gesperrt. */
  blockedFor(key: string): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    const now = this.#now();
    if (entry.resetAt <= now) {
      this.#entries.delete(key);
      return 0;
    }
    return entry.count >= this.#max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  fail(key: string): void {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    if (this.#entries.size >= 10_000) {
      for (const [k, v] of this.#entries) if (v.resetAt <= now) this.#entries.delete(k);
      if (this.#entries.size >= 10_000) this.#entries.clear();
    }
    this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
  }
}
