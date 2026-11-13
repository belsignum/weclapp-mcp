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
    if (path === '/user/currentUser') return send(200, USERS[token]);

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
    if (req.method === 'GET' && list) return send(200, { result: rows });
    if (req.method === 'POST' && list) {
      const body = JSON.parse(raw || '{}');
      if (entity === 'article' && !body.articleNumber) {
        return send(400, { title: 'validation error', status: 400, validationErrors: [{ location: 'articleNumber', detail: 'must not be empty' }] });
      }
      const created: Row = { ...body, id: String(nextId), version: '0' };
      if (!dryRun) {
        nextId += 1;
        rows.push(created);
      }
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
