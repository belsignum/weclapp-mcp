#!/usr/bin/env bash
# Probelauf des Docker-Aufbaus (NGINX-Variante mit Gateway) samt Prüfung der Abschottung.
# Läuft im PR-Check und lokal: scripts/container-check.sh
# Braucht Docker mit Compose und curl. Startet das Compose-Projekt "weclapp-mcp-check" und räumt es danach ab.
# weclapp ersetzt der Nachbau aus test/mock-weclapp.ts im Netzwerk des Server-Containers; nach draußen geht nichts.
set -uo pipefail
shopt -s extglob
cd "$(dirname "$0")/.."

PROJECT=weclapp-mcp-check
PORT=${CHECK_PORT:-18734}
HOST_PORT=19999
NODE_IMAGE=$(sed -n 's/^FROM \(node:[^ ]*\) AS build$/\1/p' Dockerfile)
TMP=$(mktemp -d)
export WECLAPP_TENANT=check MCP_DOMAIN=mcp.localhost MCP_PORT=$PORT

cat > "$TMP/override.yml" <<EOF
services:
  weclapp-mcp:
    environment:
      WECLAPP_BASE_URL: http://localhost:4000/webapp/api/v2
  mock:
    image: $NODE_IMAGE
    network_mode: service:weclapp-mcp
    volumes: ["$PWD/test:/w/test:ro"]
    command: ["node", "--input-type=module", "-e", "import net from 'node:net'; import { startMockWeclapp } from '/w/test/mock-weclapp.ts'; const m = await startMockWeclapp(); const p = Number(new URL(m.baseUrl).port); net.createServer((c) => { const u = net.connect(p, '127.0.0.1'); c.pipe(u).pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); }).listen(4000, '127.0.0.1');"]
EOF

dc() { docker compose -p "$PROJECT" -f docker-compose.nginx.yml -f "$TMP/override.yml" "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1
  docker rm -f "$PROJECT-hostdienst" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

failed=0
# check <Beschreibung> <erwartet (Glob-Muster)> <erhalten>
check() {
  if [[ "$3" == $2 ]]; then echo "ok      $1: $3"; else echo "FEHLER  $1: erwartet $2, erhalten: $3"; failed=1; fi
}
mcp() {
  curl -s -m 10 -H 'Host: mcp.localhost' -H 'Authorization: Bearer token-anna' -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' -d "$1" "http://127.0.0.1:$PORT/mcp"
}

echo "== Aufbau starten"
if ! dc up -d --build --wait --wait-timeout 120; then
  dc ps; dc logs --tail 30; exit 1
fi

echo "== Funktion über den Gateway"
check "Healthcheck" '{"status":"ok"}' "$(curl -s -m 5 "http://127.0.0.1:$PORT/health")"
check "/mcp ohne Token" 401 "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Host: mcp.localhost' "http://127.0.0.1:$PORT/mcp")"
check "Tool-Liste" 29 "$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | grep -o '"name":"weclapp_[a-z_]*"' | wc -l | tr -d ' ')"
check "Schreiben mit Protokoll" '*changeId*' "$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"weclapp_update_article","arguments":{"id":"1","fields":{"name":"Probelauf"}}}}' | head -c 300)"
# tar im Node-Image (busybox), damit die Ausgabe überall gleich aussieht
check "Protokolldatei (docker compose cp)" '-rw------- 65532/65532' "$(dc cp weclapp-mcp:/data/audit - 2>/dev/null | docker run --rm -i --network none "$NODE_IMAGE" tar -tvf - | grep jsonl | awk '{print $1, $2}')"

echo "== Container"
check "Shell im Server" '*executable file not found*' "$(dc exec -T weclapp-mcp sh -c id 2>&1)"
check "Shell im Gateway" '*executable file not found*' "$(dc exec -T gateway sh -c id 2>&1)"
for service in weclapp-mcp gateway; do
  id=$(dc ps -q "$service")
  check "$service: Nutzer, Dateisystem, Capabilities" '65532:65532 true \[ALL\] *no-new-privileges*' \
    "$(docker inspect "$id" --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}')"
  check "$service: kein /dev/shm, Log begrenzt" 'none 1m 3' \
    "$(docker inspect "$id" --format '{{.HostConfig.IpcMode}} {{index .HostConfig.LogConfig.Config "max-size"}} {{index .HostConfig.LogConfig.Config "max-file"}}')"
done
cmdline='process.stdout.write(require("fs").readFileSync("/proc/1/cmdline","utf8").split("\0").join(" "))'
check "Server läuft mit Permission Model" '*--permission --allow-fs-read=/app --allow-fs-read=/data --allow-fs-write=/data dist/http.js*' \
  "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$cmdline")"
write='const fs=require("fs");const t=p=>{try{fs.writeFileSync(p,"x");fs.rmSync(p);return "ok"}catch(e){return e.code}};console.log(t("/app/x"),t("/tmp/x"),t("/data/x"))'
check "Schreiben außerhalb von /data" 'EROFS EROFS ok' "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$write")"

echo "== Netz"
docker run -d --rm --name "$PROJECT-hostdienst" --network host "$NODE_IMAGE" \
  node -e "require('http').createServer((q,s)=>s.end('host')).listen($HOST_PORT,'0.0.0.0')" >/dev/null
sleep 2
host_ip=$(docker network inspect "${PROJECT}_default" --format '{{(index .IPAM.Config 0).Gateway}}')
# Erste Adresse im internen Netz: Ohne inhibit_ipv4 trägt sie die Bridge, also der Host
backend_first=$(docker network inspect "${PROJECT}_backend" --format '{{(index .IPAM.Config 0).Subnet}}' | sed -E 's|\.0/[0-9]+$|.1|')
probe='const n=require("net"),h=require("http");
const tcp=(a,p)=>new Promise(r=>{const s=n.connect({host:a,port:p,timeout:3000});s.on("connect",()=>{s.destroy();r("erreichbar")});s.on("timeout",()=>{s.destroy();r("gesperrt")});s.on("error",()=>r("gesperrt"))});
const viaGateway=t=>new Promise(r=>{const q=h.request({host:"gateway",port:3128,method:"CONNECT",path:t,timeout:5000});q.on("connect",(res,s)=>{s.destroy();r(String(res.statusCode))});q.on("error",e=>r(e.code));q.on("timeout",()=>{q.destroy();r("timeout")});q.end()});
(async()=>{const [mode,...targets]=process.argv.slice(1);for(const t of targets){const [a,p]=t.split(":");console.log(mode==="connect"?await viaGateway(t):await tcp(a,Number(p)))}})()'
# Gegenprobe: Der Gateway hängt im normalen Netz und erreicht den Dienst auf dem Host. So zeigt der Test, dass er Erreichbarkeit erkennt.
check "Gegenprobe: Gateway erreicht Dienst auf dem Host" erreichbar "$(dc exec -T gateway /nodejs/bin/node -e "$probe" tcp "$host_ip:$HOST_PORT")"
check "Server: Dienst auf dem Host ($backend_first, Netz backend)" gesperrt "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" tcp "$backend_first:$HOST_PORT")"
check "Server: Dienst auf dem Host ($host_ip, normales Netz)" gesperrt "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" tcp "$host_ip:$HOST_PORT")"
check "Server: Dienst auf dem Host (docker0)" gesperrt "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" tcp "172.17.0.1:$HOST_PORT")"
check "Server: Internet direkt (1.1.1.1:443)" gesperrt "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" tcp 1.1.1.1:443)"
lookup='require("dns").lookup("example.com",(e,a)=>console.log(e?e.code:a))'
check "Server: DNS für fremde Namen" '*EAI_AGAIN*' "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$lookup")"
check "Gateway: CONNECT example.com:443" 403 "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" connect example.com:443)"
check "Gateway: CONNECT Mandant, falscher Port" 403 "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" connect check.weclapp.com:22)"
# Freigegeben: 200, wenn weclapp antwortet, 502, wenn der Name nicht auflöst. Beides heißt: nicht abgelehnt.
check "Gateway: CONNECT Mandant:443" '@(200|502)' "$(dc exec -T weclapp-mcp /nodejs/bin/node -e "$probe" connect check.weclapp.com:443)"

echo
if [[ $failed -ne 0 ]]; then
  echo "Probelauf mit Fehlern."; dc logs --tail 20; exit 1
fi
echo "Probelauf ohne Befund."
