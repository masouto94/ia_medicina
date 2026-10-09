// Segunda capa: validación de las alarmas que propone el modelo (guardrails).
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/guardrails');
const ALM = require('../../src/alarmas');

const cfg = ALM.ensure({ modulos: ['dm2', 'hta'] });
ALM.modificar(cfg, 'gen-dolor-toracico', { activa: false });
const CTX = ['DM2-05', 'IND-1'];

// [nombre, propuesta del modelo, mensaje de la paciente, ¿OpenEvidence ya consultado?, ¿aceptar?, control que debe fallar]
const CASOS = [
  ['válida: paráfrasis de una alarma activa', { regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['CONFIG'] }, 'Me corté y la sangre no se detiene', false, true],
  ['válida: umbral que cruza y figura en el mensaje', { regla_id: 'dm2-hipo-grave', fundamento: 'me dio 45', valor: 45, fuentes: ['CONFIG'] }, 'Me dio 45 recién', false, true],
  ['regla inventada', { regla_id: 'sepsis', fundamento: 'fiebre y escalofríos', fuentes: ['CONFIG'] }, 'Tengo fiebre y escalofríos', false, false, 'regla_configurada'],
  ['regla pausada', { regla_id: 'gen-dolor-toracico', fundamento: 'me duele el pecho', fuentes: ['CONFIG'] }, 'Me duele el pecho', false, false, 'regla_activa'],
  ['fuente OpenEvidence', { regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['CONFIG', 'OpenEvidence'] }, 'Me corté y la sangre no se detiene', false, false, 'fuentes_permitidas'],
  ['fragmento que no se le pasó', { regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['DM2-99'] }, 'Me corté y la sangre no se detiene', false, false, 'fuentes_permitidas'],
  ['sin fuentes', { regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene' }, 'Me corté y la sangre no se detiene', false, false, 'fuentes_permitidas'],
  ['fundamento de conocimiento general', { regla_id: 'gen-acv', fundamento: 'signos compatibles con accidente cerebrovascular isquémico', fuentes: ['CONFIG'] }, 'Me siento rara hoy', false, false, 'fundamento_en_mensaje'],
  ['umbral que no cruza', { regla_id: 'dm2-hipo-grave', fundamento: 'me dio 60', valor: 60, fuentes: ['CONFIG'] }, 'Me dio 60 recién', false, false, 'umbral_verificado'],
  ['umbral con valor inventado', { regla_id: 'dm2-hipo-grave', fundamento: 'glucemia baja', valor: 40, fuentes: ['CONFIG'] }, 'Me siento con la glucemia baja', false, false, 'umbral_verificado'],
  ['umbral con síntomas sin anclar en el mensaje', { regla_id: 'dm2-hipo-signos', fundamento: 'paciente con compromiso de conciencia', valor: 62, fuentes: ['CONFIG'] }, 'Me dio 62', false, false, 'fundamento_en_mensaje'],
  ['OpenEvidence consultado antes de decidir', { regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['CONFIG'] }, 'la sangre no se detiene', true, false, 'sin_fuentes_externas_previas'],
];

for (const [nombre, propuesta, mensaje, oe, aceptar, control] of CASOS) {
  test(`${aceptar ? 'acepta' : 'rechaza'}: ${nombre}`, () => {
    const r = G.validarAlarmaModelo({ alarma: { es_alarma: true, ...propuesta }, evidencia: mensaje, cfg, contextoIds: CTX, oeConsultado: oe });
    assert.equal(r.aceptada, aceptar, r.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check}: ${c.detalle}`).join('\n'));
    if (control) assert.ok(r.checks.some((c) => c.check === control && !c.ok), `debía fallar el control ${control}`);
  });
}

test('si el modelo no propone alarma, no hay nada que validar', () => {
  assert.equal(G.validarAlarmaModelo({ alarma: { es_alarma: false }, evidencia: 'hola', cfg }).aceptada, false);
});
