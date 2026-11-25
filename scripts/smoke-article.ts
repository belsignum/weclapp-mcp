/**
 * Geführter Rauchtest gegen den echten weclapp-Mandanten.
 *
 * Startet den MCP-Server lokal (nur auf 127.0.0.1), legt über die MCP-Tools einen inaktiven
 * Testartikel an und löscht ihn auf Wunsch wieder. Vor jedem Schreiben wird nachgefragt.
 *
 *   node scripts/smoke-article.ts
 *
 * Mandant und Token werden abgefragt, der Token verdeckt. Er bleibt im Speicher dieses
 * Prozesses und wird nie ausgegeben. Das Änderungsprotokoll landet in WECLAPP_AUDIT_DIR
 * (Standard: ./audit).
 */
import { ask, call, confirm, must, runSmoke, say, startSession } from './smoke-common.ts';

async function main(): Promise<void> {
  say('Rauchtest: Testartikel in weclapp anlegen');
  say('=========================================');

  const { client, close } = await startSession('smoke-article');

  try {
    say();
    say('1. Wer bin ich?');
    const me = must('weclapp_whoami', await call(client, 'weclapp_whoami'));
    say(`   ${me.firstName ?? ''} ${me.lastName ?? ''} (Nutzer-ID ${me.id})`);

    say('2. Einheiten nachschlagen');
    const units: Array<{ id: string; name?: string }> = must('weclapp_lookup', await call(client, 'weclapp_lookup', { resource: 'unit' })).result;
    if (units.length === 0) throw new Error('weclapp liefert keine Einheiten; ohne Einheit lässt sich kein Artikel anlegen.');
    units.slice(0, 15).forEach((unit, index) => say(`   ${index + 1}) ${unit.name ?? '(ohne Namen)'} [id ${unit.id}]`));
    const preferred = Math.max(0, units.findIndex((unit) => /^(st(ü|ue)ck|stk\.?|pcs|piece)/i.test(unit.name ?? '')));
    const picked = Number(await ask(`   Welche Einheit? [${preferred + 1}] `)) || preferred + 1;
    const unit = units[picked - 1] ?? units[preferred];

    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    const article = {
      articleNumber: `MCP-TEST-${stamp}`,
      name: 'MCP-Testartikel (kann gelöscht werden)',
      articleType: 'BASIC',
      unitId: unit.id,
      active: false,
    };
    const exists = async () =>
      (must('weclapp_search_articles', await call(client, 'weclapp_search_articles', { articleNumber: article.articleNumber })).result as Array<{ articleNumber?: string }>).some(
        (found) => found.articleNumber === article.articleNumber,
      );

    say('3. Geplanter Artikel');
    say(`   Nummer ${article.articleNumber}, Name "${article.name}", Typ BASIC, Einheit ${unit.name}, inaktiv`);
    if (await exists()) throw new Error('Diese Artikelnummer gibt es schon.');

    say('4. Probelauf (dryRun: weclapp prüft, speichert aber nicht)');
    const dry = await call(client, 'weclapp_create_article', { ...article, dryRun: true });
    if (!dry.ok) throw new Error(`weclapp lehnt den Artikel schon im Probelauf ab: ${dry.error}`);
    say('   weclapp nimmt die Daten an.');
    say(`   Nach dem Probelauf in weclapp vorhanden: ${(await exists()) ? 'JA (dryRun hat gespeichert!)' : 'nein, wie erwartet'}`);

    say();
    if (!(await confirm('5. Artikel jetzt wirklich in weclapp anlegen?'))) {
      say('   Nichts angelegt.');
      return;
    }
    const created = must('weclapp_create_article', await call(client, 'weclapp_create_article', article));
    const id = String(created.result.id);
    say(`   Angelegt: Artikel-ID ${id}, changeId ${created.changeId}`);
    if (created.warning) say(`   Warnung: ${created.warning}`);

    say('6. Zurücklesen');
    const read = must('weclapp_get_article', await call(client, 'weclapp_get_article', { id }));
    say(`   ${read.articleNumber} | ${read.name} | Typ ${read.articleType} | aktiv: ${read.active} | Version ${read.version}`);
    const changes = must('weclapp_list_changes', await call(client, 'weclapp_list_changes'));
    say(`   Im Änderungsprotokoll: ${JSON.stringify(changes).includes(created.changeId) ? 'ja' : 'NEIN'}`);

    say();
    if (!(await confirm('7. Testartikel wieder löschen (weclapp_undo_change)?'))) {
      say(`   Der Artikel bleibt bestehen. Später löschen: in weclapp von Hand, Artikelnummer ${article.articleNumber}.`);
      return;
    }
    const undone = await call(client, 'weclapp_undo_change', { changeId: created.changeId });
    if (!undone.ok) {
      say(`   Rückgängig fehlgeschlagen: ${undone.error}`);
      say(`   Bitte in weclapp von Hand löschen: Artikelnummer ${article.articleNumber}.`);
      return;
    }
    const gone = await call(client, 'weclapp_get_article', { id });
    say(`   Rückgängig gemacht. Artikel noch vorhanden: ${gone.ok ? 'JA' : 'nein'}`);
  } finally {
    await close();
  }
}

runSmoke(main);
