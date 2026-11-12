import * as z from 'zod';
import { compact, contains } from '../weclapp/format.ts';
import { READ, UPDATE, allFieldsArg, dryRunArg, fieldsArg, filterArg, idArg, pagingArgs, run, search, sortArg, toWeclappBody, versionArg, type ToolContext } from './common.ts';

const CONTRACT_STATUS = ['ACTIVE', 'DRAFT', 'INACTIVE'] as const;
const COMPACT_FIELDS = 'id,contractNumber,name,partyId,contractStatus,contractDate,startDate,endDate,unlimited,billingType,nextContractBillingDate,cancellationDate,responsibleUserId';

export function registerContractTools({ server, client, readOnly }: ToolContext): void {
  server.registerTool(
    'weclapp_search_contracts',
    {
      title: 'Verträge suchen',
      description: 'Sucht Verträge und liefert eine kompakte Übersicht (Nummer, Name, Kunde, Status, Laufzeit, nächste Abrechnung). Für Positionen und Konditionen weclapp_get_contract verwenden.',
      inputSchema: z.object({
        query: z.string().optional().describe('Suchbegriff in Vertragsname oder -nummer (Teilstring).'),
        contractNumber: z.string().optional().describe('Exakte Vertragsnummer.'),
        partyId: z.string().optional().describe('Kunde (weclapp_search_parties).'),
        contractStatus: z.enum(CONTRACT_STATUS).optional(),
        filter: filterArg,
        sort: sortArg,
        ...pagingArgs,
        allFields: allFieldsArg,
      }),
      annotations: READ,
    },
    (input) => run(() =>
      search(client, 'contract', input, {
        compactFields: COMPACT_FIELDS,
        defaultSort: 'contractNumber',
        filters: compact({
          'contractNumber-eq': input.contractNumber,
          'partyId-eq': input.partyId,
          'contractStatus-eq': input.contractStatus,
        }),
        alternatives: input.query ? [{ 'name-ilike': contains(input.query) }, { 'contractNumber-ilike': contains(input.query) }] : undefined,
      }),
    ),
  );

  server.registerTool(
    'weclapp_get_contract',
    {
      title: 'Vertrag lesen',
      description: 'Liest einen Vertrag mit allen Feldern: Positionen (contractItems), Laufzeit, Kündigungsfristen, Abrechnung, Adressen und "version" für Änderungen.',
      inputSchema: z.object({ id: idArg }),
      annotations: READ,
    },
    ({ id }) => run(() => client.get('contract', id)),
  );

  if (readOnly) return;

  server.registerTool(
    'weclapp_update_contract',
    {
      title: 'Vertrag ändern',
      description:
        'Ändert Felder eines Vertrags, z. B. Name, Status (contractStatus), Enddatum (endDate), Kündigung (cancellationDate, terminationReasonId), Verantwortlicher oder Positionen. ' +
        'Positionen (contractItems) werden als Ganzes ersetzt: vorher mit weclapp_get_contract lesen und alle bleibenden Positionen mit ihrer id mitschicken. Änderung vorher mit dem Nutzer bestätigen.',
      inputSchema: z.object({
        id: idArg,
        fields: fieldsArg('{"contractStatus": "INACTIVE", "endDate": "2026-12-31", "description": "..."}'),
        version: versionArg,
        dryRun: dryRunArg,
      }),
      annotations: UPDATE,
    },
    ({ id, fields, version, dryRun }) => run(() => client.update('contract', id, toWeclappBody(fields), { version, dryRun })),
  );
}
