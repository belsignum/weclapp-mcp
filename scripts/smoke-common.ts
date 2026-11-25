/**
 * Gemeinsame Teile der geführten Rauchtests gegen den echten weclapp-Mandanten:
 * Abfragen im Terminal, lokaler MCP-Server (nur auf 127.0.0.1) und ein angemeldeter MCP-Client.
 *
 * Mandant und Token werden abgefragt, der Token verdeckt. Er bleibt im Speicher dieses
 * Prozesses und wird nie ausgegeben. Das Änderungsprotokoll landet in WECLAPP_AUDIT_DIR
 * (Standard: ./audit).
 */
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLog } from '../src/audit.ts';
import { loadWeclappConfig } from '../src/config.ts';
import { createHttpServer } from '../src/http.ts';

let muted = false;
const output = new Writable({
  write(chunk, _encoding, done) {
    if (!muted) process.stdout.write(chunk);
    done();
  },
});
const rl = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });

export const say = (line = '') => process.stdout.write(`${line}\n`);

export async function ask(question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

/** Eingabe ohne Echo, damit der Token weder auf dem Bildschirm noch im Terminal-Verlauf steht. */
async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  muted = true;
  try {
    return (await rl.question('')).trim();
  } finally {
    muted = false;
    process.stdout.write('\n');
  }
}

export async function confirm(question: string): Promise<boolean> {
  return /^(j|ja|y|yes)$/i.test(await ask(`${question} [j/N] `));
}

export type Outcome = { ok: true; data: any } | { ok: false; error: string };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  if (result.isError) return { ok: false, error: text };
  return { ok: true, data: JSON.parse(text) };
}

export function must(step: string, outcome: Outcome): any {
  if (!outcome.ok) throw new Error(`${step}: ${outcome.error}`);
  return outcome.data;
}

/** Fragt Mandant und Token ab, startet den MCP-Server lokal und meldet einen MCP-Client daran an. */
export async function startSession(clientName: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const tenant = process.env.WECLAPP_TENANT?.trim() || (await ask('Mandant (der Teil vor .weclapp.com): '));
  const config = loadWeclappConfig({ WECLAPP_TENANT: tenant, WECLAPP_BASE_URL: process.env.WECLAPP_BASE_URL });
  say(`Ziel: ${config.baseUrl}`);

  const token = process.env.WECLAPP_TOKEN?.trim() || (await askHidden('weclapp-API-Token (Eingabe bleibt unsichtbar): '));
  if (!token) throw new Error('Kein Token eingegeben.');

  const auditDir = process.env.WECLAPP_AUDIT_DIR?.trim() || './audit';
  const audit = await AuditLog.open(auditDir);
  const { server, close: closeServer } = createHttpServer({
    baseUrl: config.baseUrl,
    readOnly: false,
    allowPublicComments: false,
    audit,
    allowedHosts: [],
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: clientName, version: '1.0.0' });
  const close = async () => {
    await client.close().catch(() => {});
    audit.close();
    await closeServer();
  };

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
  } catch (error) {
    await close();
    throw new Error(`Anmeldung abgelehnt. Stimmen Mandant und Token? (${error instanceof Error ? error.message : String(error)})`);
  }
  return { client, close };
}

/** Führt einen Rauchtest aus, meldet Abbruch oder Ende und gibt das Terminal wieder frei. */
export function runSmoke(main: () => Promise<void>): void {
  main()
    .then(() => say('\nFertig.'))
    .catch((error) => {
      say(`\nAbgebrochen: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    })
    .finally(() => rl.close());
}
