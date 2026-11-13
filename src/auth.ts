/**
 * Zugangsprüfung am Eingang des HTTP-Servers.
 *
 * Ein Request wird erst verarbeitet, wenn weclapp den mitgeschickten Token
 * als gültig für den konfigurierten Mandanten bestätigt hat. Ergebnisse werden
 * kurz zwischengespeichert; Fehlversuche werden pro IP-Adresse begrenzt.
 */
import { createHash } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { TOKEN_PATTERN, WeclappClient, WeclappError, type Entity } from './weclapp/client.ts';

export type Verdict = { ok: true; user: Entity } | { ok: false; reason: 'invalid' | 'unavailable' };

const VALID_TTL_MS = 5 * 60_000;
const INVALID_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1000;
/** So lange gilt ein Token nach der letzten Bestätigung durch weclapp als "bekannt" (nur sein Hash wird gemerkt). */
const KNOWN_TTL_MS = 24 * 60 * 60_000;

/** Liest den Token aus "Authorization: Bearer <token>". */
export function bearerToken(header: string | undefined): string | undefined {
  const token = header?.match(/^Bearer +(\S+) *$/i)?.[1];
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

/**
 * Schlüssel für das Rate-Limit: IPv4-Adressen unverändert, IPv6-Adressen auf ihr /64-Netz gekürzt
 * (ein einzelner Anschluss verfügt über mindestens ein ganzes /64 und könnte sonst beliebig viele Adressen durchwechseln).
 * Liefert undefined, wenn der Wert keine IP-Adresse ist.
 */
export function rateLimitKey(address: string | undefined): string | undefined {
  let ip = address?.trim().toLowerCase();
  if (!ip) return undefined;
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  ip = ip.replace(/%.*$/, ''); // Zonen-ID (fe80::1%eth0)
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return undefined;
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  // Eingebettete IPv4-Schreibweise am Ende (z. B. 64:ff9b::1.2.3.4) betrifft nur die hinteren 32 Bit
  const [head = '', tail = ''] = ip.replace(/:\d+\.\d+\.\d+\.\d+$/, ':0:0').split('::');
  const front = head ? head.split(':') : [];
  const back = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...front, ...new Array<string>(Math.max(0, 8 - front.length - back.length)).fill('0'), ...back] : front;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export class TokenVerifier {
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, { verdict: Verdict; expires: number }>();
  readonly #pending = new Map<string, Promise<Verdict>>();
  /** Hashes von Tokens, die weclapp kürzlich bestätigt hat. */
  readonly #known = new Map<string, number>();

  constructor(baseUrl: string, options: { fetch?: typeof fetch; now?: () => number } = {}) {
    this.#baseUrl = baseUrl;
    this.#fetch = options.fetch;
    this.#now = options.now ?? Date.now;
  }

  /** Im Speicher liegt nur dieser Hash, nie der Token selbst. */
  key(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * true, wenn weclapp genau diesen Token in den letzten 24 Stunden bestätigt hat.
   * Ein solcher Request ist kein Rateversuch und wird deshalb nicht vom Rate-Limit gebremst.
   */
  isKnown(token: string): boolean {
    const key = this.key(token);
    const expires = this.#known.get(key);
    if (expires === undefined) return false;
    if (expires > this.#now()) return true;
    this.#known.delete(key);
    return false;
  }

  /** Prüft den Token gegen weclapp (GET /user/currentUser). */
  verify(token: string): Promise<Verdict> {
    const key = this.key(token);
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
    const now = this.#now();
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      for (const [k, v] of this.#cache) if (v.expires <= now) this.#cache.delete(k);
      // Immer noch voll: älteste Einträge verwerfen (Map behält die Einfügereihenfolge)
      for (const k of this.#cache.keys()) {
        if (this.#cache.size < MAX_CACHE_ENTRIES) break;
        this.#cache.delete(k);
      }
    }
    this.#cache.set(key, { verdict, expires: now + (verdict.ok ? VALID_TTL_MS : INVALID_TTL_MS) });

    if (!verdict.ok) {
      // Widerrufener Token: ab sofort wieder wie ein unbekannter behandeln
      this.#known.delete(key);
      return;
    }
    this.#known.delete(key); // neu einfügen, damit die Reihenfolge dem Alter entspricht
    if (this.#known.size >= MAX_CACHE_ENTRIES) this.#known.delete(this.#known.keys().next().value!);
    this.#known.set(key, now + KNOWN_TTL_MS);
  }
}

const MAX_LIMITER_ENTRIES = 10_000;

/**
 * Begrenzt Fehlversuche pro Schlüssel (IP-Adresse) in einem festen Zeitfenster.
 * Laufende, noch nicht entschiedene Versuche zählen mit: sonst ließe sich das Limit
 * mit vielen gleichzeitigen Requests überrennen, bevor der erste Fehlversuch gezählt ist.
 */
export class FailureLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, { count: number; resetAt: number }>();
  /** Laufende Versuche je Schlüssel: Versuchs-Kennung → Anzahl paralleler Requests. */
  readonly #running = new Map<string, Map<string, number>>();

  constructor(options: { max?: number; windowMs?: number; now?: () => number } = {}) {
    this.#max = options.max ?? 10;
    this.#windowMs = options.windowMs ?? 5 * 60_000;
    this.#now = options.now ?? Date.now;
  }

  #count(key: string): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    if (entry.resetAt <= this.#now()) {
      this.#entries.delete(key);
      return 0;
    }
    return entry.count;
  }

  /** Sekunden bis zur Freigabe, oder 0 wenn nicht gesperrt. */
  blockedFor(key: string): number {
    if (this.#count(key) < this.#max) return 0;
    return Math.max(1, Math.ceil((this.#entries.get(key)!.resetAt - this.#now()) / 1000));
  }

  /**
   * Meldet einen Versuch an, dessen Ergebnis noch aussteht. false: zusammen mit den bereits
   * laufenden Versuchen wäre das Limit erreicht; der Versuch darf nicht gestartet werden.
   * `attempt` kennzeichnet, was geprüft wird (Token-Hash): derselbe Versuch zählt nur einmal.
   */
  begin(key: string, attempt: string): boolean {
    let running = this.#running.get(key);
    const refs = running?.get(attempt);
    if (running && refs !== undefined) {
      running.set(attempt, refs + 1);
      return true;
    }
    if (this.#count(key) + (running?.size ?? 0) >= this.#max) return false;
    if (!running) this.#running.set(key, (running = new Map()));
    running.set(attempt, 1);
    return true;
  }

  /** Schließt einen mit begin() angemeldeten Versuch ab; failed: true zählt ihn als Fehlversuch. */
  end(key: string, attempt: string, failed: boolean): void {
    const running = this.#running.get(key);
    const refs = running?.get(attempt);
    if (running && refs !== undefined) {
      if (refs > 1) running.set(attempt, refs - 1);
      else running.delete(attempt);
      if (running.size === 0) this.#running.delete(key);
    }
    if (failed) this.fail(key);
  }

  fail(key: string): void {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (entry && entry.resetAt > now) {
      entry.count += 1;
      return;
    }
    this.#entries.delete(key);
    if (this.#entries.size >= MAX_LIMITER_ENTRIES) {
      for (const [k, v] of this.#entries) if (v.resetAt <= now) this.#entries.delete(k);
      // Immer noch voll: nur die ältesten Einträge verwerfen. Alles zu leeren würde
      // jedem, der genug Adressen aufbringt, sämtliche Sperren auf einmal aufheben.
      for (const k of this.#entries.keys()) {
        if (this.#entries.size < MAX_LIMITER_ENTRIES * 0.9) break;
        this.#entries.delete(k);
      }
    }
    this.#entries.set(key, { count: 1, resetAt: now + this.#windowMs });
  }
}
