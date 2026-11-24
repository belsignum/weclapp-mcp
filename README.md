# weclapp-mcp

MCP-Server für [weclapp](https://www.weclapp.com) auf Basis der REST-API v2. Er gibt KI-Clients wie Claude Code, Claude Desktop oder Cursor Zugriff auf:

- **Artikel** lesen, anlegen, bearbeiten
- **Ausgangsrechnungen** lesen
- **Helpdesk-Tickets** lesen, anlegen, bearbeiten, kommentieren, Zeiten buchen und korrigieren
- **Verträge** lesen und bearbeiten

Der Server speichert **keinen** weclapp-Token. Jeder Request bringt den Token als `Authorization: Bearer <weclapp-API-Token>` mit. Der Server lässt ihn von weclapp bestätigen, bevor er irgendetwas verarbeitet, und handelt dann in weclapp mit genau deinen Rechten. Zeitbuchungen landen automatisch bei dir.

Jede Schreibaktion landet in einem **Änderungsprotokoll** und lässt sich mit einem Tool **rückgängig machen**.

## Tools

| Bereich | Tool | Art |
|---|---|---|
| Allgemein | `weclapp_whoami` – eigener weclapp-Nutzer | lesen |
| | `weclapp_lookup` – Stammdaten (Nutzer, Ticketstatus, Einheiten, Steuern, Vertragsarten …) | lesen |
| | `weclapp_search_parties` – Kunden und Kontakte | lesen |
| Artikel | `weclapp_search_articles`, `weclapp_get_article` | lesen |
| | `weclapp_create_article`, `weclapp_update_article` | schreiben |
| Rechnungen | `weclapp_search_sales_invoices`, `weclapp_get_sales_invoice` | lesen |
| Tickets | `weclapp_search_tickets`, `weclapp_get_ticket` (inkl. Kommentare und Zeiten), `weclapp_list_time_records` | lesen |
| | `weclapp_create_ticket`, `weclapp_update_ticket`, `weclapp_add_ticket_comment`, `weclapp_book_time`, `weclapp_update_time_record` | schreiben |
| Verträge | `weclapp_search_contracts`, `weclapp_get_contract` | lesen |
| | `weclapp_update_contract` | schreiben |
| Protokoll | `weclapp_list_changes` – eigene Änderungen mit Vorher/Nachher | lesen |
| | `weclapp_undo_change` – eine eigene Änderung rückgängig machen | schreiben |

Es gibt bewusst keine Lösch-Tools und keinen freien API-Zugriff. Mit `WECLAPP_READ_ONLY=true` werden alle Schreib-Tools ausgeblendet. Jedes Schreib-Tool kennt `dryRun: true`: weclapp prüft die Änderung dann, ohne sie zu speichern.

Pro Nutzer sind höchstens **120 Schreibaktionen pro Stunde** möglich (`WECLAPP_MAX_WRITES_PER_HOUR`, `0` = unbegrenzt). Das bremst Massenänderungen, etwa wenn ein manipulierter Ticket-Text die KI in eine Schleife schickt. Rückgängig-Aktionen haben ein eigenes, gleich großes Kontingent, `dryRun` zählt nicht. Für eine geplante Sammeländerung den Wert vorübergehend erhöhen.

Datumsangaben nimmt der Server nur als ISO-8601 an (`2026-11-12` oder `2026-11-12T09:30:00+01:00`). Andere Schreibweisen wie `12.11.2026` lehnt er ab, statt sie zu erraten.

Kommentare sind standardmäßig nur intern möglich. Für Kunden sichtbare Kommentare schaltest du mit `WECLAPP_ALLOW_PUBLIC_COMMENTS=true` frei.

`weclapp_create_ticket` verlangt den Betreff (`subject`) und den Kunden (`partyId`). Ohne `assignedUserId` weist es das Ticket dir zu. Dazu kommen wahlweise Beschreibung, Status, Priorität, Kategorie, Kanal, Ansprechpartner (`contactId`) und `billable`; alles Weitere nimmt `fields` mit den weclapp-Feldnamen auf. weclapp selbst kennzeichnet Status, Priorität und Kanal als Pflichtangaben eines Tickets und setzt für fehlende Pflichtangaben laut API-Dokumentation in der Regel Standardwerte. Ob dein Mandant die Angaben annimmt, zeigt `dryRun: true`.

## Änderungsprotokoll und Rückgängig

Schreib-Tools gibt es nur dort, wo protokolliert wird. Der Docker-Server schreibt nach `/data/audit` (Volume `audit_data`), eine Datei pro Monat im JSON-Lines-Format:

```json
{"v":1,"phase":"begin","id":"0b6f…","time":"2026-11-13T09:05:03.120Z","user":{"id":"100","name":"Anna Admin"},"tool":"weclapp_update_ticket","kind":"update","entity":"ticket","entityId":"20","before":{"ticketStatusId":"1"},"versionBefore":"5"}
{"v":1,"phase":"end","id":"0b6f…","time":"2026-11-13T09:05:03.410Z","status":"done","after":{"ticketStatusId":"2"},"versionAfter":"6"}
```

- **Ablauf:** Der Eintrag wird geschrieben, *bevor* weclapp geändert wird. Lässt sich das Protokoll nicht schreiben, findet die Änderung nicht statt.
- **Inhalt:** nur die betroffenen Felder vorher und nachher, nie der Token. `dryRun`-Aufrufe werden nicht protokolliert.
- **Sichtbarkeit:** Jeder sieht und ändert nur Einträge seines eigenen weclapp-Nutzers.
- **Rückgängig:** `weclapp_undo_change` setzt geänderte Felder zurück und löscht angelegte Tickets, Zeitbuchungen, Kommentare oder Artikel wieder. Es bricht ab, wenn der Datensatz seitdem anders verändert wurde. Ein angelegtes Ticket bleibt außerdem stehen, sobald Zeitbuchungen oder Kommentare daran hängen. Auch das Rückgängigmachen wird protokolliert.
- **Aufbewahrung:** 365 Tage (`WECLAPP_AUDIT_RETENTION_DAYS`, `0` = unbegrenzt). Ältere Monatsdateien löscht der Server selbst.
- **Größe:** höchstens 100 MB (`WECLAPP_AUDIT_MAX_MB`, `0` = unbegrenzt). Ist das Protokoll voll, lehnt der Server Schreibaktionen ab, bis alte Monatsdateien ablaufen oder der Wert erhöht wird. Bei normaler Nutzung wird diese Grenze nicht erreicht.
- **Übersicht:** `weclapp_list_changes` lässt sehr große Vorher-/Nachher-Stände (über 32 kB) weg und weist darauf hin. Rückgängig machen lassen sie sich trotzdem.
- **Auf dem VPS ansehen:**

```bash
docker compose exec weclapp-mcp sh -c 'cat /data/audit/*.jsonl' | jq -c 'select(.phase=="begin") | {time, user: .user.name, tool, entity, entityId}'
```

Änderungen direkt in der weclapp-Oberfläche stehen nicht im Protokoll. Der lokale Start (stdio) ist ohne `WECLAPP_AUDIT_DIR` nur lesend, damit keine verteilten Protokolle auf mehreren Geräten entstehen.

## Voraussetzung: weclapp-API-Token

In weclapp oben rechts auf dein Profil → **Meine Einstellungen** → Abschnitt **API-Token** → Passwort eingeben → **Neuen API-Token hinzufügen**.

Den Token behandelst du wie ein Passwort: Wer ihn hat, hat in weclapp deine Rechte.

## Betrieb auf einem VPS (Docker + Caddy)

Caddy holt automatisch ein TLS-Zertifikat von Let's Encrypt. Der weclapp-Container selbst ist von außen nicht erreichbar.

Läuft auf deinem Server schon ein NGINX, das TLS übernimmt und an einen lokalen Port weiterleitet (etwa die Option „Proxy auf App-Server/Port“ einer Hosting-Verwaltungsoberfläche), nimm stattdessen `docker-compose.nginx.yml`. Die Schritt-für-Schritt-Anleitung steht in [DEPLOY.md](DEPLOY.md).

**Voraussetzungen:** ein VPS mit Docker, eine (Sub-)Domain wie `mcp.example.com`, deren DNS-Eintrag auf den VPS zeigt, und offene Ports 80 und 443.

```bash
git clone https://github.com/belsignum/weclapp-mcp.git && cd weclapp-mcp
cp .env.example .env      # WECLAPP_TENANT und MCP_DOMAIN eintragen
docker compose up -d --build
curl https://mcp.example.com/health
```

Erwartete Antwort: `{"status":"ok"}`.

Updates einspielen:

```bash
git pull && docker compose up -d --build
```

### Konfiguration

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `WECLAPP_TENANT` | ja | Mandant aus `https://<tenant>.weclapp.com` |
| `MCP_DOMAIN` | ja (Compose) | Öffentlicher Hostname; wird für TLS und den Host-Check genutzt |
| `WECLAPP_READ_ONLY` | nein | `true` = nur Lese-Tools |
| `WECLAPP_ALLOW_PUBLIC_COMMENTS` | nein | `true` = Kommentare dürfen für Kunden sichtbar sein (Standard: aus) |
| `WECLAPP_AUDIT_DIR` | nein | Verzeichnis des Änderungsprotokolls; im Docker-Image `/data/audit`. Ohne Angabe: nur lesen |
| `WECLAPP_AUDIT_RETENTION_DAYS` | nein | Aufbewahrung in Tagen (Standard 365, `0` = unbegrenzt) |
| `WECLAPP_AUDIT_MAX_MB` | nein | Maximale Größe des Protokolls in MB (Standard 100, `0` = unbegrenzt); danach keine Schreibaktionen mehr |
| `WECLAPP_MAX_WRITES_PER_HOUR` | nein | Schreibaktionen pro Nutzer und Stunde (Standard 120, `0` = unbegrenzt) |
| `MCP_ALLOWED_HOSTS` | nein | Erlaubte Host-Header, kommagetrennt (Compose setzt ihn aus `MCP_DOMAIN`) |
| `MCP_TRUST_PROXY` | nein | `true` = Client-IP aus `X-Forwarded-For` (nur hinter eigenem Proxy; die Caddy-Variante setzt es, die NGINX-Variante nur nach Prüfung, siehe [DEPLOY.md](DEPLOY.md)). Nie setzen, wenn der Port direkt erreichbar ist |
| `MCP_PORT` | ja (NGINX-Variante) | Port auf `127.0.0.1`, an den das vorhandene NGINX weiterleitet |
| `PORT`, `HOST` | nein | Standard `3000` / `127.0.0.1` (im Container `0.0.0.0`) |
| `WECLAPP_BASE_URL` | nein | Überschreibt die API-URL komplett (Tests, eigene Domain) |

## Clients verbinden

Auf jedem Gerät brauchst du nur die URL `https://mcp.example.com/mcp` und deinen weclapp-Token.

### Claude Code

```bash
claude mcp add --transport http --scope user weclapp https://mcp.example.com/mcp --header "Authorization: Bearer <WECLAPP_TOKEN>"
```

Damit der Token nicht im Klartext in der Konfiguration steht, kannst du ihn in einer projektbezogenen `.mcp.json` aus einer Umgebungsvariable lesen:

```json
{
  "mcpServers": {
    "weclapp": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${WECLAPP_TOKEN}" }
    }
  }
}
```

### Claude Desktop

Claude Desktop startet lokale Server über `claude_desktop_config.json`. Den entfernten Server bindest du mit der Brücke `mcp-remote` ein:

```json
{
  "mcpServers": {
    "weclapp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.com/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer <WECLAPP_TOKEN>" }
    }
  }
}
```

### Cursor / VS Code

`.cursor/mcp.json` bzw. `.vscode/mcp.json` (dort heißt der Schlüssel `servers` statt `mcpServers`):

```json
{
  "mcpServers": {
    "weclapp": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <WECLAPP_TOKEN>" }
    }
  }
}
```

### claude.ai im Browser / ChatGPT

Diese Clients erwarten OAuth und können keinen festen Bearer-Header senden. Dafür bräuchte der Server eine zusätzliche OAuth-Schicht. Die ist nicht enthalten.

## Lokal ohne Server (stdio)

Für ein einzelnes Gerät geht es auch ohne VPS. Der Client startet den Server dann selbst. Ohne `WECLAPP_AUDIT_DIR` ist dieser Start **nur lesend**:

```bash
npm install && npm run build
```

```json
{
  "mcpServers": {
    "weclapp": {
      "command": "node",
      "args": ["/absoluter/pfad/zu/weclapp-mcp/dist/stdio.js"],
      "env": { "WECLAPP_TENANT": "meinefirma", "WECLAPP_TOKEN": "<WECLAPP_TOKEN>" }
    }
  }
}
```

## Sicherheit

- **Zugang nur mit gültigem weclapp-Token.** Ohne ihn antwortet `/mcp` mit `401`, auch die Tool-Liste bleibt verborgen.
- **Schutz gegen Token-Raten:** Nach 10 Fehlversuchen in 5 Minuten wird die IP-Adresse (bei IPv6 das /64-Netz) für unbekannte Tokens gesperrt (`429`). Ein Token, den weclapp in den letzten 24 Stunden bestätigt hat, bleibt davon unberührt: Fehlversuche anderer sperren dich nicht aus.
- **Schutz gegen Massenänderungen:** Schreiblimit pro Stunde und Größenlimit fürs Protokoll (siehe oben).
- **Nur über HTTPS betreiben.** Der Token steht in jedem Request; Caddy übernimmt TLS und schreibt kein Access-Log.
- **Der Mandant ist fest eingestellt.** Der Server spricht nur mit `WECLAPP_TENANT` und folgt keinen Weiterleitungen.
- **Host-Check gegen DNS-Rebinding:** Anfragen mit fremdem `Host`- oder `Origin`-Header werden abgelehnt.
- **Texte aus weclapp sind Daten, keine Anweisungen.** Ticket-Texte können von Kunden stammen. Bestätigungen für Schreib-Tools im Client deshalb nicht pauschal abschalten.
- Die MCP-Spezifikation rät formell davon ab, Tokens an eine Upstream-API durchzureichen. Für einen Server, den du nur selbst nutzt, ist das vertretbar. Öffentlich für Dritte anbieten solltest du ihn so nicht.

Die Berichte beider Audits mit allen Befunden und verbleibenden Risiken findest du in [SECURITY.md](SECURITY.md).

## Bekannte Grenzen

- Für **Ticket-Prioritäten** gibt es keinen API-Endpunkt zum Nachschlagen. Die IDs stehen in bestehenden Tickets (`ticketPriorityId`).
- **PDF-Download** von Rechnungen und Vertragsdokumenten ist nicht enthalten.
- Ob ein **öffentlicher Ticket-Kommentar** beim Kunden zusätzlich eine E-Mail auslöst, hängt von den weclapp-Einstellungen ab und ist nicht geprüft.
- **Ticket anlegen:** Die OpenAPI-Spezifikation von weclapp nennt für `POST /ticket` keine Felder, die der Aufrufer mitschicken muss. Welche Angaben dein Mandant ohne Standardwert verlangt und ob er das Löschen eines angelegten Tickets zulässt, ist nur gegen den nachgebauten weclapp-Server getestet.
- **Rückgängig bei Listen** (Vertragspositionen, Artikelpreise): Gelöschte Einträge legt weclapp mit neuer ID an. Dieses Verhalten ist nur gegen den nachgebauten weclapp-Server getestet.

## Entwicklung

```bash
npm install
npm test          # Tests gegen einen nachgebauten weclapp-Server, inkl. Angriffstests
npm run typecheck
WECLAPP_TENANT=meinefirma WECLAPP_AUDIT_DIR=./audit npm run dev   # HTTP-Server auf http://127.0.0.1:3000/mcp
```

Node.js ≥ 24. Der Quellcode in `src/` läuft dank Type-Stripping direkt mit Node; `npm run build` erzeugt `dist/` für Docker und `npx`.

### Rauchtest am echten Mandanten

```bash
node scripts/smoke-article.ts
```

Das Skript fragt Mandant und Token ab (den Token verdeckt), startet den Server lokal und legt über die MCP-Tools einen inaktiven Testartikel an: erst als Probelauf, dann nach Rückfrage wirklich. Auf Wunsch löscht es ihn über `weclapp_undo_change` wieder. Das Protokoll landet in `./audit`.

## Lizenz

[MIT](LICENSE)
