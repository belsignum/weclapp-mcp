# Sicherheit

Stand: 13.11.2026, Version 0.2.0, nach zwei Audits. Geprüft wurde der eigene Code dieses Repos: HTTP-Server, weclapp-Client, Tools, Änderungsprotokoll, Docker- und Caddy-Konfiguration.

**Nicht geprüft:** weclapp selbst und der VPS (Firewall, SSH, Updates). Alle Angriffe liefen gegen einen nachgebauten weclapp-Server. Am echten Mandanten lief nur ein Funktionstest mit einem Artikel, siehe „Am echten Mandanten geprüft“.

## Schutzmodell in Kurzform

- **Zugang nur mit gültigem weclapp-Token.** Jeder Request an `/mcp` braucht `Authorization: Bearer <weclapp-API-Token>`. Bevor der Server irgendetwas verarbeitet, bestätigt weclapp den Token für den fest eingestellten Mandanten. Ohne gültigen Token gibt es nur `401`, auch keine Tool-Liste.
- **Der Server speichert keinen Token.** Im Arbeitsspeicher liegt nur ein SHA-256-Hash: 5 Minuten als Cache-Schlüssel und bis zu 24 Stunden als Merkmal „von weclapp bestätigt“ (siehe Befund 12).
- **Rechte kommen von weclapp.** Der Server kann nie mehr als der Nutzer, dem der Token gehört.
- **Schreiben nur mit Protokoll.** Ohne Änderungsprotokoll (`WECLAPP_AUDIT_DIR`) bietet der Server keine Schreib-Tools an.
- **Protokoll pro Nutzer.** `weclapp_list_changes` und `weclapp_undo_change` zeigen und ändern nur Einträge des eigenen weclapp-Nutzers.
- **Schreiben ist gedeckelt.** Pro Nutzer sind höchstens 120 Schreibaktionen pro Stunde möglich (`WECLAPP_MAX_WRITES_PER_HOUR`), das Protokoll wächst höchstens auf 100 MB (`WECLAPP_AUDIT_MAX_MB`).

## Abschottung des Containers

Ziel: Wer über eine Lücke in diesem Code Befehle im Container ausführen kann, soll dort möglichst wenig vorfinden und möglichst nichts außerhalb erreichen.

- **Laufzeit-Image ohne Shell und Paketmanager** (`gcr.io/distroless/nodejs24-debian13:nonroot`): Es gibt kein `sh`, kein `apk` oder `apt`, kein `wget`. Nachladen und Ausführen von Werkzeugen ist damit deutlich schwerer. Basis-Images sind per Digest festgelegt.
- **Nutzer `nonroot` (65532)**, keine Capabilities, `no-new-privileges`, schreibgeschütztes Dateisystem; beschreibbar ist allein `/data`.
- **Node Permission Model** (`--permission`): Der Prozess darf nur den Code unter `/app` und das Protokoll unter `/data` lesen und nur `/data` beschreiben. Kindprozesse, Worker, native Addons, WASI und der Inspector sind gesperrt. Das ist eine **zusätzliche Hürde, keine Sicherheitsgrenze**: Die Node-Dokumentation beschreibt es als Sicherheitsgurt für vertrauenswürdigen Code und sagt ausdrücklich, dass bösartiger Code es umgehen kann, etwa über einen Fehler in Node selbst. Netzwerkzugriffe beschränkt es unter Node 24 nicht (`--allow-net` gibt es erst ab Node 25).
- **Ausgehend nur zum eigenen Mandanten.** Der Server-Container hängt nur im internen Docker-Netz `backend`. Docker leitet aus einem internen Netz nichts ins Internet weiter; `inhibit_ipv4` sorgt zusätzlich dafür, dass die Bridge keine Adresse des Hosts trägt. Ohne diese Option erreicht ein Container im internen Netz die Dienste des Servers weiterhin über die Gateway-Adresse des Netzes (lokal nachgestellt). Nach draußen geht es nur über den Gateway-Container (`src/gateway.ts`, dasselbe Image): Er nimmt nur `CONNECT <mandant>.weclapp.com:443` an und leitet kein Klartext-HTTP weiter. `fetch` nutzt den Proxy über `NODE_USE_ENV_PROXY=1` und `HTTPS_PROXY`; ohne diese Variable ignoriert Node 24 den Proxy (am echten Node 24.22 geprüft). In der NGINX-Variante nimmt der Gateway auch den Port auf `127.0.0.1` an, weil Docker für einen Container nur im internen Netz keinen Port veröffentlicht.

## Erstes Audit vom 13.11.2026

Jede Lücke wurde zuerst am laufenden Server nachgewiesen, dann geschlossen und mit einem Angriffstest in `test/security.test.ts` abgesichert.

| # | Befund | Schwere | Status |
|---|---|---|---|
| 1 | **Tool-Liste ohne gültigen Token.** Ein beliebiger Bearer-String genügte für `tools/list`; erst der Tool-Aufruf scheiterte an weclapp. | mittel | behoben: Token wird am Eingang gegen weclapp geprüft |
| 2 | **Kein Schutz gegen Token-Raten.** 30 falsche Tokens führten zu 30 Anfragen an weclapp, ohne Bremse. | mittel | behoben: nach 10 Fehlversuchen in 5 Minuten pro IP `429`; falsche Tokens 1 Minute im Negativ-Cache |
| 3 | **Pfad-Manipulation über die ID.** `id: ".."` machte aus `PUT /ticket/id/..` ein `PUT /ticket/`. | mittel | behoben: IDs müssen Zahlen sein (Schema und Client), fertige URL wird gegen die Basis-URL geprüft |
| 4 | **Token-Abfluss bei Weiterleitung.** Der Client folgte Redirects und schickte den `AuthenticationToken`-Header an das neue Ziel mit. | hoch, falls weclapp oder DNS kompromittiert | behoben: Redirects werden nie verfolgt |
| 5 | **`fields` konnte `id` und `version` überschreiben.** Die ID im Body wich dann von der im Pfad ab. | niedrig | behoben: `id`, `version`, `createdDate`, `lastModifiedDate` sowie `__proto__`, `constructor`, `prototype` werden verworfen |
| 6 | **Öffentliche Kommentare als Abflusskanal.** Ein manipulierter Ticket-Text (Prompt Injection) hätte die KI dazu bringen können, interne Daten als öffentlichen Kommentar an den Kunden zu schreiben. | mittel | entschärft: öffentliche Kommentare sind standardmäßig aus (`WECLAPP_ALLOW_PUBLIC_COMMENTS`) |
| 7 | **Healthcheck verriet Version und Modus.** | niedrig | behoben: nur noch `{"status":"ok"}` |
| 8 | **Kein Limit für Request-Größe und -Dauer** über die SDK-Standardwerte (4 MB) hinaus. | niedrig | behoben: 1 MB, Header-Timeout 15 s, Request-Timeout 60 s |
| 9 | **`WECLAPP_BASE_URL` akzeptierte `http://` und Zugangsdaten in der URL.** | niedrig | behoben: nur `https`, `http` nur für localhost |
| 10 | **Container:** Code gehörte dem Laufzeitnutzer, keine Ressourcenlimits. | niedrig | behoben: Code gehört root, nur `/data` ist beschreibbar, `pids_limit`, `mem_limit`, Caddy ohne unnötige Capabilities |

Geprüft und ohne Befund:

- **Filter- und Sortier-Parameter:** Werte werden URL-kodiert, fremde Parameter lassen sich nicht einschleusen. Zusätzlich gibt es jetzt eine Formatprüfung.
- **Host- und Origin-Header:** Fremde Werte führen zu `403` (Schutz vor DNS-Rebinding).
- **Abhängigkeiten:** `npm audit` meldet 0 bekannte Schwachstellen. Es gibt nur drei direkte Laufzeit-Abhängigkeiten.
- **Geheimnisse im Repo:** keine; `.env` ist von Git und vom Docker-Build ausgeschlossen.
- **Fehlermeldungen und Logs:** enthalten keinen Token. Caddy schreibt kein Access-Log.

## Zweites Audit vom 13.11.2026

Unabhängige Nachprüfung mit dem Blick eines Angreifers. Der Code wurde zuerst ohne Kenntnis des ersten Berichts gelesen, danach wurde jeder Punkt des ersten Audits gegengeprüft. Jeder Befund wurde am laufenden Server gegen den nachgebauten weclapp-Server nachgewiesen, dann behoben und mit einem Test abgesichert, der auf dem alten Stand fehlschlägt (`test/security.test.ts`, `test/audit.test.ts`, `test/limits.test.ts`, `test/deploy.test.ts`).

| # | Befund | Nachweis | Schwere | Status |
|---|---|---|---|---|
| 11 | **Rate-Limit ließ sich mit gleichzeitigen Requests überrennen.** Die Sperre wurde geprüft, bevor weclapp antwortete; gezählt wurde erst danach. Der Fix zu Befund 2 war damit wirkungslos, sobald jemand parallel statt nacheinander rät. | 200 parallele Rateversuche bei Limit 5 und 150 ms Antwortzeit: 200 Anfragen an weclapp, keine einzige `429`. | mittel | behoben: laufende Prüfungen zählen mit; derselbe Token zählt dabei nur einmal |
| 12 | **Aussperren ohne Token.** Auch Requests ganz ohne Token zählten als Fehlversuch, und die Sperre traf danach auch den gültigen Token. Eine beliebige Webseite kann den Browser des Nutzers solche Requests schicken lassen (`<img src="https://…/mcp">`, ohne `Origin`-Header) und ihn so dauerhaft aussperren. | 10 `GET /mcp` ohne Token, danach `429` für den gültigen Token. | mittel | behoben: Requests ohne wohlgeformten Token zählen nicht; ein Token, den weclapp in den letzten 24 Stunden bestätigt hat, wird vom Rate-Limit nicht gebremst |
| 13 | **Rate-Limit pro einzelner IPv6-Adresse.** Ein gewöhnlicher Anschluss hat mindestens ein /64-Netz und damit beliebig viele Adressen. Zusätzlich wurde die Sperrliste bei 10 000 Einträgen komplett geleert, also auch alle bestehenden Sperren. | 30 Rateversuche von 30 Adressen desselben /64 bei Limit 3: 30 Anfragen an weclapp. | niedrig bis mittel | behoben: IPv6 wird auf das /64 gekürzt, IPv4 in IPv6-Schreibweise auf die IPv4-Adresse; bei voller Liste fallen nur die ältesten Einträge heraus |
| 14 | **Bei einer weclapp-Störung griff das Rate-Limit nicht.** Antwortete weclapp mit `5xx` oder gar nicht, wurde der Versuch weder gezählt noch gemerkt. Über den Server ließen sich dann beliebig viele Anfragen an weclapp schicken, mit der Adresse des VPS als Absender. | 40 Requests bei Limit 3, weclapp antwortet `500`: 40 Anfragen an weclapp. | niedrig | behoben: für unbekannte Tokens zählt auch eine gescheiterte Prüfung |
| 15 | **Protokoll ließ sich aufblähen, bis der Container abstürzt.** Jede Schreibaktion protokolliert bis zu 2 × 256 kB, ohne Obergrenze für die Gesamtgröße. Gelesen wurde das Protokoll immer vollständig in den Speicher, und `weclapp_list_changes` lieferte alle Stände in voller Länge. | 100 Schreibaktionen mit großem Feld: 47 MB Protokoll. Ein `weclapp_list_changes` mit `limit: 100` danach: 47 MB Antwort, 764 MB Speicher bei 512 MB Container-Limit. | mittel (nur mit gültigem Token, etwa durch Prompt Injection oder einen Agenten in einer Schleife) | behoben: zeilenweises Lesen mit festem Speicherbedarf (273 MB im selben Versuch, davon 256 MB Grundlast des Testprozesses), große Stände fehlen in der Übersicht, Gesamtgröße über `WECLAPP_AUDIT_MAX_MB` begrenzt |
| 16 | **Massenänderungen ohne Bremse.** Ein einziger HTTP-Request kann als JSON-RPC-Batch bis zu 100 Tool-Aufrufe enthalten; eine serverseitige Grenze für Schreibaktionen gab es nicht. | Ein Request, 100 Zeitbuchungen. | mittel | entschärft: höchstens `WECLAPP_MAX_WRITES_PER_HOUR` Schreibaktionen pro Nutzer und Stunde (Standard 120). Rückgängig hat ein eigenes, gleich großes Kontingent; `dryRun` zählt nicht |
| 17 | **Datumsangaben wurden falsch statt gar nicht gelesen.** `Date.parse` nimmt fast alles: `01.12.2026` wurde zum 12. Januar 2026, `Ticket 5` zum Mai 2001, der 31. Februar zum 3. März. Solche Werte landeten ohne Fehlermeldung in Vertragsenden, Fälligkeiten und Zeitbuchungen. | `toEpochMs("01.12.2026")` ergibt den 12.01.2026. | mittel (Datenintegrität) | behoben: nur noch ISO-8601 und Epoch-Millisekunden, mit Prüfung des Kalendertags |
| 18 | **Dieselbe Änderung ließ sich mehrfach gleichzeitig zurücksetzen.** Geschützt hat allein die Versionsprüfung von weclapp. Wo sie nicht greift, liefen parallele Undo-Aufrufe alle durch. | 3 parallele `weclapp_undo_change` auf eine Zeitbuchung ohne `version`: 3 Schreibzugriffe, 3 Protokolleinträge. | niedrig | behoben: pro Änderung läuft nur ein Rückgängig-Vorgang |
| 19 | **Kleinere Härtungen.** (a) Mit `MCP_TRUST_PROXY` wurde jeder beliebige Text aus `X-Forwarded-For` als Schlüssel fürs Rate-Limit übernommen. (b) Bereits vorhandene Protokolldateien behielten zu offene Rechte (`0644`). (c) Protokollzeilen mit unerwarteten Typen wurden ungeprüft fürs Rückgängigmachen verwendet, und eine zweite `begin`-Zeile mit derselben ID konnte einen Eintrag einem anderen Nutzer zuschlagen. (d) `GET //` führte zu `500`. (e) Schlug nach einem erfolgreichen Undo nur der Vermerk im Protokoll fehl, meldete das Tool einen Fehler. | (a) bis (d) einzeln nachgestellt, (e) aus dem Code abgeleitet | niedrig | behoben: (a) nur gültige IP-Adressen, sonst die Adresse der Verbindung; (b) `0600` beim Start; (c) Typprüfung, die erste Zeile zu einer ID gilt; (d) `400`; (e) Erfolg mit Warnung |
| 20 | **Caddy-Container lief uneingeschränkt.** Anders als der Server-Container hatte er ein beschreibbares Dateisystem und weder Speicher- noch Prozesslimit. Dabei ist Caddy der einzige Container, der aus dem Internet erreichbar ist. | `docker inspect` am laufenden Compose-Aufbau: `ReadonlyRootfs=false`, `Memory=0`, kein `PidsLimit`. | niedrig | behoben: `read_only`, `pids_limit: 200`, `mem_limit: 256m`; beschreibbar sind nur die Volumes für Zertifikate und Caddys Konfiguration. Im Compose-Aufbau geprüft: TLS und Weiterleitung laufen, Speicherbedarf im Leerlauf 15 MB |

### Gegenprüfung des ersten Audits

- **Befund 2 (Token-Raten) war nicht dicht:** siehe 11, 13 und 14. Die damalige Lösung hatte außerdem die Nebenwirkung aus Befund 12.
- **Befunde 1, 3, 4, 5, 7, 9** halten: Code gelesen, die Angriffstests des ersten Audits laufen weiter. Zusätzlich versucht: Pfade wie `//`, `/mcp/`, `/health/../mcp` und eine absolute URL in der Request-Zeile sowie `fields` in `weclapp_book_time` mit `id`, `version`, fremdem Nutzer und fremdem Ticket.
- **Befund 6 (öffentliche Kommentare)** hält: `visibility` in anderer Schreibweise, zusätzliche Argumente wie `publicComment: true` und der Weg über `fields` anderer Tools führen nicht zu einem öffentlichen Kommentar.
- **Befund 8 (Request-Größe)** hält, auch ohne `Content-Length` (chunked). Der zugehörige Test war allerdings vom Timing abhängig und schlug fehl, wenn die Testdatei allein lief; er ist jetzt deterministisch.
- **Befund 10 (Container)** hält für den Server-Container, siehe „Docker-Aufbau“. Für den Caddy-Container war er unvollständig: siehe 20.

### Geprüft und ohne Befund

- **Tief verschachtelte Eingaben** (100 000 Ebenen in `fields`): Fehlerergebnis statt Absturz, der Server läuft weiter.
- **Abbruch der Verbindung mitten in einer Schreibaktion:** Die Änderung wird zu Ende geführt und vollständig protokolliert.
- **Wettlauf zwischen Schreiben und Rückgängig** auf demselben Datensatz: Der Server schreibt mit der zuvor gelesenen `version`; weclapp lehnt den Verlierer ab.
- **Fremde Protokolleinträge:** nicht lesbar und nicht rücksetzbar; fremde und unbekannte IDs sind nicht unterscheidbar.
- **Nur-Lesen-Modus:** Schreib-Tools und `weclapp_undo_change` sind nicht aufrufbar, auch nicht mit `dryRun`.
- **Sitzungen und Streams:** Der Server ist zustandslos. Eine mitgeschickte Session-ID wird ignoriert, `GET` und `DELETE` enden mit `405`, es gibt keine offenen Streams, die einen Token-Widerruf überdauern.
- **Browser-Zugriffe:** Der Server sendet keine CORS-Header, eine fremde Webseite kann also keinen Request mit `Authorization`-Header absetzen. `Origin: null` wird abgelehnt.
- **Lieferkette:** `npm audit` meldet 0 Schwachstellen; alle 40 Pakete im Lockfile stammen von registry.npmjs.org, haben eine Prüfsumme und keine Installationsskripte.
- **Fehlermeldungen:** enthalten keinen Token.

### Docker-Aufbau

Gebaut wurde das Image aus dem `Dockerfile`, gestartet die `docker-compose.yml` dieses Repos mit Caddy. Nur für den Test ersetzt: weclapp durch den nachgebauten Server (im Netzwerk des Server-Containers) und die Ports auf dem Testrechner. Das Zertifikat für `mcp.localhost` kam aus Caddys interner Zertifizierungsstelle.

- **Server-Container:** läuft als Nutzer `node` ohne Capabilities und mit `no-new-privileges`. Das Dateisystem ist schreibgeschützt, auch `/tmp` und das Home-Verzeichnis; beschreibbar ist nur `/data`. Die Protokolldatei entsteht mit `0600` in einem Verzeichnis mit `0700`. Port 3000 ist vom Host aus nicht erreichbar.
- **Über Caddy:** `/health` antwortet mit den Sicherheits-Headern, andere Pfade mit `404`, `/mcp` ohne Token mit `401` und mit fremdem `Origin` mit `403`. Mit Token: Tool-Liste und eine protokollierte Zeitbuchung. Ein Request mit 1,1 MB endet mit `413`.
- **Rate-Limit hinter Caddy:** 14 Rateversuche, jeder mit einem anderen gefälschten `X-Forwarded-For`: 10 × `401`, danach `429`, genau 10 Token-Prüfungen bei weclapp. `X-Real-IP` und `Forwarded` ändern daran nichts. Der bestätigte Token arbeitet von derselben Adresse weiter; ein zweiter Client mit eigener Adresse ist nicht gesperrt.
- **Fremder `Host`-Header:** Caddy beantwortet ihn selbst mit einer leeren Antwort. Der Server bekommt die Anfrage nicht zu sehen.

### Am echten Mandanten geprüft

Ein Funktionstest, kein Angriff: `scripts/smoke-article.ts` startet den Server lokal und legt über die MCP-Tools einen inaktiven Testartikel an.

- **Anmeldung:** Der erste Lauf endete mit `503`. weclapp verpackt die Antwort von `/user/currentUser` in `{ result: … }`, der nachgebaute Server tat das nicht. Der Server hielt deshalb jede Antwort für unbrauchbar und ließ auch gültige Tokens nicht herein. Eine Lücke war das nicht, aber am echten weclapp war der Server so nicht benutzbar. Behoben im weclapp-Client; der nachgebaute Server antwortet jetzt wie das Original.
- **`dryRun` beim Anlegen eines Artikels:** weclapp prüft die Daten und speichert nichts.
- **Anlegen, Lesen, Rückgängig:** Der Artikel wurde angelegt, gelesen und über `weclapp_undo_change` wieder gelöscht; danach antwortet weclapp mit `404`. Im Protokoll stehen beide Schritte, der Token nicht.

### Nicht geprüft

- **Der Rest am echten Mandanten:** Tickets, Zeitbuchungen, Verträge und Rechnungen liefen nur gegen den nachgebauten Server. Offen ist damit, ob `dryRun` auch bei Änderungen nichts speichert, ob die Versionsprüfung bei jedem Datentyp greift, welche Ticket-Felder der Kunde zu sehen bekommt und wann weclapp E-Mails verschickt.
- **Zertifikat von Let's Encrypt:** Der Docker-Aufbau lief lokal mit Caddys interner Zertifizierungsstelle. Ob Caddy mit schreibgeschütztem Dateisystem auch ein echtes Zertifikat abruft und erneuert, zeigt erst der VPS. Zertifikate liegen in `/data`; dieses Volume bleibt beschreibbar.

## Verbleibende Risiken

- **Prompt Injection ist nicht vollständig lösbar.** Ticket-Texte, Kommentare und Namen stammen teils von Kunden. Der Server weist das Modell an, sie als Daten zu behandeln (auch direkt im Ergebnis von `weclapp_get_ticket`), erzwingen kann er es nicht. Was ein präparierter Text im schlimmsten Fall erreicht, wenn das Modell ihm folgt und der Client nicht nachfragt:
  - **Ändern:** bis zu 120 Schreibaktionen pro Stunde im Rahmen der Rechte des Tokens, also Tickets, Verträge, Artikel und Zeitbuchungen ändern sowie interne Kommentare schreiben. Ganze Datensätze löschen kann er nur, wenn sie zuvor über diesen Server angelegt wurden; Listeneinträge wie Vertragspositionen oder Preise lassen sich über eine Änderung entfernen. Alles steht im Protokoll und lässt sich zurücksetzen.
  - **Lesen:** alles, was der Token lesen darf. Der Server kann nicht verhindern, dass ein Client diese Daten über ein *anderes* Werkzeug nach außen gibt (Web-Zugriff, E-Mail). Das ist der wahrscheinlichste Abflussweg.
  - **Abfluss über weclapp selbst (Vermutung, nicht prüfbar):** Öffentliche Kommentare sind gesperrt. Felder, die der Kunde trotzdem zu sehen bekommt, etwa der Ticket-Betreff im Kundenportal, die Zuordnung eines Tickets zu einem anderen Kunden oder Artikeltexte auf Belegen, sind es nicht. Sie zu sperren würde das Bearbeiten von Tickets und Artikeln entwerten.
  - Dagegen helfen: Bestätigungen im Client nicht pauschal abschalten, ein weclapp-Nutzer mit genau den nötigen Rechten, `WECLAPP_READ_ONLY=true` wo Schreiben nicht nötig ist, ein knapperes `WECLAPP_MAX_WRITES_PER_HOUR`.
- **Wer den Token hat, hat den Zugriff.** Der Token liegt in der Client-Konfiguration jedes Geräts. Bei Verlust eines Geräts den Token in weclapp löschen; spätestens 5 Minuten später ist er auch hier wertlos.
- **Aussperren ist nur noch im Ausnahmefall möglich:** Nach einem Neustart des Containers ist kein Token „bekannt“. Laufen genau dann von derselben Adresse 10 Fehlversuche auf, wartet auch der richtige Token bis zu 5 Minuten.
- **Verteiltes Raten** über sehr viele Adressen wird nicht global begrenzt. Eine globale Sperre könnte jeder auslösen und damit den einzigen Nutzer aussperren. Ein weclapp-Token ist eine zufällige UUID; Raten ist aussichtslos, es kostet nur Anfragen.
- **`MCP_TRUST_PROXY` gehört nur hinter einen eigenen Proxy.** Ist der Port des Containers zusätzlich direkt erreichbar, kann jeder die Absenderadresse fälschen, das Rate-Limit umgehen und fremde Adressen sperren. Die mitgelieferte Compose-Datei veröffentlicht den Port nicht. `docker-compose.nginx.yml` veröffentlicht ihn nur auf `127.0.0.1` und setzt `MCP_TRUST_PROXY=false` als Voreinstellung. `true` ist dort nur richtig, wenn das vorgeschaltete NGINX `X-Forwarded-For` selbst setzt oder ergänzt (DEPLOY.md, Schritt 4). Reicht es den Header des Clients durch, umgehen gefälschte Adressen das Rate-Limit vollständig; im lokalen Test nachgestellt.
- **Rate-Limit, Schreiblimit und Cache liegen im Arbeitsspeicher** und gelten pro Container. Nach einem Neustart sind sie leer.
- **Ein volles Protokoll sperrt das Schreiben.** Das ist Absicht (ohne Protokoll keine Änderung), braucht dann aber einen Eingriff: `WECLAPP_AUDIT_MAX_MB` erhöhen oder alte Monatsdateien sichern und entfernen. Bei normaler Nutzung sind 100 MB in der Aufbewahrungsfrist nicht zu erreichen.
- **Das Protokoll ist manipulierbar, wenn der VPS kompromittiert ist.** Es ist ein Arbeitsprotokoll mit Undo, kein revisionssicheres Archiv.
- **Statusänderungen an Tickets** können je nach weclapp-Einstellung E-Mails an Kunden auslösen. Das steuert weclapp, nicht dieser Server.
- **Basis-Images** sind per Tag (`node:24-alpine`, `caddy:2-alpine`) und nicht per Digest festgelegt.

## Empfehlungen für den Betrieb

- Einen eigenen weclapp-Nutzer mit genau den nötigen Rechten für den Token verwenden.
- Den Server nur über Caddy oder ein NGINX auf demselben Server erreichbar machen; Port 3000 nie zusätzlich veröffentlichen, in der NGINX-Variante nur auf `127.0.0.1`.
- Vor größeren geplanten Sammeländerungen `WECLAPP_MAX_WRITES_PER_HOUR` vorübergehend erhöhen, danach zurücksetzen.
- Auf dem VPS nur die Ports 80, 443 und SSH öffnen; SSH nur mit Schlüssel.
- Das Volume `audit_data` in die Backups aufnehmen.
- Regelmäßig aktualisieren: `git pull && docker compose build --pull && docker compose up -d`.

## Schwachstelle melden

Bitte nicht als öffentliches Issue, sondern vertraulich über GitHub: im Repo unter **Security** → **Report a vulnerability** ([direkt zum Formular](https://github.com/belsignum/weclapp-mcp/security/advisories/new)). Die Meldung sehen nur die Betreiber dieses Repos.
