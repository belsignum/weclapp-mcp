import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { startMockWeclapp } from './mock-weclapp.ts';

test('stdio-Start: Token aus WECLAPP_TOKEN, Tools funktionieren', async () => {
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
    assert.equal(tools.length, 19);
    const result = await client.callTool({ name: 'weclapp_whoami', arguments: {} });
    const first = (result.content as Array<{ text: string }>)[0];
    assert.equal(JSON.parse(first.text).firstName, 'Ben');
    assert.ok(mock.requests.every((r) => r.token === 'token-ben'));
  } finally {
    await client.close();
    await mock.close();
  }
});
