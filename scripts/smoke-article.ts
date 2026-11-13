/**
 * Geführter Rauchtest gegen den echten weclapp-Mandanten.
 *
 * Startet den MCP-Server lokal (nur auf 127.0.0.1), legt über die MCP-Tools einen inaktiven
 * Testartikel an und löscht ihn auf Wunsch wieder. Vor jedem Schreiben wird nachgefragt.
 *
 *   node scripts/smoke-article.ts
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

const say = (line = '') => process.stdout.write(`${line}\n`);

async function ask(question: string): Promise<string> {
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

async function confirm(question: string): Promise<boolean> {
  return /^(j|ja|y|yes)$/i.test(await ask(`${question} [j/N] `));
}

type Outcome = { ok: true; data: any } | { ok: false; error: string };

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
  if (result.isError) return { ok: false, error: text };
  return { ok: true, data: JSON.parse(text) };
}

function must(step: string, outcome: Outcome): any {
  if (!outcome.ok) throw new Error(`${step}: ${outcome.error}`);
  return outcome.data;
}

async function main(): Promise<void> {
  say('Rauchtest: Testartikel in weclapp anlegen');
  say('=========================================');

  const tenant = process.env.WECLAPP_TENANT?.trim() || (await ask('Mandant (der Teil vor .weclapp.com): '));
  const config = loadWeclappConfig({ WECLAPP_TENANT: tenant, WECLAPP_BASE_URL: process.env.WECLAPP_BASE_URL });
  say(`Ziel: ${config.baseUrl}`);

  const token = process.env.WECLAPP_TOKEN?.trim() || (await askHidden('weclapp-API-Token (Eingabe bleibt unsichtbar): '));
  if (!token) throw new Error('Kein Token eingegeben.');

  const auditDir = process.env.WECLAPP_AUDIT_DIR?.trim() || './audit';
  const audit = await AuditLog.open(auditDir);
  const { server, close } = createHttpServer({
    baseUrl: config.baseUrl,
    readOnly: false,
    allowPublicComments: false,
    audit,
    allowedHosts: [],
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Client({ name: 'smoke-article', version: '1.0.0' });

  try {
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
      );
    } catch (error) {
      throw new Error(`Anmeldung abgelehnt. Stimmen Mandant und Token? (${error instanceof Error ? error.message : String(error)})`);
    }

    say();
    say('1. Wer bin ich?');
    const me = must('weclapp_whoami', await call(client, 'weclapp_whoami'));
    say(`   ${me.firstName ?? ''} ${me.lastName ?? ''} (Nutzer-ID ${me.id})`);

    say('2. Einheiten nachschlagen');
    const units: Array<{ id: string; name?: string }> = must('weclapp_lookup', await call(client, 'weclapp_lookup', { resource: 'unit' })).result;
    if (units.length === 0) throw new Error('weclapp liefert keine Einheiten; ohne Einheit lässt sich kein Artikel anlegen.');
    units.slice(0, 15).forEach((unit, index) => say(`   ${index + 1}) ${unit.name ?? '(ohne Namen)'} [id ${unit.id}]`));
    const preferred = Math.max(0, units.findIndex((unit) => /^(st(ü|ue)ck|stk\.?|pcs|piece)/i.test(unit.name ?? '')));
    const picked = Number(await ask(`   Welche Einheit? [${preferred + 1}] `)) || preferred + 1;
    const unit = units[picked - 1] ?? units[preferred];

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const article = {
      articleNumber: `MCP-TEST-${stamp}`,
      name: 'MCP-Testartikel (kann gelöscht werden)',
      articleType: 'BASIC',
      unitId: unit.id,
      active: false,
    };
    const exists = async () =>
      (must('weclapp_search_articles', await call(client, 'weclapp_search_articles', { articleNumber: article.articleNumber })).result as Array<{ articleNumber?: string }>).some(
        (found) => found.articleNumber === article.articleNumber,
      );

    say('3. Geplanter Artikel');
    say(`   Nummer ${article.articleNumber}, Name "${article.name}", Typ BASIC, Einheit ${unit.name}, inaktiv`);
    if (await exists()) throw new Error('Diese Artikelnummer gibt es schon.');

    say('4. Probelauf (dryRun: weclapp prüft, speichert aber nicht)');
    const dry = await call(client, 'weclapp_create_article', { ...article, dryRun: true });
    if (!dry.ok) throw new Error(`weclapp lehnt den Artikel schon im Probelauf ab: ${dry.error}`);
    say('   weclapp nimmt die Daten an.');
    say(`   Nach dem Probelauf in weclapp vorhanden: ${(await exists()) ? 'JA (dryRun hat gespeichert!)' : 'nein, wie erwartet'}`);

    say();
    if (!(await confirm('5. Artikel jetzt wirklich in weclapp anlegen?'))) {
      say('   Nichts angelegt.');
      return;
    }
    const created = must('weclapp_create_article', await call(client, 'weclapp_create_article', article));
    const id = String(created.result.id);
    say(`   Angelegt: Artikel-ID ${id}, changeId ${created.changeId}`);
    if (created.warning) say(`   Warnung: ${created.warning}`);

    say('6. Zurücklesen');
    const read = must('weclapp_get_article', await call(client, 'weclapp_get_article', { id }));
    say(`   ${read.articleNumber} | ${read.name} | Typ ${read.articleType} | aktiv: ${read.active} | Version ${read.version}`);
    const changes = must('weclapp_list_changes', await call(client, 'weclapp_list_changes'));
    say(`   Im Änderungsprotokoll: ${JSON.stringify(changes).includes(created.changeId) ? 'ja' : 'NEIN'}`);

    say();
    if (!(await confirm('7. Testartikel wieder löschen (weclapp_undo_change)?'))) {
      say(`   Der Artikel bleibt bestehen. Später löschen: in weclapp von Hand, Artikelnummer ${article.articleNumber}.`);
      return;
    }
    const undone = await call(client, 'weclapp_undo_change', { changeId: created.changeId });
    if (!undone.ok) {
      say(`   Rückgängig fehlgeschlagen: ${undone.error}`);
      say(`   Bitte in weclapp von Hand löschen: Artikelnummer ${article.articleNumber}.`);
      return;
    }
    const gone = await call(client, 'weclapp_get_article', { id });
    say(`   Rückgängig gemacht. Artikel noch vorhanden: ${gone.ok ? 'JA' : 'nein'}`);
  } finally {
    await client.close().catch(() => {});
    audit.close();
    await close();
  }
}

main()
  .then(() => say('\nFertig.'))
  .catch((error) => {
    say(`\nAbgebrochen: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
