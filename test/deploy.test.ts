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

test('Dockerfile: Laufzeit-Image ohne Shell, Basis-Images per Digest, Laufzeitnutzer nonroot', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(images.length, 2, 'Build- und Laufzeit-Stufe erwartet');
  for (const image of images) assert.match(image, /:[\w.-]+@sha256:[0-9a-f]{64}$/, `${image}: Tag und Digest erwartet`);
  assert.match(images[1], /^gcr\.io\/distroless\/nodejs24-debian\d+:nonroot@/);
  assert.match(dockerfile, /npm ci --ignore-scripts/);

  // Laufzeit-Stufe ohne Kommentarzeilen
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ')).replace(/^#.*\n/gm, '');
  // distroless hat keine Shell: RUN, Shell-Form und wget gingen dort ins Leere
  assert.doesNotMatch(runtime, /^RUN /m);
  assert.doesNotMatch(runtime, /wget|curl/);
  assert.match(runtime, /^HEALTHCHECK [^\n]*\\\n\s+CMD \["\/nodejs\/bin\/node",/m, 'Healthcheck in Exec-Form mit Node');
  assert.match(runtime, /^CMD \[/m, 'CMD in Exec-Form');
  assert.equal(runtime.match(/^USER .*$/gm)?.at(-1), 'USER 65532:65532');
  assert.match(runtime, /^COPY --from=build --chown=65532:65532 \/out\/ \/$/m, '/data mit Besitzer nonroot aus der Build-Stufe');
});
