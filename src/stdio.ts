#!/usr/bin/env node
/**
 * Lokaler Start über stdio (Variante A): der MCP-Client startet diesen Prozess selbst.
 * Konfiguration: WECLAPP_TENANT und WECLAPP_TOKEN als Umgebungsvariablen.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadWeclappConfig } from './config.ts';
import { createWeclappServer } from './server.ts';
import { WeclappClient } from './weclapp/client.ts';

function main(): void {
  const config = loadWeclappConfig();
  const token = process.env.WECLAPP_TOKEN?.trim();
  if (!token) {
    throw new Error('WECLAPP_TOKEN fehlt. Den API-Token findest du in weclapp unter Meine Einstellungen → API-Token.');
  }
  const client = new WeclappClient(config.baseUrl, token);
  serveStdio(() => createWeclappServer(client, config), {
    onerror: (error) => console.error('[weclapp-mcp]', error.message),
  });
}

try {
  main();
} catch (error) {
  // stdout gehört dem MCP-Protokoll, Meldungen daher nur auf stderr
  console.error('[weclapp-mcp]', error instanceof Error ? error.message : error);
  process.exit(1);
}
