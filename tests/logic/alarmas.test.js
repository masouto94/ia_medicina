// Primera capa (determinística): alarmas configurables.
const test = require('node:test');
const assert = require('node:assert/strict');
const ALM = require('../../src/alarmas');
const safety = require('../../src/safety');

const nuevaCfg = () => ALM.ensure({ modulos: ['dm2', 'hta'] });
const reglas = (texto, cfg) => safety.evaluar(texto, cfg).reglas.map((r) => r.id);

test('las alarmas genéricas incluyen hemorragia y no se pueden eliminar', () => {
  const cfg = nuevaCfg();
  assert.ok(cfg.alarmas.find((a) => a.id === 'gen-hemorragia' && a.origen === 'generica'));
  assert.throws(() => ALM.eliminar(cfg, 'gen-hemorragia'), /no se pueden eliminar/);
});

test('frases: disparan con el mensaje y respetan la negación simple', () => {
  const cfg = nuevaCfg();
  const casos = [
    ['Me duele el pecho', ['gen-dolor-toracico']],
    ['No tengo dolor de pecho, solo cansancio', []],
    ['Sin falta de aire, todo bien', []],
    ['Vomité sangre', ['gen-hemorragia']],
    ['Me sangra mucho la nariz y no para de sangrar', ['gen-hemorragia']],
    ['Hola, ¿puedo comer pan?', []],
  ];
  for (const [txt, esperado] of casos) assert.deepEqual(reglas(txt, cfg), esperado, txt);
});

test('umbrales: glucemia y presión, con y sin síntomas requeridos', () => {
  const cfg = nuevaCfg();
  assert.deepEqual(reglas('Me dio 45 y estoy temblando', cfg), ['dm2-hipo-grave']);
  assert.deepEqual(reglas('Me dio 62, estoy un poco mareada', cfg), []);
  assert.deepEqual(reglas('Me dio 62 y me siento muy mal', cfg), ['dm2-hipo-signos']);
  assert.deepEqual(reglas('Me dio 320 y estoy vomitando', cfg), ['dm2-hiper-sintomas']);
  assert.deepEqual(reglas('Me midió 185/100 y me duele la cabeza', cfg), ['hta-pas-sintomas']);
  assert.deepEqual(reglas('Me midió 185/100', cfg), [], 'sin síntomas no es alarma');
  assert.ok(safety.evaluar('Me dio 45', cfg).instrucciones.includes(ALM.AZUCAR), 'la hipoglucemia grave indica azúcar');
});

test('pausar una alarma la desactiva y reactivarla la vuelve a activar', () => {
  const cfg = nuevaCfg();
  ALM.modificar(cfg, 'gen-dolor-toracico', { activa: false });
  assert.equal(safety.evaluar('Me duele el pecho', cfg).alarma, false);
  ALM.modificar(cfg, 'gen-dolor-toracico', { activa: true });
  assert.equal(safety.evaluar('Me duele el pecho', cfg).alarma, true);
});

test('modificar el valor de una alarma que usa un umbral edita ese umbral (PA diastólica)', () => {
  const cfg = nuevaCfg();
  assert.equal(safety.evaluar('Me midió 160/115 con dolor de cabeza', cfg).alarma, true);
  ALM.modificar(cfg, 'hta-pad-sintomas', { valor: 120 });
  assert.equal(cfg.umbrales.paDiaAlarma, 120);
  assert.equal(safety.evaluar('Me midió 160/115 con dolor de cabeza', cfg).alarma, false);
});

test('una alarma de módulo eliminada no reaparece', () => {
  const cfg = nuevaCfg();
  ALM.eliminar(cfg, 'dm2-hiper-sintomas');
  ALM.ensure(cfg);
  assert.equal(cfg.alarmas.some((a) => a.id === 'dm2-hiper-sintomas'), false);
});

test('la médica puede agregar alarmas por frases y por umbral', () => {
  const cfg = nuevaCfg();
  cfg.alarmas.push(ALM.crear({ nombre: 'Fiebre alta', tipo: 'texto', frases: 'fiebre de 39, fiebre alta, escalofríos' }));
  cfg.alarmas.push(ALM.crear({ nombre: 'Glucemia > 400', tipo: 'umbral', variable: 'glucemia', operador: '>', valor: 400 }));
  assert.deepEqual(safety.evaluar('Tengo fiebre alta desde ayer', cfg).reglas.map((r) => r.nombre), ['Fiebre alta']);
  assert.deepEqual(safety.evaluarMedicion({ glucemia: 420 }, cfg).reglas.map((r) => r.nombre), ['Glucemia > 400']);
  assert.throws(() => ALM.crear({ nombre: 'x', tipo: 'texto', frases: '' }), /al menos una frase/);
});

test('las alarmas de un módulo inactivo no se evalúan', () => {
  const cfg = ALM.ensure({ modulos: ['dm2'] });
  assert.equal(safety.evaluar('Me midió 185/100 y me duele la cabeza', cfg).alarma, false);
});
