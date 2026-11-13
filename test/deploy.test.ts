import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Abschnitt eines Dienstes aus docker-compose.yml (ohne YAML-Bibliothek: Text bis zum nächsten Dienst). */
async function service(name: string): Promise<string> {
  const compose = await readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  const services = compose.slice(compose.indexOf('\nservices:'), compose.indexOf('\nnetworks:'));
  const match = services.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)`));
  assert.ok(match, `Dienst ${name} fehlt in docker-compose.yml`);
  return match[1];
}

test('Compose: beide Container laufen eingeschränkt, auch der aus dem Internet erreichbare Caddy', async () => {
  for (const name of ['weclapp-mcp', 'caddy']) {
    const block = await service(name);
    for (const setting of ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'pids_limit:', 'mem_limit:']) {
      assert.ok(block.includes(setting), `${name}: "${setting}" fehlt`);
    }
  }
});

test('Compose: nur Caddy veröffentlicht Ports, der Server ist allein über Caddy erreichbar', async () => {
  assert.doesNotMatch(await service('weclapp-mcp'), /^\s*ports:/m);
  assert.match(await service('caddy'), /^\s*ports:/m);
});
