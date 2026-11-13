/**
 * Schreiblimit: begrenzt, wie viele Schreibaktionen ein weclapp-Nutzer pro Stunde über diesen Server auslösen kann.
 *
 * Das ist die Schranke gegen Massenänderungen – etwa wenn ein manipulierter Ticket-Text (Prompt Injection)
 * oder ein fehlerhafter Agent in einer Schleife schreibt. Rückgängig-Aktionen haben ein eigenes, gleich
 * großes Kontingent: so lässt sich ein Schaden auch dann noch zurücknehmen, wenn das Schreiblimit erreicht ist.
 */
const HOUR_MS = 60 * 60_000;

export type WriteKind = 'write' | 'undo';

export class WriteBudget {
  readonly max: number;
  readonly #now: () => number;
  readonly #used = new Map<string, number[]>();

  /** max: Aktionen pro Stunde und Nutzer; 0 = unbegrenzt. */
  constructor(max: number, options: { now?: () => number } = {}) {
    this.max = max;
    this.#now = options.now ?? Date.now;
  }

  /** Verbucht eine Schreibaktion oder wirft, wenn das Kontingent der letzten Stunde aufgebraucht ist. */
  take(userId: string, kind: WriteKind = 'write'): void {
    if (this.max <= 0) return;
    const now = this.#now();
    const key = `${kind}:${userId}`;
    const recent = (this.#used.get(key) ?? []).filter((time) => time > now - HOUR_MS);
    if (recent.length >= this.max) {
      this.#used.set(key, recent);
      const minutes = Math.max(1, Math.ceil((recent[0] + HOUR_MS - now) / 60_000));
      throw new Error(
        kind === 'undo'
          ? `Limit erreicht: höchstens ${this.max} Rückgängig-Aktionen pro Stunde. Die nächste ist in etwa ${minutes} Minuten möglich.`
          : `Schreiblimit erreicht: höchstens ${this.max} Schreibaktionen pro Stunde (einstellbar mit WECLAPP_MAX_WRITES_PER_HOUR). ` +
            `Die nächste ist in etwa ${minutes} Minuten möglich; weclapp_undo_change bleibt nutzbar. Bitte den Nutzer informieren und nicht erneut versuchen.`,
      );
    }
    recent.push(now);
    this.#used.set(key, recent);
  }
}
