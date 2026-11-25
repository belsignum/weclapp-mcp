import { checkTimeZone } from './weclapp/format.ts';

export interface WeclappConfig {
  /** Basis-URL der weclapp-API v2, z. B. https://acme.weclapp.com/webapp/api/v2 */
  baseUrl: string;
  /** true: Schreib-Tools werden nicht registriert. */
  readOnly: boolean;
  /** true: Kommentare dürfen für Kunden sichtbar (public) geschrieben werden. */
  allowPublicComments: boolean;
  /** Verzeichnis des Änderungsprotokolls. Ohne Protokoll gibt es keine Schreib-Tools. */
  auditDir: string | undefined;
  /** Aufbewahrung des Protokolls in Tagen (0 = unbegrenzt). */
  auditRetentionDays: number;
  /** Maximale Gesamtgröße des Protokolls in Bytes (0 = unbegrenzt). Ist sie erreicht, werden Schreibaktionen abgelehnt. */
  auditMaxBytes: number;
  /** Maximale Schreibaktionen pro Nutzer und Stunde (0 = unbegrenzt). */
  maxWritesPerHour: number;
  /** Zeitzone des Mandanten (IANA-Name). In ihr gelten Datumsangaben ohne Zeitzone, und in ihr wird ausgegeben. */
  timeZone: string;
}

/** Die meisten weclapp-Mandanten arbeiten in Deutschland, Österreich oder der Schweiz: dort gilt überall dieselbe Zeit. */
const DEFAULT_TIME_ZONE = 'Europe/Berlin';

const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'ja', 'on'].includes(value.trim().toLowerCase());
}

function baseUrl(env: NodeJS.ProcessEnv): string {
  const override = env.WECLAPP_BASE_URL?.trim();
  if (override) {
    const url = new URL(override);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) {
      throw new Error('WECLAPP_BASE_URL muss https verwenden (http ist nur für localhost erlaubt).');
    }
    if (url.username || url.password) throw new Error('WECLAPP_BASE_URL darf keine Zugangsdaten enthalten.');
    return url.toString().replace(/\/+$/, '');
  }
  const tenant = env.WECLAPP_TENANT?.trim();
  if (!tenant) {
    throw new Error('WECLAPP_TENANT fehlt (der Teil vor .weclapp.com in der weclapp-URL).');
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error(`WECLAPP_TENANT "${tenant}" ist ungültig: erwartet wird nur der Mandantenname, z. B. "acme".`);
  }
  return `https://${tenant}.weclapp.com/webapp/api/v2`;
}

/**
 * Liest die weclapp-Konfiguration aus der Umgebung.
 *
 * WECLAPP_TENANT ist der Mandant aus https://<tenant>.weclapp.com.
 * WECLAPP_BASE_URL überschreibt die URL komplett (für Tests oder eigene Domains).
 */
/** Liest eine ganze Zahl ≥ 0 aus der Umgebung. */
function count(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} muss eine ganze Zahl ≥ 0 sein.`);
  return value;
}

function timeZone(env: NodeJS.ProcessEnv): string {
  const zone = env.WECLAPP_TIMEZONE?.trim() || DEFAULT_TIME_ZONE;
  try {
    return checkTimeZone(zone);
  } catch {
    throw new Error(`WECLAPP_TIMEZONE "${zone.slice(0, 60)}" ist keine bekannte Zeitzone. Erwartet wird ein IANA-Name wie "Europe/Berlin" oder "UTC".`);
  }
}

export function loadWeclappConfig(env: NodeJS.ProcessEnv = process.env): WeclappConfig {
  const auditRetentionDays = count(env, 'WECLAPP_AUDIT_RETENTION_DAYS', 365);
  return {
    baseUrl: baseUrl(env),
    readOnly: flag(env.WECLAPP_READ_ONLY),
    allowPublicComments: flag(env.WECLAPP_ALLOW_PUBLIC_COMMENTS),
    auditDir: env.WECLAPP_AUDIT_DIR?.trim() || undefined,
    auditRetentionDays,
    auditMaxBytes: count(env, 'WECLAPP_AUDIT_MAX_MB', 100) * 1024 * 1024,
    maxWritesPerHour: count(env, 'WECLAPP_MAX_WRITES_PER_HOUR', 120),
    timeZone: timeZone(env),
  };
}
