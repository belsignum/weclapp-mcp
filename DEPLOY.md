# Betrieb hinter dem NGINX einer Hosting-Verwaltungsoberfläche

Diese Anleitung gilt, wenn auf deinem Server schon ein NGINX läuft, das TLS übernimmt und eine (Sub-)Domain an einen lokalen Port weiterleitet. Viele Hosting-Panels bieten das pro Domain als Option „NGINX als (SSL) Proxy → App-Server auf Port …“ an. Caddy aus der `docker-compose.yml` brauchst du dann nicht. Stattdessen nimmst du `docker-compose.nginx.yml`.

```
Client (Claude Code, Claude Desktop, Cursor)
   │  HTTPS, Authorization: Bearer <weclapp-Token>
   ▼
NGINX des Panels (TLS-Zertifikat, Domain)
   │  HTTP auf 127.0.0.1:<Port>
   ▼
Container gateway (Port nur auf 127.0.0.1) ──── reicht TCP unverändert durch
   │  internes Docker-Netz "backend"
   ▼
Container weclapp-mcp (nur im internen Netz: kein Internet, kein Zugriff auf den Server)
   │  HTTPS über CONNECT, nur zu <mandant>.weclapp.com:443
   ▼
Container gateway ──► <mandant>.weclapp.com
```

Der Gateway ist dasselbe Image wie der Server mit einem anderen Programm (`src/gateway.ts`). Er ist der einzige Weg herein und hinaus: Eingehend reicht er die Verbindungen des NGINX unverändert an den Server durch. Ausgehend lässt er nur Verbindungen zum eigenen weclapp-Mandanten zu. TLS läuft dabei Ende-zu-Ende vom Server bis weclapp, der Gateway sieht den Token nie.

Im Folgenden steht `mcp.example.com` für deine Domain und `8734` für den Port, den dein Panel anzeigt. Setze überall deine eigenen Werte ein.

Läuft der Server bei dir schon in der älteren Form (ein Container, Image `node:24-alpine`, ohne Gateway), stellst du ihn mit Abschnitt 11 um.

## 0. Vorher klären: AGB und Freigabe des Hosters

Lies die AGB deines Hosters, bevor du etwas einrichtest. Viele schränken ein:

- **Dauerhaft laufende Prozesse** („Daemons“) und eigene Software. Ein Container, der ständig läuft, fällt unter diesen Begriff, auch wenn das Panel eine Option für App-Server anbietet.
- **Änderungen an der Webserver-Konfiguration**: oft nur über die Funktionen des Panels erlaubt, alles Weitere nur nach Absprache.
- **Automatisierte Zugriffe und KI:** Manche Hoster verbieten, Panel und Kundenbereich mit Skripten oder KI-Agenten zu bedienen. Andere verbieten, Zugangsdaten, interne URLs oder Konfigurationsdaten an externe KI-Dienste weiterzugeben. Bediene Panel und Server dann selbst, und füge solche Daten nicht in einen KI-Chat ein. Diese Anleitung ist so aufgebaut, dass du jedes Ergebnis selbst auswerten kannst.
- **Backups:** häufig verlangt, dass Sicherungskopien nicht auf dem Server selbst liegen (siehe Schritt 9).

Ist etwas unklar, frag beim Support nach und lass dir die Antwort schriftlich geben, bevor du den Container startest. Diese Fragen helfen:

1. Darf auf meinem Server ein Docker-Container dauerhaft laufen, der über die Panel-Option „Proxy auf App-Server/Port“ erreichbar ist? Es geht um einen kleinen Node.js-Dienst für mich allein: ein MCP-Server, der für KI-Clients auf die weclapp-API zugreift, mit höchstens 1 CPU und 512 MB RAM.
2. Wie stellt ihr Docker bereit: `docker` und `docker compose` per SSH (rootless oder mit Gruppe `docker`), oder nur über das Panel? Darf ich Images aus einem Dockerfile selbst bauen?
3. Startet mein Container nach einem Neustart des Servers wieder von selbst (bei rootless Docker: ist „linger“ für meinen Nutzer aktiv)?
4. Darf ein Container ausgehende HTTPS-Verbindungen zu `<mandant>.weclapp.com` aufbauen? (Nur der Gateway-Container tut das, zu keinem anderen Ziel.) Für den Build kommen Docker Hub, `gcr.io` (Basis-Image) und die npm-Registry dazu.
5. Darf ich im Experten-Setup des Proxys eigene NGINX-Anweisungen eintragen (Header, Pufferung), falls das nötig wird?

## 1. Voraussetzungen auf dem Server prüfen

Per SSH auf dem Server:

```bash
docker version
docker compose version
docker info --format '{{.SecurityOptions}}'
```

- Beide Versionen erscheinen: passt. Enthält die letzte Ausgabe `rootless`, läuft Docker in deinem Nutzerkonto. Das ist für diesen Aufbau in Ordnung.
- `docker compose` fehlt oder es gibt `permission denied`: Wende dich an den Hoster. Installiere Docker nicht selbst an ihm vorbei.
- Docker gibt es nur über das Panel und nicht per SSH: Dann passt diese Anleitung nicht direkt. Das Panel braucht in dem Fall meist ein fertiges Image aus einer Registry.

Lege das Repo **außerhalb** des Web-Verzeichnisses der Domain ab, also nicht unter `htdocs`, `httpdocs` oder `public_html`.

## 2. Panel einstellen

Für die (Sub-)Domain, unter der der Server erreichbar sein soll:

1. **Domain anlegen**, falls es sie noch nicht gibt, und den DNS-Eintrag auf den Server zeigen lassen.
2. **Webserver:** die Option „NGINX als (SSL) Proxy → App-Server auf Port …“ wählen. Den angezeigten Port (hier `8734`) notierst du für `.env`. Das Panel erwartet die Anwendung auf `127.0.0.1:<Port>`, genau das macht `docker-compose.nginx.yml`.
3. **SSL-Zertifikat** einschalten, z. B. Let's Encrypt (oft im Reiter „Domain“). Wenn es angeboten wird, „HTTPS erzwingen“ und HSTS einschalten. Der weclapp-Token steht in jedem Request und darf nie unverschlüsselt übertragen werden.
4. **NGINX-Cache für diese Domain ausschalten.** Antworten von `/mcp` enthalten Daten aus deinem weclapp und dürfen nie zwischengespeichert werden. Der Server sendet zwar `Cache-Control: no-store` bzw. `no-cache`, und NGINX speichert POST-Anfragen standardmäßig nicht. Verlass dich trotzdem nicht darauf, sondern schalte den Cache aus.
5. **Webserver-Logfile:** Das übliche Access-Log von NGINX enthält IP-Adresse, Zeit, Pfad, Status und User-Agent, aber **nicht** den `Authorization`-Header mit dem Token. Für den normalen Betrieb trotzdem ausschalten (weniger personenbezogene Daten) und nur bei der Fehlersuche vorübergehend einschalten. Erlaubt das Panel ein eigenes Logformat, darf `$http_authorization` darin nie vorkommen.

Ein **Experten-Setup** mit eigenen NGINX-Anweisungen brauchst du normalerweise nicht. Ob doch, zeigt Schritt 4.

## 3. Repo holen und `.env` anlegen

```bash
git clone https://github.com/belsignum/weclapp-mcp.git ~/weclapp-mcp
```

```bash
cd ~/weclapp-mcp && cp .env.example .env && chmod 600 .env
```

In `.env` (z. B. mit `nano .env`) eintragen bzw. die Zeilen einkommentieren:

```ini
WECLAPP_TENANT=meinefirma
MCP_DOMAIN=mcp.example.com
COMPOSE_FILE=docker-compose.nginx.yml
MCP_PORT=8734
MCP_TRUST_PROXY=false
```

`COMPOSE_FILE` sorgt dafür, dass jedes `docker compose …` in diesem Ordner die NGINX-Variante nimmt und nie versehentlich Caddy startet. Der weclapp-Token gehört **nicht** in die `.env`: Der Server speichert keinen Token, jeder Client schickt seinen eigenen mit.

## 4. Einmalig prüfen, welche Header das Panel-NGINX schickt

Davon hängen zwei Einstellungen ab: der Host-Check und `MCP_TRUST_PROXY`. Statt zu raten, schaust du nach. Der Port muss dafür noch frei sein, also vor Schritt 5.

**Terminal 1, per SSH auf dem Server:** ein Wegwerf-Container, der nur Host und `X-Forwarded-For` jeder Anfrage anzeigt:

```bash
docker run --rm --init --name weclapp-header-test --read-only --cap-drop ALL --security-opt no-new-privileges --user node -p 127.0.0.1:8734:8080 node:24-alpine node -e "require('http').createServer((q,s)=>{const h=q.headers;console.log(JSON.stringify({host:h.host,'x-forwarded-for':h['x-forwarded-for']??'(fehlt)'}));s.end('ok\n')}).listen(8080)"
```

**Terminal 2, auf deinem eigenen Rechner:** eine Anfrage mit absichtlich gefälschter Absenderadresse:

```bash
curl -s -H 'X-Forwarded-For: 203.0.113.99' https://mcp.example.com/header-test
```

Antwortet `curl` mit `ok`, steht in Terminal 1 eine Zeile wie `{"host":"…","x-forwarded-for":"…"}`. Danach Terminal 1 mit Strg+C beenden.

**`host` auswerten:**

| Ausgabe `host` | Bedeutung | Was tun |
|---|---|---|
| `mcp.example.com` | NGINX reicht die Domain durch | nichts, `MCP_DOMAIN` passt |
| `127.0.0.1:8734` oder `localhost:8734` | NGINX-Standard | nichts, diese Hosts sind immer erlaubt |
| etwas anderes | ungewöhnlich | den Namen ohne Port zusätzlich eintragen: `MCP_DOMAIN=mcp.example.com,anderer-name` |

Den Host-Check schaltest du dabei nicht ab. Er lehnt weiterhin jeden Host ab, der nicht in der Liste steht.

**`x-forwarded-for` auswerten:**

| Ausgabe `x-forwarded-for` | Bedeutung | `MCP_TRUST_PROXY` |
|---|---|---|
| `(fehlt)` | NGINX setzt den Header nicht | `false` |
| genau `203.0.113.99` | NGINX reicht den Header des Clients ungeprüft durch | **`false`**, `true` wäre hier gefährlich |
| `203.0.113.99, <andere Adresse>` | NGINX hängt die echte Adresse an | `true` |
| nur `<andere Adresse>` | NGINX überschreibt den Header mit der echten Adresse | `true` |

Warum das wichtig ist: Mit `MCP_TRUST_PROXY=true` nimmt der Server den **letzten** Eintrag aus `X-Forwarded-For` als Absender. Reicht NGINX den Header unverändert durch, bestimmt den letzten Eintrag der Client. Ein Angreifer könnte dann für jeden Rateversuch eine neue Adresse erfinden und das Rate-Limit umgehen.

**Was `MCP_TRUST_PROXY=false` bedeutet:** Der Server sieht dann für alle Anfragen dieselbe Adresse, nämlich die des NGINX bzw. des Docker-Netzes. Das Rate-Limit greift weiterhin, aber für alle gemeinsam:

- Nach 10 fehlgeschlagenen Anmeldungen innerhalb von 5 Minuten werden **alle noch unbekannten Tokens** abgewiesen (`429`), von jedem Gerät aus, bis die 5 Minuten um sind.
- Ein Token, den weclapp in den letzten 24 Stunden bestätigt hat, arbeitet ungestört weiter. Im Alltag merkst du also nichts.
- Spürbar wird es nur, wenn jemand gerade Tokens rät **und** du in dieser Zeit ein neues Gerät verbindest oder der Container frisch gestartet wurde. Dann wartest du bis zu 5 Minuten.
- Der Schutz gegen Token-Raten wird dadurch nicht schwächer, eher strenger: Insgesamt sind nur 10 Fehlversuche pro 5 Minuten möglich.

Für einen Server, den nur du nutzt, ist `false` deshalb ein vertretbarer Kompromiss. `true` setzt du nur, wenn die Tabelle es ausdrücklich erlaubt.

Willst du `true`, obwohl NGINX den Header nicht setzt: Nur wenn das Panel ein Experten-Setup anbietet **und** der Hoster eigene Anweisungen dort erlaubt (Schritt 0), kannst du dafür die Option „Proxy auf Adresse“ mit `http://127.0.0.1:8734` wählen und dort eintragen:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_buffering off;
proxy_read_timeout 75s;
client_max_body_size 1m;
```

Danach Schritt 4 wiederholen. Erst wenn die Tabelle `true` erlaubt, die Einstellung umstellen.

## 5. Container starten

```bash
cd ~/weclapp-mcp && docker compose up -d --build
```

Der erste Build dauert ein bis zwei Minuten (`npm ci`, TypeScript). Danach:

```bash
docker compose ps
```

```bash
docker compose logs --tail 20
```

Erwartet: beide Container (`weclapp-mcp` und `gateway`) mit Status `healthy` und diese Zeilen:

```
[weclapp-mcp] … hört auf http://0.0.0.0:3000/mcp (Mandant: meinefirma.weclapp.com, Zeitzone Europe/Berlin, Schreiben mit Protokoll in /data/audit)
[gateway] ausgehend auf Port 3128, nur zu meinefirma.weclapp.com:443
[gateway] eingehend auf Port 3000, weiter an weclapp-mcp:3000
```

Von außen erreichbar ist nur `127.0.0.1:8734` am Gateway. Der Server selbst hat keinen veröffentlichten Port.

Warnungen wie `Your kernel does not support … limit` bei rootless Docker heißen: CPU- oder Speicherlimit greifen nicht. Der Server läuft trotzdem. Sag dem Hoster Bescheid, wenn ihm die Limits wichtig sind.

## 6. Von außen prüfen

Auf deinem eigenen Rechner:

```bash
curl -s https://mcp.example.com/health
```

Erwartet: `{"status":"ok"}`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/mcp
```

Erwartet: `401` (ohne Token kein Zugang).

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://mcp.example.com:8734/health
```

Erwartet: `000` (keine Verbindung). Der Port ist von außen nicht erreichbar.

Mit Token: Lies ihn verdeckt ein, damit er nicht in der Shell-History landet. Führe das nur auf deinem Rechner aus, nie auf dem Server:

```bash
printf 'weclapp-Token: ' && read -rs WECLAPP_TOKEN && echo && curl -s -H "Authorization: Bearer $WECLAPP_TOKEN" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}' https://mcp.example.com/mcp; unset WECLAPP_TOKEN
```

Erwartet: eine Zeile `data: {"result":{…"serverInfo":{"name":"weclapp-mcp",…}}}`.

**Abschottung prüfen** (per SSH auf dem Server). Der Befehl startet im Server-Container ein kurzes Node-Skript. Es ruft weclapp über den Gateway ab und versucht dann, andere Ziele zu erreichen:

```bash
cd ~/weclapp-mcp && docker compose exec -e T="$(grep '^WECLAPP_TENANT=' .env | cut -d= -f2).weclapp.com" weclapp-mcp /nodejs/bin/node -e "const n=require('net');const t=(h,p)=>new Promise(r=>{const s=n.connect({host:h,port:p,timeout:3000});s.on('connect',()=>{s.destroy();r('ERREICHBAR')});s.on('timeout',()=>{s.destroy();r('gesperrt (timeout)')});s.on('error',e=>r('gesperrt ('+e.code+')'))});const f=u=>fetch(u,{signal:AbortSignal.timeout(8000)}).then(x=>'HTTP '+x.status,()=>'gesperrt');(async()=>{console.log('weclapp:',await f('https://'+process.env.T+'/webapp/api/v2/user/currentUser'));console.log('example.com:',await f('https://example.com/'));console.log('1.1.1.1:443:',await t('1.1.1.1',443));console.log('docker0 172.17.0.1:22:',await t('172.17.0.1',22))})()"
```

Erwartet: `weclapp: HTTP 401` (weclapp antwortet, ohne Token eben mit 401), alle anderen Zeilen `gesperrt (…)`. Steht irgendwo `ERREICHBAR` oder `HTTP 200` bei example.com, ist die Abschottung auf diesem Server nicht wirksam: Container stoppen und den Fall melden.

## 7. Clients verbinden

Auf jedem Gerät brauchst du die URL `https://mcp.example.com/mcp` und deinen weclapp-Token. Die Konfiguration für Claude Code, Claude Desktop (über `mcp-remote`) und Cursor steht in der [README](README.md#clients-verbinden). Ersetze dort nur die URL.

## 8. Betrieb

**Updates einspielen:**

```bash
cd ~/weclapp-mcp && git pull && docker compose up -d --build
```

Die Basis-Images sind im Dockerfile und in `docker-compose.yml` per Digest festgelegt. `--pull` ist deshalb nicht nötig: Gebaut wird genau das Image, das im PR geprüft wurde.

**Wie Updates entstehen und auf den Server kommen:**

- **Dependabot** (`.github/dependabot.yml`) öffnet montags PRs für npm-Pakete, neue Digests der Basis-Images (Build-Stufe `node:24-alpine`, Laufzeit distroless, Caddy) und GitHub Actions. npm-Pakete und Actions schlägt er frühestens sieben Tage nach ihrer Veröffentlichung vor: Kompromittierte Pakete fallen meist in den ersten Tagen auf. Neue Digests der Basis-Images kommen ohne Wartezeit, sie bringen die Sicherheitsupdates von Debian, Alpine und Node.
- **Prüfen und mergen:** Jeder PR durchläuft den PR-Check (Tests, Typecheck, Docker-Build, Probelauf des Containers). Gemergt wird von Hand. Eine neue Node-Hauptversion schlägt Dependabot nicht vor; die wechselst du bewusst (das distroless-Image trägt sie im Namen, `nodejs24`).
- **Ausrollen:** nach jedem gemergten Update-PR der Befehl oben. GitHub benachrichtigt dich über neue Dependabot-PRs, das ist zugleich die Erinnerung. Richtwert: Updates der Basis-Images innerhalb einer Woche einspielen.
- **Nicht eingerichtet, mögliche nächste Stufe**, je nachdem, was der Hoster erlaubt (Schritt 0):
  - **Automatisch auf dem Server:** ein Cron-Job oder systemd-Timer, der wöchentlich `git pull --ff-only && docker compose up -d --build` ausführt. Wenig Aufwand, aber ein Dauerauftrag auf dem Server, und jeder Stand von `main` läuft ohne weiteren Blick an.
  - **Fertiges Image aus GitHub:** GitHub Actions baut das Image und legt es in die GitHub Container Registry (`ghcr.io`), der Server zieht es nur noch (`docker compose pull && docker compose up -d`). Spart den Build auf dem Server; dafür `image:` statt `build:` in den Compose-Dateien und ein Workflow mit Schreibrecht auf Pakete.

**Logs ansehen** (Start- und Fehlermeldungen, nie der Token; Docker behält höchstens 3 × 1 MB):

```bash
cd ~/weclapp-mcp && docker compose logs --tail 50
```

**Änderungsprotokoll ansehen.** Das Image hat keine Shell, `docker compose exec … sh` geht deshalb nicht. `docker compose cp` kopiert die Dateien als tar-Archiv heraus:

```bash
cd ~/weclapp-mcp && docker compose cp weclapp-mcp:/data/audit - | tar -xOf - | jq -c 'select(.phase=="begin") | {time, user: .user.name, tool, entity, entityId}'
```

**Nach einem Neustart des Servers** startet Docker den Container wieder (`restart: unless-stopped`). Bei rootless Docker gilt das nur, wenn der Docker-Dienst deines Nutzers ohne Anmeldung startet. Das klärt Frage 3 aus Schritt 0.

**Rate-Limit, Schreiblimit und die Liste bestätigter Tokens** liegen im Arbeitsspeicher. Nach einem Neustart des Containers sind sie leer.

## 9. Backup des Änderungsprotokolls

Das Protokoll liegt im Docker-Volume `weclapp-mcp_audit_data`. Sichere es **direkt auf deinen eigenen Rechner**, ohne Zwischenkopie auf dem Server. Viele Hoster-AGB verlangen das, und ein Backup auf demselben Server hilft bei einem Ausfall nicht.

Auf deinem Rechner (`benutzer@server` durch deinen SSH-Zugang ersetzen):

```bash
ssh benutzer@server 'cd ~/weclapp-mcp && docker compose cp weclapp-mcp:/data/audit -' > weclapp-audit-$(date +%F).tar
```

Zurückspielen (der Dienst ist dabei kurz gestoppt). Das Image hat kein `tar`, deshalb entpackt ein kurzlebiger `busybox`-Container ohne Netz als Laufzeitnutzer `65532` direkt ins Volume. `docker compose cp` in die Gegenrichtung taugt dafür nicht: Es setzt die Besitzer der Dateien auf root, und der Server kann danach nicht mehr schreiben.

```bash
ssh benutzer@server 'cd ~/weclapp-mcp && docker compose stop weclapp-mcp && docker run --rm -i --network none --user 65532:65532 -v weclapp-mcp_audit_data:/data busybox:1 tar -C /data -xf - && docker compose start weclapp-mcp' < weclapp-audit-JJJJ-MM-TT.tar
```

Die Sicherung enthält Vorher-/Nachher-Stände aus weclapp, aber keine Tokens. Bewahre sie trotzdem wie andere Geschäftsdaten auf.

## 10. Fehlersuche

| Symptom | Ursache und Abhilfe |
|---|---|
| `502 Bad Gateway` | Ein Container läuft nicht oder der Port stimmt nicht. Auf dem Server: `docker compose ps` (beide Container `healthy`?), dann `curl -s http://127.0.0.1:8734/health`. `MCP_PORT` muss dem Port im Panel entsprechen. |
| `403` mit `Invalid Host` | Das NGINX schickt einen Host, der nicht erlaubt ist. Schritt 4 (Tabelle `host`). |
| `403` mit `Invalid Origin` | Ein Browser oder Client schickt einen fremden `Origin`. Das ist der Schutz gegen DNS-Rebinding. Normale MCP-Clients schicken keinen `Origin`. |
| `401` | Kein oder ungültiger Token. Den Token in weclapp prüfen bzw. neu anlegen. |
| `429` | Zu viele Fehlversuche (Schritt 4, „Was `MCP_TRUST_PROXY=false` bedeutet“). Bis zu 5 Minuten warten. |
| `503` | weclapp war nicht erreichbar. `docker compose logs gateway`: Steht dort `abgelehnt: CONNECT …`, passt `WECLAPP_TENANT` nicht zum Ziel. Steht dort `nicht erreichbar`, sind ausgehende HTTPS-Verbindungen vom Server gesperrt (Schritt 0, Frage 4). |
| `413` | Request größer als 1 MB. NGINX und Server haben dieselbe Grenze. |
| Antwort bricht nach etwa 60 s ab | Server und NGINX begrenzen einen Request auf rund 60 s. weclapp-Abfragen sind normalerweise viel schneller. |
| `port is already allocated` | Ein anderer Prozess nutzt den Port, z. B. ein vergessener Header-Test: `docker stop weclapp-header-test`. |

## 11. Umstellung einer bestehenden Installation auf distroless und Gateway

Für Server, die vor diesem Umbau eingerichtet wurden: ein Container `weclapp-mcp` aus `node:24-alpine`, Port direkt am Server-Container. Danach laufen zwei Container (`weclapp-mcp`, `gateway`) in zwei Netzen, der Port hängt am Gateway. Für das Panel ändert sich nichts: Port, Domain und Zertifikat bleiben.

Was sich ändert und warum ein Handgriff nötig ist: Der Server läuft jetzt als Nutzer `65532` statt `1000`. Das Änderungsprotokoll im Volume gehört aber noch `1000`. Ohne Umstellung startet der Server nicht (`EACCES … mkdir '/data/audit'`).

Alle Schritte per SSH auf dem Server, im Ordner `~/weclapp-mcp`. Der Dienst ist zwischen Schritt 4 und 6 für etwa eine Minute nicht erreichbar.

**1. Protokoll sichern** (auf deinem eigenen Rechner, wie in Schritt 9; funktioniert mit altem und neuem Image):

```bash
ssh benutzer@server 'cd ~/weclapp-mcp && docker compose cp weclapp-mcp:/data/audit -' > weclapp-audit-vor-umstellung.tar
```

**2. Stand merken**, damit du zurückkannst:

```bash
cd ~/weclapp-mcp && git rev-parse HEAD > ~/weclapp-mcp-vorher.txt
```

**3. Neuen Stand holen und bauen.** Der alte Container läuft dabei weiter:

```bash
cd ~/weclapp-mcp && git pull && docker compose build
```

**4. Alten Container entfernen.** Das Volume mit dem Protokoll bleibt (kein `-v`):

```bash
cd ~/weclapp-mcp && docker compose down
```

**5. Volume auf den neuen Nutzer umstellen.** Ein kurzlebiger `busybox`-Container ohne Netz ändert nur die Besitzer im Volume:

```bash
docker run --rm --network none -v weclapp-mcp_audit_data:/data busybox:1 chown -R 65532:65532 /data
```

**6. Starten:**

```bash
cd ~/weclapp-mcp && docker compose up -d
```

**7. Prüfen:** Schritt 5 (`docker compose ps`: beide Container `healthy`, die drei Logzeilen) und Schritt 6 von außen, einschließlich „Abschottung prüfen“. Mit `weclapp_list_changes` in einem Client siehst du, dass die alten Einträge noch da sind.

**Zurück zum alten Stand**, falls etwas nicht läuft:

```bash
cd ~/weclapp-mcp && docker compose down && git checkout "$(cat ~/weclapp-mcp-vorher.txt)" && docker run --rm --network none -v weclapp-mcp_audit_data:/data busybox:1 chown -R 1000:1000 /data && docker compose up -d --build
```

`--build` ist dabei nötig: Ohne baut Compose das alte Image nicht neu und startet das neue, das mit dem zurückgestellten Volume nicht schreiben darf. Später wieder auf den aktuellen Stand: `git checkout main` und ab Schritt 3.

## Was getestet ist

**Stand 26.11.2026, distroless und Gateway.** Lokal mit Docker 29.3 (Docker Desktop, arm64), beide Compose-Varianten, dahinter der nachgebaute weclapp-Server:

- NGINX mit Standardeinstellungen eines Panel-Proxys (`Host: 127.0.0.1:<Port>`, kein `X-Forwarded-For`) vor dem Gateway: `/health` mit `200`, `/mcp` ohne Token mit `401`, mit Token die Tool-Liste. Rate-Limit mit `false`: 10 × `401`, danach `429`, auch mit gefälschtem `X-Forwarded-For`.
- Der Gateway reicht Header unverändert durch, `X-Forwarded-For` kommt beim Server so an, wie das NGINX es schickt (Test in `test/gateway.test.ts`). Die Bedeutung von `MCP_TRUST_PROXY` und die Tabellen aus Schritt 4 gelten deshalb weiter.
- Container: `docker compose exec … sh` scheitert, Nutzer 65532, schreibgeschütztes Dateisystem außer `/data`, Permission Model, kein `/dev/shm`, Log auf 3 × 1 MB begrenzt. Das Protokoll entsteht mit `0600`.
- Abschottung: Der Server-Container erreicht weder Dienste auf dem Host noch das Internet noch fremde Namen im DNS. Der Weg zum echten Mandanten über den Gateway funktioniert: ein ungültiger Token ergibt `401` von weclapp. Der Prüfbefehl aus Schritt 6 liefert das erwartete Ergebnis.
- Umstellung aus Abschnitt 11, Schritt für Schritt mit einem Eintrag aus dem alten Image: Ohne `chown` startet der neue Server nicht, danach mit allen Einträgen; Schreiben geht. Der Rückweg mit `--build` startet wieder das alte Image als Nutzer 1000 mit allen Einträgen. Backup und Restore aus Schritt 9 mit den neuen Befehlen: Die Rechte (`0600`, Besitzer 65532) bleiben erhalten.
- `scripts/container-check.sh` fasst diese Prüfungen zusammen und läuft bei jedem PR.

**Stand 13.11.2026, vor dem Umbau** (ein Container, `node:24-alpine`). Zwei NGINX vor dem Server, einer wie ein Panel-Proxy, einer mit dem Experten-Setup oben:

- In beiden Fällen: `/health` antwortet mit `200`, `/mcp` ohne Token mit `401`, mit fremdem `Origin` mit `403`. Mit Token liefert der Server die Tool-Liste. Bei 1,1 MB antwortet er mit `413`.
- Rate-Limit mit `false`: 10 × `401`, danach `429`. Der bestätigte Token arbeitet weiter. Ein neuer Token von einer anderen gefälschten Adresse ist gesperrt, wie oben beschrieben.
- Gegenprobe: NGINX-Standard mit `MCP_TRUST_PROXY=true`. Gefälschte Adressen umgehen das Rate-Limit vollständig (14 × `401`, nie `429`). Deshalb ist `false` voreingestellt und Schritt 4 nötig.
- Experten-Setup mit `true`: Gefälschte Adressen helfen nicht, nach 10 Versuchen kommt `429`.
- Der Header-Test aus Schritt 4 zeigt die drei typischen NGINX-Varianten (durchreichen, anhängen, überschreiben) so, wie die Tabelle sie beschreibt.
- SSE-Ereignisse kamen auch durch einen NGINX mit Standard-Pufferung ohne Verzögerung an. Der Server sendet zusätzlich `X-Accel-Buffering: no`, damit NGINX auch bei strengerer Pufferung nichts zurückhält.

Erst auf deinem Server prüfbar: was das Panel-NGINX tatsächlich schickt (Schritt 4), das Let's-Encrypt-Zertifikat, Docker ohne root (Limits, Neustart nach Reboot), ob das interne Netz dort genauso abschottet (Prüfbefehl in Schritt 6) und ausgehende Verbindungen zu weclapp.
