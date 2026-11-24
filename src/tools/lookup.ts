import * as z from 'zod';
import type { Entity } from '../weclapp/client.ts';
import { compact, contains } from '../weclapp/format.ts';
import { READ, allFieldsArg, filterArg, pagingArgs, run, search, sortArg, type ToolContext } from './common.ts';

/** Stammdaten, deren IDs andere Tools brauchen. Feldliste je Ressource kompakt gehalten. */
const LOOKUP_RESOURCES = {
  user: 'id,firstName,lastName,email,status',
  ticketStatus: 'id,name,internalTicketStatus,positionNumber',
  ticketPriority: 'id,name,active,positionNumber',
  ticketType: 'id,name,active,articleId',
  ticketCategory: 'id,name,active,parentTicketCategoryId',
  ticketChannel: '',
  ticketServiceLevelAgreement: 'id,name,active',
  ticketPoolingGroup: 'id,name,description',
  unit: 'id,name,description',
  tax: 'id,name,taxValue,taxType,taxKey',
  articleCategory: 'id,name,parentCategoryId',
  currency: 'id,name,currencySymbol',
  contractType: 'id,name,active',
  contractTerminationReason: '',
  contractBillingGroup: '',
  placeOfService: '',
  costCenter: 'id,costCenterNumber,description',
} as const;

type LookupResource = keyof typeof LOOKUP_RESOURCES;
const RESOURCE_NAMES = Object.keys(LOOKUP_RESOURCES) as [LookupResource, ...LookupResource[]];

const SEARCHABLE = ['name', 'firstName', 'lastName', 'email', 'description', 'costCenterNumber'];

function matches(item: Entity, query: string): boolean {
  const needle = query.toLowerCase();
  const haystack = SEARCHABLE.map((key) => item[key]).filter((v) => typeof v === 'string') as string[];
  if (item.firstName || item.lastName) haystack.push(`${item.firstName ?? ''} ${item.lastName ?? ''}`);
  return haystack.some((value) => value.toLowerCase().includes(needle));
}

export function registerLookupTools({ server, client }: ToolContext): void {
  server.registerTool(
    'weclapp_whoami',
    {
      title: 'Eigener weclapp-Nutzer',
      description: 'Zeigt den weclapp-Nutzer, dem der API-Token gehört (id, Name, E-Mail). Diese id ist "ich" bei Zuständigkeiten und Zeitbuchungen.',
      annotations: READ,
    },
    () => run(async () => {
      const user = await client.currentUser();
      return { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, username: user.username, status: user.status };
    }),
  );

  server.registerTool(
    'weclapp_lookup',
    {
      title: 'Stammdaten nachschlagen',
      description:
        'Liest Stammdaten-Listen, um einen Namen in die ID zu übersetzen, die andere Tools brauchen: Nutzer (Zuständige, Zeitbuchung), Ticketstatus, Ticket-Prioritäten, Tickettypen, Ticketkategorien, Ticketkanäle, SLAs, Pooling-Gruppen, Einheiten, Steuersätze, Artikelkategorien, Währungen, Vertragsarten, Kündigungsgründe, Abrechnungsgruppen, Leistungsorte und Kostenstellen. ' +
        'Hinweis: Antwortet weclapp bei ticketPriority mit 404, kennt der Mandant diesen Endpunkt nicht; die IDs stehen dann in bestehenden Tickets (ticketPriorityId).',
      inputSchema: z.object({
        resource: z.enum(RESOURCE_NAMES).describe('Welche Liste gelesen wird.'),
        query: z.string().optional().describe('Optionaler Suchbegriff (Teilstring in Name, Vor-/Nachname, E-Mail oder Beschreibung).'),
        pageSize: z.number().int().min(1).max(1000).optional().describe('Maximale Anzahl Einträge (Standard 200).'),
      }),
      annotations: READ,
    },
    ({ resource, query, pageSize }) => run(async () => {
      const properties = LOOKUP_RESOURCES[resource] || undefined;
      const response = await client.list<Entity>(resource, { pageSize: pageSize ?? 200, properties });
      const items = response.result ?? [];
      const result = query ? items.filter((item) => matches(item, query)) : items;
      return { resource, count: result.length, result };
    }),
  );

  server.registerTool(
    'weclapp_search_parties',
    {
      title: 'Kunden und Kontakte suchen',
      description: 'Sucht Kunden, Lieferanten und Kontakte (weclapp "party"), z. B. um die partyId für Tickets, Rechnungen oder Verträge zu finden.',
      inputSchema: z.object({
        query: z.string().optional().describe('Suchbegriff in Firmenname oder Nachname (Teilstring).'),
        customerNumber: z.string().optional().describe('Exakte Kundennummer.'),
        email: z.string().optional().describe('Exakte E-Mail-Adresse.'),
        customer: z.boolean().optional().describe('true = nur Kunden.'),
        supplier: z.boolean().optional().describe('true = nur Lieferanten.'),
        filter: filterArg,
        sort: sortArg,
        ...pagingArgs,
        allFields: allFieldsArg,
      }),
      annotations: READ,
    },
    (input) => run(() =>
      search(client, 'party', input, {
        compactFields: 'id,partyType,company,firstName,lastName,customerNumber,supplierNumber,email,phone,customer,supplier,customerBlocked',
        filters: compact({
          'customerNumber-eq': input.customerNumber,
          'email-eq': input.email,
          'customer-eq': input.customer,
          'supplier-eq': input.supplier,
        }),
        alternatives: input.query ? [{ 'company-ilike': contains(input.query) }, { 'lastName-ilike': contains(input.query) }] : undefined,
      }),
    ),
  );
}
