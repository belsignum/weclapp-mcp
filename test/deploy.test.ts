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

/** Oberste Ebene "networks:" einer Compose-Datei. */
async function networks(file: string): Promise<string> {
  const compose = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const match = compose.match(/\nnetworks:\n([\s\S]*?)(?=\n\S|$)/);
  assert.ok(match, `networks fehlt in ${file}`);
  return match[1];
}

const HARDENING = ['read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'pids_limit:', 'mem_limit:'];
const FILES = ['docker-compose.yml', 'docker-compose.nginx.yml'];

test('Compose: alle Container laufen eingeschränkt, auch der aus dem Internet erreichbare Caddy und der Gateway', async () => {
  for (const name of ['weclapp-mcp', 'gateway', 'caddy']) {
    const block = await service(name);
    for (const setting of HARDENING) {
      assert.ok(block.includes(setting), `${name}: "${setting}" fehlt`);
    }
  }
});

test('Compose: nur Caddy veröffentlicht Ports, der Server ist allein über Caddy erreichbar', async () => {
  assert.doesNotMatch(await service('weclapp-mcp'), /^\s*ports:/m);
  assert.doesNotMatch(await service('gateway'), /^\s*ports:/m);
  assert.match(await service('caddy'), /^\s*ports:/m);
});

test('Compose hinter vorhandenem NGINX: gleiche Härtung, Audit-Volume, kein Caddy', async () => {
  const file = 'docker-compose.nginx.yml';
  for (const name of ['weclapp-mcp', 'gateway']) {
    const block = await service(name, file);
    for (const setting of [...HARDENING, 'cpus:', 'max-size:']) {
      assert.ok(block.includes(setting), `${file}, ${name}: "${setting}" fehlt`);
    }
  }
  assert.ok((await service('weclapp-mcp', file)).includes('audit_data:/data'));
  await assert.rejects(service('caddy', file), /fehlt/);
});

test('Compose hinter vorhandenem NGINX: Port nur auf 127.0.0.1 und nur am Gateway, X-Forwarded-For standardmäßig nicht vertraut', async () => {
  const file = 'docker-compose.nginx.yml';
  const server = await service('weclapp-mcp', file);
  const gateway = await service('gateway', file);
  assert.doesNotMatch(server, /^\s*(ports|expose):/m);
  const ports = [...gateway.matchAll(/^\s*- "([^"]+)"\s*$/gm)].map((m) => m[1]).filter((p) => p.endsWith(':3000'));
  assert.equal(ports.length, 1, 'genau eine Portfreigabe erwartet');
  // Die Adresse steht fest im Text, nicht in einer Variablen, die .env überschreiben könnte
  assert.match(ports[0], /^127\.0\.0\.1:\$\{MCP_PORT:\?[^}]*\}:3000$/);
  assert.match(gateway, /INGRESS_TARGET: weclapp-mcp:3000/);
  assert.match(server, /MCP_TRUST_PROXY: \$\{MCP_TRUST_PROXY:-false\}/);
});

test('Compose: Server nur im internen Netz ohne Adresse des Hosts, ausgehend nur über den Gateway zum Mandanten', async () => {
  for (const file of FILES) {
    const backend = (await networks(file)).match(/\n?  backend:\n((?:    .*\n?)*)/)?.[1] ?? '';
    assert.match(backend, /^    internal: true$/m, `${file}: backend nicht intern`);
    assert.match(backend, /com\.docker\.network\.bridge\.inhibit_ipv4: "true"/, `${file}: Bridge hätte eine Adresse des Hosts`);

    const server = await service('weclapp-mcp', file);
    assert.match(server, /^    networks: \[backend\]$/m, `${file}: Server darf nur im internen Netz hängen`);
    assert.match(server, /NODE_USE_ENV_PROXY: "1"/);
    assert.match(server, /HTTPS_PROXY: http:\/\/gateway:3128/);
    // Der Healthcheck fragt 127.0.0.1 und darf nicht über den Gateway laufen
    assert.match(server, /NO_PROXY: [^\n]*127\.0\.0\.1/);

    const gateway = await service('gateway', file);
    assert.match(gateway, /^    networks: \[backend, default\]$/m);
    assert.match(gateway, /EGRESS_ALLOW: \$\{WECLAPP_TENANT:\?[^}]*\}\.weclapp\.com:443$/m);
    assert.match(gateway, /command: \["--permission", "--allow-fs-read=\/app", "dist\/gateway\.js"\]/);
    assert.doesNotMatch(gateway, /allow-fs-write|volumes:/, `${file}: der Gateway braucht keinen beschreibbaren Ort`);
  }
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
