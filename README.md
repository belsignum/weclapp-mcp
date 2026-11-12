# weclapp-mcp

MCP-Server für [weclapp](https://www.weclapp.com) auf Basis der REST-API v2. Er gibt KI-Clients wie Claude Code, Claude Desktop oder Cursor Zugriff auf:

- **Artikel** lesen, anlegen, bearbeiten
- **Ausgangsrechnungen** lesen
- **Helpdesk-Tickets** lesen, bearbeiten, kommentieren, Zeiten buchen und korrigieren
- **Verträge** lesen und bearbeiten

Der Server speichert **keinen** weclapp-Token. Jeder Request bringt den Token als `Authorization: Bearer <weclapp-API-Token>` mit. Der Server handelt damit in weclapp mit genau deinen Rechten, und Zeitbuchungen landen automatisch bei dir.

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
| | `weclapp_update_ticket`, `weclapp_add_ticket_comment`, `weclapp_book_time`, `weclapp_update_time_record` | schreiben |
| Verträge | `weclapp_search_contracts`, `weclapp_get_contract` | lesen |
| | `weclapp_update_contract` | schreiben |

Es gibt bewusst keine Lösch-Tools. Mit `WECLAPP_READ_ONLY=true` werden auch alle Schreib-Tools ausgeblendet. Jedes Schreib-Tool kennt `dryRun: true`: weclapp prüft die Änderung dann, ohne sie zu speichern.

## Voraussetzung: weclapp-API-Token

In weclapp oben rechts auf dein Profil → **Meine Einstellungen** → Abschnitt **API-Token** → Passwort eingeben → **Neuen API-Token hinzufügen**.

Den Token behandelst du wie ein Passwort: Wer ihn hat, hat in weclapp deine Rechte.

## Betrieb auf einem VPS (Docker + Caddy)

Caddy holt automatisch ein TLS-Zertifikat von Let's Encrypt. Der weclapp-Container selbst ist von außen nicht erreichbar.

**Voraussetzungen:** ein VPS mit Docker, eine (Sub-)Domain wie `mcp.example.com`, deren DNS-Eintrag auf den VPS zeigt, und offene Ports 80 und 443.

```bash
git clone <dieses-repo> weclapp-mcp && cd weclapp-mcp
cp .env.example .env      # WECLAPP_TENANT und MCP_DOMAIN eintragen
docker compose up -d --build
curl https://mcp.example.com/health
```

Erwartete Antwort: `{"status":"ok",...}`.

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
| `MCP_ALLOWED_HOSTS` | nein | Erlaubte Host-Header, kommagetrennt (Compose setzt ihn aus `MCP_DOMAIN`) |
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

Für ein einzelnes Gerät geht es auch ohne VPS. Der Client startet den Server dann selbst:

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

- **Nur über HTTPS betreiben.** Der Token steht in jedem Request; Caddy übernimmt TLS. Caddy schreibt in dieser Konfiguration kein Access-Log.
- **Der Mandant ist fest eingestellt.** Der Server spricht nur mit `WECLAPP_TENANT`, nie mit einem Ziel aus dem Request.
- **Kein neues Einfallstor:** Ohne gültigen weclapp-Token kann niemand etwas abrufen, und mit dem Token wäre die weclapp-API ohnehin direkt nutzbar.
- **Host-Check gegen DNS-Rebinding:** Anfragen mit fremdem `Host`-Header werden abgelehnt.
- Die MCP-Spezifikation rät formell davon ab, Tokens an eine Upstream-API durchzureichen. Für einen Server, den du nur selbst nutzt, ist das vertretbar. Öffentlich für Dritte anbieten solltest du ihn so nicht.

## Bekannte Grenzen

- Für **Ticket-Prioritäten** gibt es keinen API-Endpunkt zum Nachschlagen. Die IDs stehen in bestehenden Tickets (`ticketPriorityId`).
- **PDF-Download** von Rechnungen und Vertragsdokumenten ist nicht enthalten.
- Ob ein **öffentlicher Ticket-Kommentar** beim Kunden zusätzlich eine E-Mail auslöst, hängt von den weclapp-Einstellungen ab und ist nicht geprüft.

## Entwicklung

```bash
npm install
npm test          # Tests gegen einen nachgebauten weclapp-Server
npm run typecheck
WECLAPP_TENANT=meinefirma npm run dev   # HTTP-Server auf http://127.0.0.1:3000/mcp
```

Node.js ≥ 24. Der Quellcode in `src/` läuft dank Type-Stripping direkt mit Node; `npm run build` erzeugt `dist/` für Docker und `npx`.
