import { McpServer } from '@modelcontextprotocol/server';
import type { WeclappConfig } from './config.ts';
import type { WeclappClient } from './weclapp/client.ts';
import { registerArticleTools } from './tools/articles.ts';
import { registerContractTools } from './tools/contracts.ts';
import { registerInvoiceTools } from './tools/invoices.ts';
import { registerLookupTools } from './tools/lookup.ts';
import { registerTicketTools } from './tools/tickets.ts';

export const SERVER_INFO = { name: 'weclapp-mcp', version: '0.1.0' } as const;

const INSTRUCTIONS = `Zugriff auf weclapp (ERP): Artikel, Ausgangsrechnungen, Helpdesk-Tickets mit Kommentaren und Zeitbuchung, Verträge.
- Such-Tools liefern eine kompakte Übersicht; Details mit den get-Tools lesen.
- IDs statt Namen: Nutzer, Status, Einheiten usw. mit weclapp_lookup auflösen, Kunden mit weclapp_search_parties.
- Zeitangaben sind ISO-8601 (Ausgabe in UTC). Dauer in weclapp-Feldern ist in Sekunden.
- Vor jeder Schreibaktion dem Nutzer zeigen, was geändert wird, und auf Bestätigung warten. Bei Unsicherheit dryRun: true nutzen.`;

/** Baut eine MCP-Server-Instanz, deren Tools mit dem übergebenen weclapp-Client (= Token) arbeiten. */
export function createWeclappServer(client: WeclappClient, config: Pick<WeclappConfig, 'readOnly'>): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: config.readOnly ? `${INSTRUCTIONS}\n- Dieser Server ist im Nur-Lesen-Modus.` : INSTRUCTIONS,
  });
  const context = { server, client, readOnly: config.readOnly };
  registerLookupTools(context);
  registerArticleTools(context);
  registerInvoiceTools(context);
  registerTicketTools(context);
  registerContractTools(context);
  return server;
}
