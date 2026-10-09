// Trazabilidad y auditoría (SaMD): logs/ append-only con hash encadenado, procedencia de cada respuesta,
// auditoría de cada cambio de configuración y export FHIR (Provenance / AuditEvent).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const { iniciar } = require('../lib/servidor');
const { prepararAsistente, ejecutarReporte } = require('../lib/plan');

const RAIZ = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const leerJsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// ---------- Registro append-only ----------
test('logs: cadena de hashes que detecta registros modificados o borrados', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-test-'));
  const r = spawnSync(process.execPath, ['-e', `
    const L = require(${JSON.stringify(path.join(RAIZ, 'src', 'logs'))});
    for (let i = 1; i <= 3; i++) L.agregar('auditoria', { id: 'a' + i, evento: 'evento ' + i }, (x) => ({ resourceType: 'AuditEvent', id: x.id }));
    console.log(JSON.stringify(L.verificar('auditoria')));
  `], { env: { ...process.env, LOGS_DIR: dir }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, registros: 3 });
  const f = path.join(dir, 'auditoria.jsonl');
  const lineas = fs.readFileSync(f, 'utf8').trim().split('\n');
  assert.equal(fs.readFileSync(path.join(dir, 'fhir', 'AuditEvent.ndjson'), 'utf8').trim().split('\n').length, 3);
  const verificar = () => JSON.parse(spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require(${JSON.stringify(path.join(RAIZ, 'src', 'logs'))}).verificar('auditoria')))`], { env: { ...process.env, LOGS_DIR: dir }, encoding: 'utf8' }).stdout);

  fs.writeFileSync(f, [lineas[0], lineas[1].replace('evento 2', 'evento 2 (editado)'), lineas[2]].join('\n') + '\n');
  assert.deepEqual(verificar(), { ok: false, registros: 3, linea: 2, error: 'el contenido no coincide con su hash: el registro fue modificado' });

  fs.writeFileSync(f, [lineas[0], lineas[2]].join('\n') + '\n');
  assert.deepEqual(verificar(), { ok: false, registros: 2, linea: 2, error: 'la cadena se corta: falta o se reordenó un registro anterior' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diferencias campo por campo', () => {
  const { diferencias } = require('../../src/trazabilidad');
  assert.deepEqual(diferencias({ a: 1, u: { hipo: 70, hiper: 250 }, l: [1] }, { a: 1, u: { hipo: 65, hiper: 250 }, l: [1, 2], n: 'x' }), [
    { campo: 'u.hipo', antes: 70, despues: 65 },
    { campo: 'l', antes: [1], despues: [1, 2] },
    { campo: 'n', antes: null, despues: 'x' },
  ]);
});

// ---------- Recorrido por la API ----------
test('auditoría y procedencia por la API (modo simulado)', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock' } });
  t.after(() => srv.detener());
  const { api, logsDir } = srv;
  await prepararAsistente(api);
  const sesion = (await api('/api/state')).sesion;
  const aud = async () => (await api('/api/auditoria')).auditoria;

  await t.test('generar el asistente: alta de la configuración, por la médica, con su versión', async () => {
    const [gen, imp] = await aud();
    assert.equal(gen.evento, 'Asistente generado');
    assert.equal(gen.accion, 'C');
    assert.equal(gen.actor.id, 'lucia-001');
    assert.equal(gen.configuracion.versionDespues, 1);
    assert.equal(imp.evento, 'Datos importados desde la HCE');
  });

  await t.test('pausar, modificar, agregar y eliminar alarmas: quién, cuándo, antes y después', async () => {
    await api('/api/alarms/gen-disnea', { method: 'PUT', body: { activa: false } });
    await api('/api/alarms/dm2-hipo-grave', { method: 'PUT', body: { valor: 45 } });
    const nueva = (await api('/api/alarms', { body: { nombre: 'Fiebre alta', tipo: 'texto', frases: 'fiebre de 39' } })).alarmas.find((a) => a.nombre === 'Fiebre alta');
    await api(`/api/alarms/${nueva.id}`, { method: 'DELETE' });
    await assert.rejects(api('/api/alarms/gen-hemorragia', { method: 'DELETE' }), (e) => e.status === 400);

    const [del, add, mod, pausa] = await aud();
    assert.equal(pausa.evento, 'Alarma pausada');
    assert.equal(pausa.accion, 'U');
    assert.deepEqual(pausa.cambios, [{ campo: 'activa', antes: true, despues: false }]);
    assert.deepEqual([pausa.configuracion.versionAntes, pausa.configuracion.versionDespues], [1, 2]);
    assert.ok(pausa.registrado && pausa.ts, 'fecha real y del reloj simulado');

    assert.equal(mod.evento, 'Alarma modificada');
    assert.deepEqual(mod.cambios.find((c) => c.campo === 'valorEfectivo'), { campo: 'valorEfectivo', antes: 54, despues: 45 });

    assert.equal(add.accion, 'C');
    assert.equal(add.antes, null);
    assert.equal(add.despues.nombre, 'Fiebre alta');
    assert.equal(del.accion, 'D');
    assert.equal(del.antes.id, nueva.id);
    assert.equal(del.despues, null);
    assert.equal(del.configuracion.versionDespues, 5);
    assert.equal((await aud()).filter((r) => r.objeto.id === 'gen-hemorragia').length, 0, 'un cambio rechazado no se registra como hecho');
  });

  await t.test('actualizar la configuración registra sólo lo que cambió', async () => {
    const cfg = (await api('/api/state')).assistant.config;
    cfg.indicaciones = 'Caminar 45 minutos por día.';
    cfg.umbrales.hipo = 65;
    await api('/api/assistant', { body: { config: cfg } });
    const [r] = await aud();
    assert.equal(r.evento, 'Configuración actualizada');
    assert.deepEqual(r.cambios.map((c) => c.campo).sort(), ['indicaciones', 'umbrales.hipo']);
    assert.deepEqual(r.cambios.find((c) => c.campo === 'umbrales.hipo'), { campo: 'umbrales.hipo', antes: 70, despues: 65 });
  });

  await t.test('cada respuesta queda asociada a versiones, configuración y fragmentos', async () => {
    await api('/api/chat/text', { body: { text: '¿Puedo comer frutas?' } });
    const s = await api('/api/state');
    const resp = s.messages.filter((m) => m.from === 'asistente').pop();
    const [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(resp.procedencia, p.id, 'el mensaje apunta a su procedencia');
    assert.deepEqual(p.respuestas.map((r) => r.id), [resp.id]);
    assert.match(p.actor.id, /^pac-[0-9a-f]{16}$/, 'la paciente figura con su seudónimo');
    assert.equal(p.actor.id, (await api('/api/auditoria')).seudonimo);
    assert.equal(p.versiones.configuracion.version, s.assistant.version);
    assert.deepEqual(p.versiones.modulos.map((m) => `${m.id}@${m.version}`).sort(), ['dm2@1.2.0', 'hta@1.2.0']);
    assert.ok(p.versiones.alarmasGenericas);
    assert.ok(p.versiones.app.version);
    assert.deepEqual(p.rag.citados, ['DM2-08']);
    assert.equal(p.rag.recuperados.find((f) => f.id === 'DM2-08').version, '1.2.0');
    assert.equal(p.rag.recuperados.find((f) => f.id === 'IND-1').version, `config-v${s.assistant.version}`);
    assert.equal(p.modelo.usado, false);
    assert.equal(p.entrada.sha256.length, 64, 'el log guarda la huella del texto, no el texto');
    assert.doesNotMatch(JSON.stringify(p), /comer frutas/);
  });

  await t.test('alarma por regla: la procedencia muestra la regla y que el modelo no intervino', async () => {
    await api('/api/chat/text', { body: { text: 'Me corté y no para de sangrar' } });
    const [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(p.decision.alarma, true);
    assert.deepEqual(p.decision.reglasAlarma, ['gen-hemorragia']);
    assert.equal(p.decision.derivacion, 'alta');
    assert.deepEqual(p.modelo.llamadas, []);
  });

  await t.test('export FHIR: Provenance y AuditEvent en logs/fhir y en el Bundle', async () => {
    const prov = leerJsonl(path.join(logsDir, 'procedencia.jsonl'));
    const provFhir = leerJsonl(path.join(logsDir, 'fhir', 'Provenance.ndjson'));
    const audFhir = leerJsonl(path.join(logsDir, 'fhir', 'AuditEvent.ndjson'));
    assert.equal(provFhir.length, prov.length);
    assert.equal(audFhir.length, leerJsonl(path.join(logsDir, 'auditoria.jsonl')).length);
    const p = provFhir[provFhir.length - 2]; // "¿Puedo comer frutas?"
    assert.equal(p.resourceType, 'Provenance');
    assert.equal(p.extension[0].valueString, prov[prov.length - 2].hash, 'el recurso lleva el hash del registro');
    assert.equal(p.target[0].identifier.system, 'urn:asistente:mensaje');
    assert.ok(p.entity.some((e) => e.role === 'quotation' && e.what.identifier.value === 'DM2-08|1.2.0'), 'fragmento citado');
    assert.ok(p.entity.some((e) => e.what.identifier.system === 'urn:asistente:configuracion'));
    assert.ok(p.entity.some((e) => e.what.identifier.value === 'dm2|1.2.0'));
    const pausa = audFhir.find((a) => a.outcomeDesc === 'Alarma pausada');
    assert.equal(pausa.action, 'U');
    assert.equal(pausa.subtype[0].code, 'update');
    assert.equal(pausa.agent[0].who.identifier.value, 'lucia-001');
    assert.deepEqual(JSON.parse(pausa.entity[0].detail.find((d) => d.type === 'cambios').valueString), [{ campo: 'activa', antes: true, despues: false }]);

    const b = await api('/api/fhir/bundle');
    const n = (tipo) => b.entry.filter((e) => e.resource.resourceType === tipo).length;
    assert.equal(n('Provenance'), provFhir.filter((r) => r.meta.tag[0].code === sesion).length);
    assert.equal(n('AuditEvent'), audFhir.filter((r) => r.meta.tag[0].code === sesion).length);
  });

  await t.test('los datos identificados no se descargan: se ven (auditado) o se envían a la HCE (auditado)', async () => {
    assert.equal((await fetch(`${srv.base}/api/logs/auditoria.jsonl`)).status, 404, 'los logs no se descargan desde la app');
    assert.equal((await fetch(`${srv.base}/api/fhir/bundle?download=1`)).headers.get('content-disposition'), null);
    const resumen = await api('/api/fhir/resumen');
    assert.ok(resumen.recursos.Patient >= 1);
    assert.doesNotMatch(JSON.stringify(resumen), /Marta|Gonz/, 'el resumen de la pestaña no lleva datos de la paciente');

    const antes = (await api('/api/auditoria')).auditoria.length;
    await api('/api/fhir/bundle');
    await api('/api/hce/bundle');
    await api('/cds-services/seguimiento-entre-consultas', { body: { hook: 'patient-view' } });
    const exp = await api('/api/hce/export', { body: {} });
    const nuevos = (await api('/api/auditoria')).auditoria.slice(0, 4).reverse();
    assert.equal((await api('/api/auditoria')).auditoria.length, antes + 4);
    assert.deepEqual(nuevos.map((r) => [r.accion, r.categoria, r.evento]), [
      ['R', 'consulta', 'Bundle FHIR consultado'],
      ['R', 'consulta', 'Datos de la HCE consultados'],
      ['R', 'consulta', 'Registro consultado vía CDS Hooks (patient-view)'],
      ['E', 'exportacion', 'Bundle enviado a la HCE'],
    ]);
    assert.ok(nuevos.every((r) => r.actor.id === 'lucia-001'));
    assert.match(nuevos[3].detalle, new RegExp(`${exp.total} recursos`));
    assert.equal((await api('/api/state')).exportaciones.length, 1);
    const audFhir = leerJsonl(path.join(logsDir, 'fhir', 'AuditEvent.ndjson'));
    const envio = audFhir.find((a) => a.outcomeDesc === 'Bundle enviado a la HCE');
    assert.deepEqual(envio.type, { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110106', display: 'Export' });
    assert.equal(envio.action, 'E');
    assert.equal(audFhir.find((a) => a.outcomeDesc === 'Bundle FHIR consultado').subtype[0].code, 'read');
  });

  await t.test('logs/ sin datos personales: sólo un seudónimo estable de la paciente', async () => {
    await api('/api/chat/text', { body: { text: 'Soy Marta González, DNI 14.XXX.XXX, tel +54 9 11 5555-0000: me duele mucho la rodilla' } });
    const { seudonimo } = await api('/api/auditoria');
    const archivos = ['auditoria.jsonl', 'procedencia.jsonl', 'trazas.jsonl', 'fhir/AuditEvent.ndjson', 'fhir/Provenance.ndjson'];
    for (const f of archivos) {
      const txt = fs.readFileSync(path.join(logsDir, f), 'utf8');
      for (const dato of ['Marta', 'MARTA', 'marta', 'González', 'Gonzalez', 'marta-001', '14.XXX.XXX', '5555-0000', '1964-03-12', 'rodilla']) assert.ok(!txt.includes(dato), `${f} contiene "${dato}"`);
      assert.ok(txt.includes(seudonimo), `${f} relaciona los registros con el seudónimo`);
    }
    const audFhir = leerJsonl(path.join(logsDir, 'fhir', 'AuditEvent.ndjson'));
    const pac = audFhir.at(-1).entity.find((e) => e.role && e.role.code === '1');
    assert.deepEqual(pac.what, { identifier: { system: 'urn:asistente:paciente', value: seudonimo } }, 'sin nombre (display), sólo el seudónimo');
    const gen = leerJsonl(path.join(logsDir, 'auditoria.jsonl')).find((r) => r.evento === 'Asistente generado');
    assert.deepEqual(gen.despues.paciente, { seudonimo }, 'la configuración guardada no lleva los datos de la paciente');
    assert.ok(gen.despues.medicacion.length > 0, 'los valores clínicos de la configuración sí quedan (para auditar los cambios)');
  });

  await t.test('el seudónimo es estable con la misma clave y distinto con otra (re-identificable sólo desde el sistema)', () => {
    const calc = (clave) => spawnSync(process.execPath, ['-e', `process.stdout.write(require(${JSON.stringify(path.join(RAIZ, 'src', 'seudonimo'))}).seudonimo('marta-001'))`], { env: { ...process.env, ENCRYPTION_KEY: clave, DATA_DIR: srv.dataDir }, encoding: 'utf8' }).stdout;
    assert.equal(calc('clave-a'), calc('clave-a'));
    assert.notEqual(calc('clave-a'), calc('clave-b'));
    assert.match(calc('clave-a'), /^pac-[0-9a-f]{16}$/);
  });

  await t.test('historial de trazas: sin texto de la paciente y vinculado a la procedencia', async () => {
    const { trazas, integridad } = await api('/api/trazas');
    assert.equal(integridad.ok, true);
    const t = trazas.find((x) => /^Mensaje de pac-/.test(x.evento));
    assert.ok(t, 'la traza del mensaje existe');
    assert.match(t.evento, /"\[texto\]"/);
    const prov = (await api('/api/auditoria')).procedencia.map((p) => p.id);
    assert.ok(prov.includes(t.interaccion), 'la traza apunta a la procedencia de su respuesta');
    assert.ok(trazas.some((x) => x.evento === 'Exportación a la HCE'));
    const deriv = trazas.flatMap((x) => x.pasos).find((x) => x.paso === 'Módulo de derivación');
    if (deriv) assert.match(deriv.detalle, /"\[texto\]"/, 'el motivo redactado a partir del mensaje no queda en el historial');
    const clasif = trazas.flatMap((x) => x.pasos).find((x) => /^Intención:/.test(x.detalle));
    assert.match(clasif.detalle, /tema: "\[texto\]"/, 'el tema que arma el modelo con palabras de la paciente tampoco');
  });

  await t.test('archivo, respuesta a un recordatorio y resumen preconsulta también tienen procedencia', async () => {
    await api('/api/chat/sample', { body: { archivo: 'glucometro_182.jpg' } });
    let [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(p.interaccion, 'archivo');
    assert.deepEqual(p.decision.registros, ['glucemia']);

    await api('/api/sim/next-dose', { body: {} });
    const rec = (await api('/api/state')).messages.filter((m) => m.kind === 'reminder').pop();
    await api(`/api/reminder/${rec.id}`, { body: { tomada: false } });
    [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(p.interaccion, 'respuesta a recordatorio');
    assert.deepEqual(p.rag.citados, ['DM2-02']);

    const sum = await api('/api/summary', { body: {} });
    [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(p.interaccion, 'resumen preconsulta');
    assert.deepEqual(p.respuestas.map((r) => [r.id, r.recurso, r.destino]), [[sum.id, 'Composition', 'médica']]);
    assert.equal((await api('/api/state')).summaries[0].procedencia, p.id);
  });

  await t.test('una simulación con plan queda a su nombre, iniciada por la médica', async () => {
    const antes = (await api('/api/state')).sesion;
    await ejecutarReporte(api, { nombre: 'plan auditado', configuracion: { pausar: ['gen-disnea'] }, pasos: [{ mensaje: '¿Puedo comer frutas?' }] });
    const { auditoria, procedencia } = await api('/api/auditoria?alcance=todo');
    const inicio = auditoria.find((r) => r.evento === 'Simulación con plan iniciada');
    assert.equal(inicio.actor.id, 'lucia-001');
    assert.equal(inicio.sesion, antes);
    const pausa = auditoria.find((r) => r.evento === 'Alarma pausada' && r.actor.id.startsWith('simulacion:'));
    assert.match(pausa.actor.origen, /iniciada por Dra. Lucía/);
    assert.match(procedencia[0].actor.id, /^simulacion:/);
    await api('/api/sim/reset', { body: {} });
  });

  await t.test('reiniciar la demo no borra los logs: queda auditado y empieza otra sesión', async () => {
    await api('/api/sim/reset', { body: {} });
    const a = await api('/api/auditoria?alcance=todo');
    assert.notEqual(a.sesion, sesion);
    assert.ok(a.auditoria.some((r) => r.evento === 'Demo reiniciada' && r.sesion === sesion), 'el reinicio queda en la sesión que termina');
    assert.ok(a.procedencia.length >= 2, 'la procedencia de la sesión anterior sigue');
    assert.ok((await api('/api/trazas?alcance=todo')).trazas.some((x) => x.sesion === sesion), 'las trazas de la sesión anterior siguen');
    assert.equal((await api('/api/auditoria')).auditoria.length, 0, 'la sesión nueva arranca vacía');
    assert.equal(a.integridad.auditoria.ok, true);
  });

  await t.test('la API informa si alguien modificó un log', async () => {
    const f = path.join(logsDir, 'auditoria.jsonl');
    const original = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, original.replace('"activa":false', '"activa":true'));
    const a = await api('/api/auditoria');
    assert.equal(a.integridad.auditoria.ok, false);
    assert.match(a.integridad.auditoria.error, /modificado/);
    fs.writeFileSync(f, original);
  });

  await t.test('inyección: Bundle batch idempotente (PUT) hacia un servidor FHIR', async () => {
    const recibidos = [];
    const fhirSrv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const b = JSON.parse(body);
        recibidos.push({ url: req.url, b });
        res.writeHead(200, { 'Content-Type': 'application/fhir+json' });
        res.end(JSON.stringify({ resourceType: 'Bundle', type: 'batch-response', entry: b.entry.map(() => ({ response: { status: '201 Created' } })) }));
      });
    });
    await new Promise((r) => fhirSrv.listen(0, r));
    t.after(() => fhirSrv.close());
    // asíncrono: el servidor FHIR de prueba corre en este mismo proceso y tiene que poder responder
    const { stdout: out } = await promisify(execFile)(process.execPath, ['scripts/inyectar_fhir.js', '--servidor', `http://127.0.0.1:${fhirSrv.address().port}/fhir`, '--sesion', sesion], { cwd: RAIZ, env: { ...process.env, LOGS_DIR: logsDir }, encoding: 'utf8' });
    assert.match(out, /aceptados/);
    const [{ url, b }] = recibidos;
    assert.equal(url, '/fhir');
    assert.equal(b.type, 'batch');
    assert.ok(b.entry.length > 0);
    assert.ok(b.entry.every((e) => e.request.method === 'PUT' && e.request.url === `${e.resource.resourceType}/${e.resource.id}`));
    assert.ok(b.entry.every((e) => e.resource.meta.tag[0].code === sesion), 'sólo la sesión pedida');

    // con la cadena rota no se inyecta
    const f = path.join(logsDir, 'procedencia.jsonl');
    const original = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(f, original.split('\n').slice(1).join('\n'));
    const r = spawnSync(process.execPath, ['scripts/inyectar_fhir.js'], { cwd: RAIZ, env: { ...process.env, LOGS_DIR: logsDir }, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cadena de hashes está rota/);
    fs.writeFileSync(f, original);
  });
});

test('procedencia con el modelo y auditoría de la simulación (Claude falso)', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'claude-code', CLAUDE_CODE_BIN: FAKE } });
  t.after(() => srv.detener());
  const { api } = srv;
  await prepararAsistente(api);

  await t.test('llamada al modelo: id exacto, plantilla y huella del prompt; guardrails', async () => {
    await api('/api/chat/text', { body: { text: 'CASO_INVENTADA tengo fiebre y escalofrios' } });
    const [p] = (await api('/api/auditoria')).procedencia;
    assert.equal(p.modelo.usado, true);
    const [l] = p.modelo.llamadas;
    assert.equal(l.funcion, 'clasificar y responder');
    assert.equal(l.modeloId, 'claude-falso-sonnet-1', 'el modelo pedido (alias sonnet), no el auxiliar');
    assert.deepEqual(l.otrosModelos.map((m) => m.id), ['claude-chico-interno']);
    assert.equal(l.proveedor, 'Claude Code');
    assert.match(l.plantilla, /^[0-9a-f]{16}$/);
    assert.match(l.instancia, /^[0-9a-f]{64}$/);
    assert.deepEqual(l.tokens, { entrada: 10, salida: 5 });
    assert.equal(p.decision.guardrails.length, 1);
    assert.equal(p.decision.guardrails[0].aceptada, false);
    assert.ok(p.decision.guardrails[0].fallidos.includes('regla_configurada'));
    assert.ok(p.rag.enviadosAlModelo.length > 0);
    const prov = (await api('/api/fhir/bundle')).entry.map((e) => e.resource).find((r) => r.id === p.id);
    assert.ok(prov.agent.some((a) => a.type.coding[0].code === 'assembler' && a.who.identifier.value === 'claude-falso-sonnet-1'));
    assert.ok(prov.agent.some((a) => a.type.coding[0].code === 'verifier'));
  });
});
