import * as z from 'zod';
import { compact, contains, toEpochMs } from '../weclapp/format.ts';
import { READ, allFieldsArg, filterArg, idArg, pagingArgs, run, search, sortArg, type ToolContext } from './common.ts';

const STATUS = ['NEW', 'ENTRY_COMPLETED', 'DOCUMENT_CREATED', 'OPEN_ITEM_CREATED', 'CANCELLED'] as const;
const PAYMENT_STATUS = ['OPEN', 'PAID', 'NO_OPEN_ITEM', 'CLEARED_WITH_CREDIT_NOTE', 'CREDIT_NOTE_CLEARED', 'UNKNOWN'] as const;
const INVOICE_TYPES = ['STANDARD_INVOICE', 'CREDIT_NOTE', 'FINAL_INVOICE', 'PART_PAYMENT_INVOICE', 'ADVANCE_PAYMENT_INVOICE', 'PREPAYMENT_INVOICE', 'RETAIL_INVOICE'] as const;

const COMPACT_FIELDS = 'id,invoiceNumber,salesInvoiceType,invoiceDate,dueDate,customerId,status,paymentStatus,paid,netAmount,grossAmount,recordCurrencyId,salesOrderId,responsibleUserId';

export function registerInvoiceTools({ server, client }: ToolContext): void {
  server.registerTool(
    'weclapp_search_sales_invoices',
    {
      title: 'Ausgangsrechnungen suchen',
      description: 'Sucht Ausgangsrechnungen und Gutschriften und liefert eine kompakte Übersicht (Nummer, Datum, Kunde, Status, Beträge). Für Positionen und Adressen weclapp_get_sales_invoice verwenden.',
      inputSchema: z.object({
        invoiceNumber: z.string().optional().describe('Rechnungsnummer (Teilstring).'),
        customerId: z.string().optional().describe('Kunde als partyId (weclapp_search_parties).'),
        status: z.enum(STATUS).optional(),
        paymentStatus: z.enum(PAYMENT_STATUS).optional().describe('OPEN = offen, PAID = bezahlt.'),
        salesInvoiceType: z.enum(INVOICE_TYPES).optional(),
        invoiceDateFrom: z.string().optional().describe('Rechnungsdatum ab (ISO-8601, z. B. 2026-01-01).'),
        invoiceDateTo: z.string().optional().describe('Rechnungsdatum bis einschließlich (ISO-8601).'),
        filter: filterArg,
        sort: sortArg,
        ...pagingArgs,
        allFields: allFieldsArg,
      }),
      annotations: READ,
    },
    (input) => run(() => {
      const to = input.invoiceDateTo ? toEpochMs(input.invoiceDateTo, 'invoiceDateTo') : undefined;
      return search(client, 'salesInvoice', input, {
        compactFields: COMPACT_FIELDS,
        defaultSort: '-invoiceDate',
        filters: compact({
          'invoiceNumber-ilike': input.invoiceNumber ? contains(input.invoiceNumber) : undefined,
          'customerId-eq': input.customerId,
          'status-eq': input.status,
          'paymentStatus-eq': input.paymentStatus,
          'salesInvoiceType-eq': input.salesInvoiceType,
          'invoiceDate-ge': input.invoiceDateFrom ? toEpochMs(input.invoiceDateFrom, 'invoiceDateFrom') : undefined,
          // "bis" inklusive des ganzen Tages, wenn nur ein Datum angegeben ist
          'invoiceDate-le': to !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(input.invoiceDateTo!.trim()) ? to + 86_399_999 : to,
        }),
      });
    }),
  );

  server.registerTool(
    'weclapp_get_sales_invoice',
    {
      title: 'Ausgangsrechnung lesen',
      description: 'Liest eine Ausgangsrechnung mit allen Feldern: Positionen (salesInvoiceItems), Adressen, Beträge, Zahlungsstatus und Statusverlauf.',
      inputSchema: z.object({ id: idArg }),
      annotations: READ,
    },
    ({ id }) => run(() => client.get('salesInvoice', id)),
  );
}
