#!/usr/bin/env node
/**
 * Lokaler Start über stdio: der MCP-Client startet diesen Prozess selbst.
 * Konfiguration: WECLAPP_TENANT und WECLAPP_TOKEN als Umgebungsvariablen.
 *
 * Standardmäßig nur lesend: Schreib-Tools gibt es nur mit Änderungsprotokoll
 * (WECLAPP_AUDIT_DIR). So entstehen keine verteilten Protokolle auf mehreren Geräten;
 * geschrieben wird über den zentralen HTTP-Server.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { AuditLog } from './audit.ts';
import { WriteBudget } from './budget.ts';
import { loadWeclappConfig } from './config.ts';
import { createWeclappServer } from './server.ts';
import { WeclappClient } from './weclapp/client.ts';

async function main(): Promise<void> {
  const config = loadWeclappConfig();
  const token = process.env.WECLAPP_TOKEN?.trim();
  if (!token) {
    throw new Error('WECLAPP_TOKEN fehlt. Den API-Token findest du in weclapp unter Meine Einstellungen → API-Token.');
  }
  const client = new WeclappClient(config.baseUrl, token);
  const audit = config.auditDir && !config.readOnly ? await AuditLog.open(config.auditDir, { retentionDays: config.auditRetentionDays, maxBytes: config.auditMaxBytes }) : undefined;
  if (!audit) console.error('[weclapp-mcp] Nur-Lesen-Modus (kein WECLAPP_AUDIT_DIR gesetzt).');

  const writeBudget = new WriteBudget(config.maxWritesPerHour);

  serveStdio(() => createWeclappServer(client, { readOnly: config.readOnly, allowPublicComments: config.allowPublicComments, audit, writeBudget }), {
    onerror: (error) => console.error('[weclapp-mcp]', error.message),
  });
}

main().catch((error: unknown) => {
  // stdout gehört dem MCP-Protokoll, Meldungen daher nur auf stderr
  console.error('[weclapp-mcp]', error instanceof Error ? error.message : error);
  process.exit(1);
});
