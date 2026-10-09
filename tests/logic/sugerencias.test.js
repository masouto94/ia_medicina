// Sugerencias basadas en evidencia: la decisión de la médica queda auditada y se exporta a la HCE (FHIR).
const test = require('node:test');
const assert = require('node:assert/strict');
const { iniciar } = require('../lib/servidor');
const { prepararAsistente } = require('../lib/plan');

test('sugerencias de evidencia (modo simulado)', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock' } });
  t.after(() => srv.detener());
  const { api } = srv;
  await prepararAsistente(api);
  await api('/api/chat/text', { body: { text: '¿Me puedo pasar al Ozempic? Mi vecina bajó mucho de peso' } });
  await api('/api/chat/text', { body: { text: 'Mi hemoglobina glicosilada sigue alta, ¿hay que intensificar?' } });
  const [s1, s2] = (await api('/api/state')).suggestions;

  await t.test('una pregunta sobre el tratamiento genera una sugerencia pendiente sólo para la médica', () => {
    assert.ok(s1 && s2);
    assert.equal(s1.estado, 'pendiente');
    assert.equal(s1.origen, 'OpenEvidence (mock)');
  });

  await t.test('aceptar: queda quién, cuándo y antes → después, sin pedir motivo', async () => {
    const r = await api(`/api/suggestion/${s1.id}`, { body: { estado: 'aceptada' } });
    assert.equal(r.estado, 'aceptada');
    assert.equal(r.resueltaPor.id, 'lucia-001');
    assert.ok(r.resuelta);
    const [a] = (await api('/api/auditoria')).auditoria;
    assert.equal(a.evento, 'Sugerencia de evidencia aceptada para evaluar en consulta');
    assert.equal(a.categoria, 'decision');
    assert.equal(a.actor.id, 'lucia-001');
    assert.deepEqual(a.objeto, { tipo: 'sugerencia', id: s1.id, nombre: s1.tema });
    assert.deepEqual(a.cambios, [{ campo: 'estado', antes: 'pendiente', despues: 'aceptada' }]);
    const trazas = (await api('/api/trazas')).trazas;
    assert.match(trazas[0].evento, /Sugerencia de evidencia aceptada/);
  });

  await t.test('descartar también queda registrado; una sugerencia resuelta no se vuelve a resolver', async () => {
    await api(`/api/suggestion/${s2.id}`, { body: { estado: 'descartada' } });
    const [a] = (await api('/api/auditoria')).auditoria;
    assert.deepEqual(a.cambios, [{ campo: 'estado', antes: 'pendiente', despues: 'descartada' }]);
    await assert.rejects(api(`/api/suggestion/${s2.id}`, { body: { estado: 'aceptada' } }), (e) => e.status === 400 && /ya fue descartada/.test(e.message));
    await assert.rejects(api(`/api/suggestion/${s1.id}`, { body: { estado: 'quizas' } }), (e) => e.status === 400);
    await assert.rejects(api('/api/suggestion/no-existe', { body: { estado: 'aceptada' } }), (e) => e.status === 400);
    const decisiones = (await api('/api/auditoria')).auditoria.filter((x) => x.categoria === 'decision');
    assert.equal(decisiones.length, 2, 'los intentos rechazados no se registran como decisiones');
  });

  await t.test('export FHIR: la evidencia como GuidanceResponse y la decisión como Task', async () => {
    const b = await api('/api/fhir/bundle');
    const r = (tipo, id) => b.entry.map((e) => e.resource).find((x) => x.resourceType === tipo && x.id === id);
    const g = r('GuidanceResponse', `${s1.id}-evidencia`);
    assert.equal(g.status, 'success');
    assert.ok(g.moduleUri);
    assert.ok(g.note.length > 1, 'síntesis + citas');
    const t1 = r('Task', s1.id);
    const t2 = r('Task', s2.id);
    assert.equal(t1.status, 'accepted');
    assert.equal(t1.businessStatus.text, 'Evaluar en consulta');
    assert.equal(t1.focus.reference, `GuidanceResponse/${s1.id}-evidencia`);
    assert.equal(t1.intent, 'proposal');
    assert.ok(t1.lastModified);
    assert.equal(t2.status, 'rejected');
    const resumen = await api('/api/fhir/resumen');
    assert.equal(resumen.recursos.Task, 2);
    assert.equal(resumen.recursos.GuidanceResponse, 2);
  });
});
