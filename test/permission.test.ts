import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connect, json } from './helpers.ts';
import { startMockWeclapp } from './mock-weclapp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

/**
 * Node-Optionen aus dem CMD des Dockerfiles, damit der Test genau das prüft, was im Container läuft.
 * /app wird zum Repo, /data zu einem Temp-Verzeichnis.
 */
async function permissionFlags(data: string): Promise<string[]> {
  const dockerfile = await readFile(join(ROOT, 'Dockerfile'), 'utf8');
  const cmd = dockerfile.match(/^CMD (\[.*\])$/m);
  assert.ok(cmd, 'CMD in Exec-Form fehlt');
  const args = JSON.parse(cmd[1]) as string[];
  assert.equal(args.at(-1), 'dist/http.js');
  return args.slice(0, -1).map((arg) => arg.replace(/=\/app$/, `=${ROOT}`).replace(/=\/data$/, `=${data}`));
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('Dockerfile: Server läuft mit Permission Model, ohne Kindprozesse und Worker', async () => {
  const flags = await permissionFlags('/data');
  assert.ok(flags.includes('--permission'));
  assert.deepEqual(flags.filter((f) => f.startsWith('--allow-fs-write')), ['--allow-fs-write=/data']);
  assert.deepEqual(flags.filter((f) => f.startsWith('--allow-fs-read')).sort(), [`--allow-fs-read=${ROOT}`, '--allow-fs-read=/data'].sort());
  for (const forbidden of ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi', '--allow-inspector']) {
    assert.ok(!flags.some((f) => f.startsWith(forbidden)), `${forbidden} darf nicht gesetzt sein`);
  }
});

test('Permission Model: der HTTP-Server startet, liest, schreibt und protokolliert mit den Rechten aus dem Dockerfile', async () => {
  const mock = await startMockWeclapp();
  const data = await realpath(await mkdtemp(join(tmpdir(), 'weclapp-mcp-perm-')));
  const port = await freePort();
  const child = spawn(process.execPath, [...(await permissionFlags(data)), join(ROOT, 'src/http.ts')], {
    env: { PATH: process.env.PATH, PORT: String(port), HOST: '127.0.0.1', WECLAPP_BASE_URL: mock.baseUrl, WECLAPP_AUDIT_DIR: join(data, 'audit') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (chunk: Buffer) => (log += chunk.toString()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startet nicht:\n${log}`)), 15_000);
      child.stderr.on('data', () => log.includes('hört auf') && (clearTimeout(timer), resolve()));
      child.on('exit', (code) => (clearTimeout(timer), reject(new Error(`Server beendet (${code}):\n${log}`))));
    });
    assert.match(log, /Schreiben mit Protokoll in .*\/audit/);

    const client = await connect(`http://127.0.0.1:${port}`, 'token-anna');
    try {
      assert.equal((await client.listTools()).tools.length, 29);
      const changed = json(await client.callTool({ name: 'weclapp_update_article', arguments: { id: '1', fields: { name: 'unter --permission' } } }));
      assert.equal(changed.result.name, 'unter --permission');
      const changes = json(await client.callTool({ name: 'weclapp_list_changes', arguments: {} }));
      assert.equal(changes.result[0].changeId, changed.changeId);
    } finally {
      await client.close();
    }
    assert.equal((await readdir(join(data, 'audit'))).length, 1);
    assert.doesNotMatch(log, /ERR_ACCESS_DENIED/);
  } finally {
    child.kill();
    await mock.close();
    await rm(data, { recursive: true, force: true });
  }
});

test('Permission Model: außerhalb von Code und /data weder lesen noch schreiben, keine Kindprozesse, keine Worker', async () => {
  const data = await realpath(await mkdtemp(join(tmpdir(), 'weclapp-mcp-perm-')));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'weclapp-mcp-outside-')));
  await writeFile(join(outside, 'geheim.txt'), 'geheim');
  const probe = `
    const fs = require('node:fs');
    const attempt = (fn) => { try { fn(); return 'erlaubt'; } catch (e) { return e.code; } };
    console.log(JSON.stringify({
      readCode: attempt(() => fs.readFileSync(${JSON.stringify(join(ROOT, 'package.json'))})),
      writeData: attempt(() => fs.writeFileSync(${JSON.stringify(join(data, 'probe'))}, 'x')),
      readOutside: attempt(() => fs.readFileSync(${JSON.stringify(join(outside, 'geheim.txt'))})),
      writeOutside: attempt(() => fs.writeFileSync(${JSON.stringify(join(outside, 'neu.txt'))}, 'x')),
      writeCode: attempt(() => fs.writeFileSync(${JSON.stringify(join(ROOT, 'permission-probe.tmp'))}, 'x')),
      readEtc: attempt(() => fs.readFileSync('/etc/passwd')),
      childProcess: attempt(() => require('node:child_process').spawnSync('/bin/sh', ['-c', 'id'])),
      worker: attempt(() => new (require('node:worker_threads').Worker)('1', { eval: true })),
    }));`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [...(await permissionFlags(data)), '-e', probe]);
    assert.deepEqual(JSON.parse(stdout), {
      readCode: 'erlaubt',
      writeData: 'erlaubt',
      readOutside: 'ERR_ACCESS_DENIED',
      writeOutside: 'ERR_ACCESS_DENIED',
      writeCode: 'ERR_ACCESS_DENIED',
      readEtc: 'ERR_ACCESS_DENIED',
      childProcess: 'ERR_ACCESS_DENIED',
      worker: 'ERR_ACCESS_DENIED',
    });
  } finally {
    await rm(data, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    await rm(join(ROOT, 'permission-probe.tmp'), { force: true });
  }
});
