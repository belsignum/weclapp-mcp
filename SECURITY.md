# Sicherheit

Stand: 13.11.2026, Version 0.2.0. Geprüft wurde der eigene Code dieses Repos: HTTP-Server, weclapp-Client, Tools, Änderungsprotokoll, Docker- und Caddy-Konfiguration.

**Nicht geprüft:** weclapp selbst, der VPS (Firewall, SSH, Updates) und das Verhalten gegen einen echten weclapp-Mandanten. Alle Angriffe liefen gegen einen nachgebauten weclapp-Server.

## Schutzmodell in Kurzform

- **Zugang nur mit gültigem weclapp-Token.** Jeder Request an `/mcp` braucht `Authorization: Bearer <weclapp-API-Token>`. Bevor der Server irgendetwas verarbeitet, bestätigt weclapp den Token für den fest eingestellten Mandanten. Ohne gültigen Token gibt es nur `401`, auch keine Tool-Liste.
- **Der Server speichert keinen Token.** Im Arbeitsspeicher liegt für 5 Minuten nur ein SHA-256-Hash als Cache-Schlüssel.
- **Rechte kommen von weclapp.** Der Server kann nie mehr als der Nutzer, dem der Token gehört.
- **Schreiben nur mit Protokoll.** Ohne Änderungsprotokoll (`WECLAPP_AUDIT_DIR`) bietet der Server keine Schreib-Tools an.
- **Protokoll pro Nutzer.** `weclapp_list_changes` und `weclapp_undo_change` zeigen und ändern nur Einträge des eigenen weclapp-Nutzers.

## Audit vom 13.11.2026

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

## Verbleibende Risiken

- **Prompt Injection ist nicht vollständig lösbar.** Ticket-Texte, Kommentare und Namen stammen teils von Kunden. Der Server weist das Modell an, sie als Daten zu behandeln, erzwingen kann er es nicht. Dagegen helfen: Bestätigungen im Client nicht pauschal abschalten, `WECLAPP_READ_ONLY=true` wo Schreiben nicht nötig ist, und das Änderungsprotokoll mit Undo.
- **Wer den Token hat, hat den Zugriff.** Der Token liegt in der Client-Konfiguration jedes Geräts. Bei Verlust eines Geräts den Token in weclapp löschen; spätestens 5 Minuten später ist er auch hier wertlos.
- **Aussperren über die eigene IP:** Wer von derselben IP-Adresse aus 10 falsche Tokens schickt, sperrt diese Adresse für bis zu 5 Minuten.
- **Rate-Limit und Cache liegen im Arbeitsspeicher** und gelten pro Container. Nach einem Neustart sind sie leer.
- **Das Protokoll ist manipulierbar, wenn der VPS kompromittiert ist.** Es ist ein Arbeitsprotokoll mit Undo, kein revisionssicheres Archiv.
- **Statusänderungen an Tickets** können je nach weclapp-Einstellung E-Mails an Kunden auslösen. Das steuert weclapp, nicht dieser Server.
- **Basis-Images** sind per Tag (`node:24-alpine`, `caddy:2-alpine`) und nicht per Digest festgelegt.

## Empfehlungen für den Betrieb

- Einen eigenen weclapp-Nutzer mit genau den nötigen Rechten für den Token verwenden.
- Auf dem VPS nur die Ports 80, 443 und SSH öffnen; SSH nur mit Schlüssel.
- Das Volume `audit_data` in die Backups aufnehmen.
- Regelmäßig aktualisieren: `git pull && docker compose build --pull && docker compose up -d`.

## Schwachstelle melden

Bitte nicht als öffentliches Issue, sondern direkt an den Betreiber dieses Repos.
