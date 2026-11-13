import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { AuditLog } from '../src/audit.ts';
import { createHttpServer, type HttpOptions } from '../src/http.ts';

export type ToolResult = Awaited<ReturnType<Client['callTool']>>;

/** Startet den MCP-HTTP-Server gegen ein Mock-weclapp, mit Änderungsprotokoll in einem Temp-Verzeichnis. */
export async function startMcp(baseUrl: string, overrides: Partial<HttpOptions> & { withAudit?: boolean } = {}) {
  const { withAudit = true, ...options } = overrides;
  const dir = withAudit ? await mkdtemp(join(tmpdir(), 'weclapp-mcp-audit-')) : undefined;
  const audit = dir ? await AuditLog.open(dir) : undefined;
  const { server, close } = createHttpServer({ baseUrl, readOnly: false, allowPublicComments: false, audit, allowedHosts: [], log: () => {}, ...options });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    auditDir: dir,
    close: async () => {
      audit?.close();
      await close();
      if (dir) await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function connect(url: string, token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

export function text(result: ToolResult): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? '';
}

export function json(result: ToolResult): any {
  assert.ok(!result.isError, `Tool-Fehler: ${text(result)}`);
  return JSON.parse(text(result));
}

/** Roher JSON-RPC-Aufruf ohne MCP-Client, für Angriffstests. */
export async function rawPost(url: string, options: { token?: string; headers?: Record<string, string>; body?: string } = {}) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(options.token !== undefined ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    },
    body: options.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}
