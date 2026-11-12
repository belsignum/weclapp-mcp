export interface WeclappConfig {
  /** Basis-URL der weclapp-API v2, z. B. https://acme.weclapp.com/webapp/api/v2 */
  baseUrl: string;
  /** true: Schreib-Tools werden nicht registriert. */
  readOnly: boolean;
}

const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'ja', 'on'].includes(value.trim().toLowerCase());
}

/**
 * Liest die weclapp-Konfiguration aus der Umgebung.
 *
 * WECLAPP_TENANT ist der Mandant aus https://<tenant>.weclapp.com.
 * WECLAPP_BASE_URL überschreibt die URL komplett (für Tests oder eigene Domains).
 */
export function loadWeclappConfig(env: NodeJS.ProcessEnv = process.env): WeclappConfig {
  const readOnly = flag(env.WECLAPP_READ_ONLY);
  const override = env.WECLAPP_BASE_URL?.trim();
  if (override) {
    const url = new URL(override);
    return { baseUrl: url.toString().replace(/\/+$/, ''), readOnly };
  }

  const tenant = env.WECLAPP_TENANT?.trim();
  if (!tenant) {
    throw new Error('WECLAPP_TENANT fehlt (der Teil vor .weclapp.com in der weclapp-URL).');
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error(`WECLAPP_TENANT "${tenant}" ist ungültig: erwartet wird nur der Mandantenname, z. B. "acme".`);
  }
  return { baseUrl: `https://${tenant}.weclapp.com/webapp/api/v2`, readOnly };
}
