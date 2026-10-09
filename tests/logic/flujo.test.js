// Recorrido completo de la app (servidor + API), sin LLM real:
//  - en modo simulado (reglas y respuestas predefinidas)
//  - con un "Claude falso" que devuelve propuestas tramposas, para probar los guardrails de punta a punta
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { iniciar } = require('../lib/servidor');
const { ejecutarPlan, prepararAsistente } = require('../lib/plan');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');

test('modo simulado', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock' } });
  t.after(() => srv.detener());
  const { api } = srv;

  await t.test('importar la HCE y generar el asistente con los módulos de sus diagnósticos', async () => {
    await prepararAsistente(api);
    const s = await api('/api/state');
    assert.equal(s.llm.enabled, false);
    assert.deepEqual(s.assistant.config.modulos.sort(), ['dm2', 'hta']);
    assert.ok(s.assistant.config.alarmas.length >= 14);
  });

  await t.test('alarmas: genérica, pausada, de umbral y agregada por la médica', async () => {
    const plan = {
      nombre: 'alarmas en modo simulado',
      configuracion: { pausar: ['gen-dolor-toracico'], agregar: [{ nombre: 'Fiebre alta', tipo: 'texto', frases: 'fiebre de 39' }] },
      pasos: [
        { mensaje: 'Me duele el pecho', esperado: { alarma: false, derivacion: true } },
        { mensaje: 'No me para de sangrar la herida', esperado: { alarma: true, origenAlarma: 'regla' } },
        { mensaje: 'Me dio 45 y estoy temblando', esperado: { alarma: true, registro: ['glucemia'] } },
        { mensaje: 'Tengo fiebre de 39', esperado: { alarma: true } },
        { mensaje: '¿Puedo comer pan?', esperado: { alarma: false, intencion: 'educativa', derivacion: false } },
        { archivo: 'glucometro_48.jpg', esperado: { alarma: true, registro: ['glucemia'] } },
        { archivo: 'foto_pie_lesion.jpg', comentario: 'me lastimé y no para de sangrar', esperado: { alarma: true, origenAlarma: 'regla' } },
        { archivo: 'tensiometro_148_92.jpg', esperado: { alarma: false, registro: ['presion'] } },
      ],
    };
    const res = await ejecutarPlan(api, plan);
    for (const r of res) assert.ok(r.ok, `${r.entrada}: ${r.fallas.join('; ')}`);
  });

  await t.test('no se puede eliminar una alarma genérica (error 400)', async () => {
    await assert.rejects(api('/api/alarms/gen-hemorragia', { method: 'DELETE' }), (e) => e.status === 400);
  });

  await t.test('el export FHIR incluye objetivos por módulo y los recursos registrados', async () => {
    const b = await api('/api/fhir/bundle');
    const tipos = new Set(b.entry.map((e) => e.resource.resourceType));
    for (const t of ['Patient', 'CarePlan', 'Goal', 'Observation', 'Communication']) assert.ok(tipos.has(t), t);
    const goals = b.entry.filter((e) => e.resource.resourceType === 'Goal').map((e) => e.resource.id);
    assert.ok(goals.includes('goal-dm2-glucemia') && goals.includes('goal-hta-pa-sistolica'), goals.join(', '));
  });
});

test('Claude falso: guardrails de punta a punta', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'claude-code', CLAUDE_CODE_BIN: FAKE } });
  t.after(() => srv.detener());
  const { api } = srv;

  const plan = {
    nombre: 'propuestas del modelo',
    configuracion: { pausar: ['gen-dolor-toracico'] },
    pasos: [
      { id: 'válida', mensaje: 'CASO_VALIDA me corté y la sangre no se detiene', esperado: { alarma: true, origenAlarma: 'modelo' } },
      { id: 'regla inventada', mensaje: 'CASO_INVENTADA tengo fiebre y escalofrios', esperado: { alarma: false, derivacion: 'alta', evidencia: false } },
      { id: 'cita OpenEvidence', mensaje: 'CASO_OE la sangre no se detiene', esperado: { alarma: false, derivacion: 'alta', evidencia: false } },
      { id: 'regla pausada', mensaje: 'CASO_PAUSADA me molesta el pecho', esperado: { alarma: false, derivacion: 'alta' } },
      { id: 'umbral inventado', mensaje: 'CASO_UMBRAL_FALSO tengo la glucemia baja', esperado: { alarma: false, derivacion: 'alta' } },
      { id: 'sin fuentes', mensaje: 'CASO_SIN_FUENTES la sangre no se detiene', esperado: { alarma: false, derivacion: 'alta' } },
      { id: 'evidencia sin alarma (control)', mensaje: 'CASO_EVIDENCIA ¿me puedo pasar al Ozempic?', esperado: { alarma: false, evidencia: true, sugerencia: true } },
      { id: 'visión: regla inventada', archivo: 'glucometro_48.jpg', comentario: 'CASO_VISION_INVENTADA', esperado: { alarma: true, origenAlarma: 'regla' } },
    ],
  };
  const res = await ejecutarPlan(api, plan);
  for (const r of res) {
    await t.test(r.paso, () => {
      assert.ok(r.ok, r.fallas.join('; '));
      if (!r.obtenido.alarma) assert.doesNotMatch(r.obtenido.respuesta, /aspirina/, 'la respuesta del modelo no debe llegar si su alarma fue rechazada');
    });
  }

  await t.test('visión: una propuesta inventada se rechaza si las reglas no disparan', async () => {
    const [r] = await ejecutarPlan(api, { nombre: 'visión', configuracion: { pausar: ['dm2-hipo-grave'] }, pasos: [{ archivo: 'glucometro_48.jpg', comentario: 'CASO_VISION_INVENTADA', esperado: { alarma: false, derivacion: 'alta', registro: ['glucemia'] } }] });
    assert.ok(r.ok, r.fallas.join('; '));
  });
});
