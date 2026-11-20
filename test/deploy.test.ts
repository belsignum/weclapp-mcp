import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/** Abschnitt eines Dienstes aus einer Compose-Datei (ohne YAML-Bibliothek: Text bis zum nächsten Dienst). */
async function service(name: string, file = 'docker-compose.yml'): Promise<string> {
  const compose = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const start = compose.indexOf('\nservices:');
  const end = compose.search(/\n(networks|volumes):/);
  const services = compose.slice(start, end === -1 ? undefined : end);
  const match = services.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)`));
  assert.ok(match, `Dienst ${name} fehlt in ${file}`);
  return match[1];
}

const HARDENING = ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'pids_limit:', 'mem_limit:'];

test('Compose: beide Container laufen eingeschränkt, auch der aus dem Internet erreichbare Caddy', async () => {
  for (const name of ['weclapp-mcp', 'caddy']) {
    const block = await service(name);
    for (const setting of HARDENING) {
      assert.ok(block.includes(setting), `${name}: "${setting}" fehlt`);
    }
  }
});

test('Compose: nur Caddy veröffentlicht Ports, der Server ist allein über Caddy erreichbar', async () => {
  assert.doesNotMatch(await service('weclapp-mcp'), /^\s*ports:/m);
  assert.match(await service('caddy'), /^\s*ports:/m);
});

test('Compose hinter vorhandenem NGINX: gleiche Härtung, Audit-Volume, kein Caddy', async () => {
  const file = 'docker-compose.nginx.yml';
  const block = await service('weclapp-mcp', file);
  for (const setting of [...HARDENING, 'audit_data:/data', 'cpus:', 'max-size:']) {
    assert.ok(block.includes(setting), `${file}: "${setting}" fehlt`);
  }
  await assert.rejects(service('caddy', file), /fehlt/);
});

test('Compose hinter vorhandenem NGINX: Port nur auf 127.0.0.1, X-Forwarded-For standardmäßig nicht vertraut', async () => {
  const block = await service('weclapp-mcp', 'docker-compose.nginx.yml');
  const ports = [...block.matchAll(/^\s*- "([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => p.endsWith(':3000'));
  assert.equal(ports.length, 1, 'genau eine Portfreigabe erwartet');
  // Die Adresse steht fest im Text, nicht in einer Variablen, die .env überschreiben könnte
  assert.match(ports[0], /^127\.0\.0\.1:\$\{MCP_PORT:\?[^}]*\}:3000$/);
  assert.match(block, /MCP_TRUST_PROXY: \$\{MCP_TRUST_PROXY:-false\}/);
  assert.doesNotMatch(block, /^\s*expose:/m);
});
