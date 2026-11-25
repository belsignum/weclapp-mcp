/**
 * Minimaler Nachbau der weclapp-API v2 für Tests.
 * Zeichnet alle Requests auf und hält pro Instanz einen eigenen, veränderbaren Datenbestand.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | undefined;
  body: unknown;
}

export const VALID_TOKENS = new Set(['token-anna', 'token-ben']);

const USERS: Record<string, { id: string; firstName: string; lastName: string; email: string }> = {
  'token-anna': { id: '100', firstName: 'Anna', lastName: 'Admin', email: 'anna@example.com' },
  'token-ben': { id: '200', firstName: 'Ben', lastName: 'Support', email: 'ben@example.com' },
};

type Row = Record<string, unknown> & { id: string };

interface Condition {
  field: string;
  operator: string;
  value: string;
}

const OPERATORS = ['notilike', 'notlike', 'notnull', 'notin', 'ilike', 'like', 'null', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'in'];

/** Zerlegt "feld-operator" bzw. "or-feld-operator" / "or<Gruppe>-feld-operator" (ODER-Gruppe). */
function parseFilterKey(key: string): { group: string | undefined; field: string; operator: string } | undefined {
  const operator = OPERATORS.find((candidate) => key.endsWith(`-${candidate}`));
  if (!operator) return undefined;
  const field = key.slice(0, -(operator.length + 1));
  const or = /^or([A-Za-z0-9]*)-(.+)$/.exec(field);
  return or ? { group: or[1], field: or[2], operator } : { group: undefined, field, operator };
}

function like(pattern: string, flags: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

function matches(row: Row, { field, operator, value }: Condition): boolean {
  const actual = row[field];
  const empty = actual === undefined || actual === null;
  const list = () => (JSON.parse(value) as unknown[]).map(String);
  switch (operator) {
    case 'null': return empty;
    case 'notnull': return !empty;
    case 'eq': return !empty && String(actual) === value;
    case 'ne': return empty || String(actual) !== value;
    case 'lt': return !empty && Number(actual) < Number(value);
    case 'gt': return !empty && Number(actual) > Number(value);
    case 'le': return !empty && Number(actual) <= Number(value);
    case 'ge': return !empty && Number(actual) >= Number(value);
    case 'like': return !empty && like(value, '').test(String(actual));
    case 'ilike': return !empty && like(value, 'i').test(String(actual));
    case 'notlike': return empty || !like(value, '').test(String(actual));
    case 'notilike': return empty || !like(value, 'i').test(String(actual));
    case 'in': return !empty && list().includes(String(actual));
    case 'notin': return empty || !list().includes(String(actual));
    default: return true;
  }
}

function seed(): Record<string, Row[]> {
  return {
    article: [{ id: '1', articleNumber: 'A-1000', name: 'Wartungsstunde', articleType: 'SERVICE', active: true, unitId: '7', version: '3', lastModifiedDate: 1767225600000 }],
    salesInvoice: [{ id: '10', invoiceNumber: 'RE-2026-001', invoiceDate: 1767225600000, status: 'OPEN_ITEM_CREATED', paymentStatus: 'OPEN', grossAmount: '119.00', customerId: '50' }],
    ticket: [{ id: '20', ticketNumber: 'T-42', subject: 'Drucker streikt', ticketStatusId: '1', partyId: '50', version: '5' }],
    ticketStatus: [
      { id: '1', name: 'Neu', internalTicketStatus: 'UNASSIGNED' },
      { id: '2', name: 'In Arbeit', internalTicketStatus: 'IN_PROGRESS' },
      { id: '3', name: 'Erledigt', internalTicketStatus: 'CLOSED' },
    ],
    ticketPriority: [
      { id: '8', name: 'Hoch', active: true, positionNumber: 1 },
      { id: '9', name: 'Normal', active: true, positionNumber: 2 },
    ],
    comment: [{ id: '30', entityName: 'ticket', entityId: '20', comment: 'Toner getauscht', privateComment: true, publicComment: false }],
    timeRecord: [{ id: '40', ticketId: '20', userId: '100', startDate: 1767225600000, durationSeconds: 1800, billableDurationSeconds: 1800 }],
    contract: [
      {
        id: '60',
        contractNumber: 'V-7',
        name: 'Wartungsvertrag',
        contractStatus: 'ACTIVE',
        partyId: '50',
        version: '2',
        contractItems: [
          { id: '601', title: 'Wartung', quantity: '1', version: '0', createdDate: 1767225600000 },
          { id: '602', title: 'Hotline', quantity: '1', version: '0', createdDate: 1767225600000 },
        ],
      },
    ],
    party: [{ id: '50', company: 'Muster GmbH', customerNumber: 'K-1', customer: true }],
    unit: [{ id: '7', name: 'Stunde' }, { id: '8', name: 'Stück' }],
  };
}

export async function startMockWeclapp() {
  const requests: RecordedRequest[] = [];
  const data = seed();
  let nextId = 1000;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const token = req.headers['authenticationtoken'] as string | undefined;
    const path = url.pathname.replace(/^\/webapp\/api\/v2/, '');
    requests.push({ method: req.method ?? 'GET', path, query: Object.fromEntries(url.searchParams), token, body: raw ? JSON.parse(raw) : undefined });

    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    if (!token || !VALID_TOKENS.has(token)) return send(401, { title: 'Unauthorized', status: 401 });
    // wie das echte weclapp: der Nutzer steckt in { result: … } (am Mandanten nachgesehen)
    if (path === '/user/currentUser') return send(200, { result: USERS[token] });

    const single = path.match(/^\/(\w+)\/id\/([^/]+)$/);
    const list = path.match(/^\/(\w+)$/);
    const entity = single?.[1] ?? list?.[1];
    if (!entity || !data[entity]) return send(404, { title: 'Not Found', status: 404, detail: `unknown path ${path}` });
    const rows = data[entity];
    const dryRun = url.searchParams.get('dryRun') === 'true';

    if (req.method === 'GET' && single) {
      const item = rows.find((e) => e.id === single[2]);
      return item ? send(200, item) : send(404, { title: 'Not Found', status: 404, detail: `${entity} ${single[2]} not found` });
    }
    if (req.method === 'GET' && list) {
      // Filter, ODER-Gruppen ("or-…"), Sortierung und Paging wirken wie in der API-Doku beschrieben,
      // ebenso die Zuordnung von Kommentaren (entityName, entityId)
      const all: Condition[] = [];
      const anyOf = new Map<string, Condition[]>();
      for (const [key, value] of url.searchParams) {
        if (entity === 'comment' && (key === 'entityName' || key === 'entityId')) {
          all.push({ field: key, operator: 'eq', value });
          continue;
        }
        const parsed = parseFilterKey(key);
        if (!parsed) continue;
        const condition = { field: parsed.field, operator: parsed.operator, value };
        if (parsed.group === undefined) all.push(condition);
        else anyOf.set(parsed.group, [...(anyOf.get(parsed.group) ?? []), condition]);
      }
      let result = rows.filter((row) => all.every((c) => matches(row, c)) && [...anyOf.values()].every((group) => group.some((c) => matches(row, c))));
      const sort = url.searchParams.get('sort');
      if (sort) {
        const keys = sort.split(',').map((part) => ({ field: part.replace(/^-/, ''), direction: part.startsWith('-') ? -1 : 1 }));
        result = result.slice().sort((a, b) => {
          for (const { field, direction } of keys) {
            const [x, y] = [a[field] as string | number, b[field] as string | number];
            if (x !== y) return (x < y ? -1 : 1) * direction;
          }
          return 0;
        });
      }
      // Standard 100 Einträge, höchstens 1000 (API-Doku, "Pagination")
      const pageSize = Math.min(Number(url.searchParams.get('pageSize') ?? 100), 1000);
      const page = Number(url.searchParams.get('page') ?? 1);
      return send(200, { result: result.slice((page - 1) * pageSize, page * pageSize) });
    }
    if (req.method === 'POST' && list) {
      const body = JSON.parse(raw || '{}');
      const invalid = (location: string, detail: string) =>
        send(400, { title: 'entity validation failed', status: 400, detail, validationErrors: [{ location, detail, title: detail }] });
      if (entity === 'article' && !body.articleNumber) return invalid('articleNumber', 'must not be empty');
      if (entity === 'ticket') {
        if (!body.subject) return invalid('subject', 'must not be empty');
        if (body.partyId !== undefined && !data.party.some((party) => party.id === body.partyId)) return invalid('partyId', 'referenced entity not found');
        // Wie am echten Mandanten im Probelauf beobachtet (24.11.2026): keine Standard-Priorität, und ohne Statusangabe
        // gilt "nicht zugewiesen", wozu keine Zuweisung passt
        if (!body.ticketPriorityId) return invalid('ticketPriorityId', 'value must not be empty');
        const status = data.ticketStatus.find((entry) => entry.id === (body.ticketStatusId ?? '1'));
        if (body.assignedUserId != null && status?.internalTicketStatus === 'UNASSIGNED') {
          return invalid('assignedUserId', 'assigned user must be null for internal ticket status: UNASSIGNED');
        }
      }
      // Status, Kanal und billable füllt weclapp selbst, wenn sie fehlen (ebenfalls im Probelauf beobachtet)
      const defaults = entity === 'ticket' ? { ticketStatusId: '1', ticketChannelId: '12', billable: true } : {};
      // Im Probelauf antwortet weclapp mit 200 und ohne id, version, createdDate und lastModifiedDate (API-Doku, "Dry-Run"),
      // beim Ticket auch ohne Ticketnummer
      if (dryRun) return send(200, { ...defaults, ...body });
      if (entity === 'ticket') Object.assign(defaults, { ticketNumber: `T-${nextId}` });
      const created: Row = { ...defaults, ...body, id: String(nextId), version: '0' };
      nextId += 1;
      rows.push(created);
      return send(201, created);
    }
    if (req.method === 'PUT' && single) {
      const index = rows.findIndex((e) => e.id === single[2]);
      if (index === -1) return send(404, { title: 'Not Found', status: 404 });
      const item = rows[index];
      const body = JSON.parse(raw || '{}');
      if (body.version && item.version && body.version !== item.version) {
        return send(409, { title: 'optimistic lock error', status: 409, detail: 'entity was modified' });
      }
      // Listeneinträge ohne id bekommen wie in weclapp eine neue
      for (const [key, value] of Object.entries(body)) {
        if (Array.isArray(value)) body[key] = value.map((entry) => (entry && typeof entry === 'object' && !('id' in entry) ? { ...entry, id: String(nextId++), version: '0' } : entry));
      }
      const updated: Row = { ...item, ...body, id: item.id, version: String(Number(item.version ?? 0) + 1) };
      for (const [key, value] of Object.entries(updated)) if (value === null) delete updated[key];
      if (!dryRun) rows[index] = updated;
      return send(200, updated);
    }
    if (req.method === 'DELETE' && single) {
      const index = rows.findIndex((e) => e.id === single[2]);
      if (index === -1) return send(404, { title: 'Not Found', status: 404 });
      rows.splice(index, 1);
      return send(204);
    }
    return send(405, { title: 'Method Not Allowed', status: 405 });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/webapp/api/v2`,
    requests,
    data,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
