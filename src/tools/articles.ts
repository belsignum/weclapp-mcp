import * as z from 'zod';
import { compact, contains } from '../weclapp/format.ts';
import {
  CREATE,
  READ,
  UPDATE,
  allFieldsArg,
  dryRunArg,
  fieldsArg,
  filterArg,
  idArg,
  pagingArgs,
  run,
  search,
  sortArg,
  toWeclappBody,
  versionArg,
  type ToolContext,
} from './common.ts';

const ARTICLE_TYPES = ['BASIC', 'STORABLE', 'SERVICE', 'SERVICE_QUOTA', 'SALES_BILL_OF_MATERIAL', 'SHIPPING_COST', 'PACKAGING_UNIT', 'LOADING_EQUIPMENT', 'LOADING_EQUIPMENT_STORABLE'] as const;
const TAX_RATE_TYPES = ['STANDARD', 'REDUCED', 'SLIGHTLY_REDUCED', 'SUPER_REDUCED', 'ZERO'] as const;

const COMPACT_FIELDS = 'id,articleNumber,name,articleType,active,unitId,ean,manufacturerPartNumber,articleCategoryId,taxRateType,lastModifiedDate';

const articlePricesArg = z
  .array(z.record(z.string(), z.unknown()))
  .optional()
  .describe('Verkaufspreise, z. B. [{"price": "49.90", "currencyId": "<EUR-id>", "salesChannel": "NET1", "priceScaleType": "SCALE_FROM", "priceScaleValue": "0"}]. Währungs-ID über weclapp_lookup resource=currency.');

export function registerArticleTools({ server, client, readOnly }: ToolContext): void {
  server.registerTool(
    'weclapp_search_articles',
    {
      title: 'Artikel suchen',
      description: 'Sucht Artikel (Produkte und Dienstleistungen) und liefert eine kompakte Übersicht. Für alle Details eines Artikels weclapp_get_article verwenden.',
      inputSchema: z.object({
        query: z.string().optional().describe('Suchbegriff in Name oder Artikelnummer (Teilstring, Groß-/Kleinschreibung egal).'),
        articleNumber: z.string().optional().describe('Exakte Artikelnummer.'),
        active: z.boolean().optional().describe('true = nur aktive, false = nur inaktive Artikel.'),
        articleType: z.enum(ARTICLE_TYPES).optional(),
        articleCategoryId: z.string().optional().describe('Artikelkategorie (weclapp_lookup resource=articleCategory).'),
        filter: filterArg,
        sort: sortArg,
        ...pagingArgs,
        allFields: allFieldsArg,
      }),
      annotations: READ,
    },
    (input) => run(() =>
      search(client, 'article', input, {
        compactFields: COMPACT_FIELDS,
        defaultSort: 'articleNumber',
        filters: compact({
          'articleNumber-eq': input.articleNumber,
          'active-eq': input.active,
          'articleType-eq': input.articleType,
          'articleCategoryId-eq': input.articleCategoryId,
        }),
        alternatives: input.query ? [{ 'name-ilike': contains(input.query) }, { 'articleNumber-ilike': contains(input.query) }] : undefined,
      }),
    ),
  );

  server.registerTool(
    'weclapp_get_article',
    {
      title: 'Artikel lesen',
      description: 'Liest einen Artikel mit allen Feldern, inklusive Preisen (articlePrices) und dem Feld "version" für spätere Änderungen.',
      inputSchema: z.object({ id: idArg }),
      annotations: READ,
    },
    ({ id }) => run(() => client.get('article', id)),
  );

  if (readOnly) return;

  server.registerTool(
    'weclapp_create_article',
    {
      title: 'Artikel anlegen',
      description:
        'Legt einen neuen Artikel an. Vorher mit weclapp_search_articles (articleNumber) prüfen, dass es ihn noch nicht gibt, und Nummer, Name, Typ, Einheit und Preise mit dem Nutzer bestätigen.',
      inputSchema: z.object({
        articleNumber: z.string().min(1).describe('Artikelnummer, eindeutig im Mandanten.'),
        name: z.string().min(1).max(300).describe('Artikelname.'),
        articleType: z.enum(ARTICLE_TYPES).describe('BASIC = Ware ohne Lagerführung, STORABLE = Lagerartikel, SERVICE = Dienstleistung, SALES_BILL_OF_MATERIAL = Stückliste, SHIPPING_COST = Versandkosten.'),
        unitId: z.string().min(1).describe('Einheit, z. B. Stück oder Stunde (weclapp_lookup resource=unit).'),
        taxRateType: z.enum(TAX_RATE_TYPES).default('STANDARD').describe('Steuersatz-Art; STANDARD = voller Satz (19 % in DE), REDUCED = ermäßigt.'),
        description: z.string().optional().describe('Beschreibung (HTML erlaubt).'),
        active: z.boolean().optional().describe('Standard: true.'),
        availableInSale: z.boolean().optional().describe('true = in Verkaufsbelegen verfügbar.'),
        articleCategoryId: z.string().optional(),
        ean: z.string().optional(),
        manufacturerPartNumber: z.string().optional(),
        articlePrices: articlePricesArg,
        fields: z.record(z.string(), z.unknown()).optional().describe('Weitere Artikelfelder mit ihren weclapp-Namen, z. B. {"shortDescription1": "...", "manufacturerId": "812"}.'),
        dryRun: dryRunArg,
      }),
      annotations: CREATE,
    },
    ({ fields, dryRun, ...known }) => run(() => client.create('article', toWeclappBody({ ...fields, ...known }), dryRun)),
  );

  server.registerTool(
    'weclapp_update_article',
    {
      title: 'Artikel ändern',
      description:
        'Ändert Felder eines Artikels, z. B. Name, Beschreibung, EAN, aktiv/inaktiv oder Preise. Vorher mit weclapp_get_article lesen, dem Nutzer die Änderung zeigen und bestätigen lassen. ' +
        'Preise stehen in der Liste articlePrices und werden als Ganzes ersetzt: alle Preise mitschicken, die bleiben sollen (bestehende mit id).',
      inputSchema: z.object({
        id: idArg,
        fields: fieldsArg('{"name": "Neuer Name", "active": false, "description": "<p>...</p>"}'),
        version: versionArg,
        dryRun: dryRunArg,
      }),
      annotations: UPDATE,
    },
    ({ id, fields, version, dryRun }) => run(() => client.update('article', id, toWeclappBody(fields), { version, dryRun })),
  );
}
