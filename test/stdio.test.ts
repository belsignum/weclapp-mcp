import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { startMockWeclapp } from './mock-weclapp.ts';

test('stdio-Start: Token aus WECLAPP_TOKEN, ohne Protokoll nur lesend', async () => {
  const mock = await startMockWeclapp();
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/stdio.ts', import.meta.url))],
        env: { ...getDefaultEnvironment(), WECLAPP_BASE_URL: mock.baseUrl, WECLAPP_TOKEN: 'token-ben' },
        stderr: 'ignore',
      }),
    );
    const { tools } = await client.listTools();
    assert.equal(tools.length, 12);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
    const result = await client.callTool({ name: 'weclapp_whoami', arguments: {} });
    const first = (result.content as Array<{ text: string }>)[0];
    assert.equal(JSON.parse(first.text).firstName, 'Ben');
    assert.ok(mock.requests.every((r) => r.token === 'token-ben'));
  } finally {
    await client.close();
    await mock.close();
  }
});

test('stdio-Start mit WECLAPP_AUDIT_DIR: Schreib-Tools mit lokalem Protokoll', async () => {
  const { mkdtemp, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const mock = await startMockWeclapp();
  const dir = await mkdtemp(join(tmpdir(), 'weclapp-mcp-stdio-'));
  const client = new Client({ name: 'test', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('../src/stdio.ts', import.meta.url))],
        env: { ...getDefaultEnvironment(), WECLAPP_BASE_URL: mock.baseUrl, WECLAPP_TOKEN: 'token-ben', WECLAPP_AUDIT_DIR: dir },
        stderr: 'ignore',
      }),
    );
    assert.equal((await client.listTools()).tools.length, 21);
    const result = await client.callTool({ name: 'weclapp_update_ticket', arguments: { id: '20', fields: { subject: 'lokal geändert' } } });
    assert.ok(!result.isError);
    assert.equal((await readdir(dir)).length, 1);
  } finally {
    await client.close();
    await mock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
