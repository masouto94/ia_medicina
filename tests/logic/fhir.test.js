// Export FHIR: terminologías (SNOMED CT en motivos de derivación y medicación; UCUM en unidades).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { iniciar } = require('../lib/servidor');
const { ejecutarPlan } = require('../lib/plan');
const TERM = require('../../src/terminologia');
const M = require('../../src/modulos');

const SNOMED = 'http://snomed.info/sct';
const UCUM = 'http://unitsofmeasure.org';

test('terminología: motivos, UCUM y códigos de las alarmas predeterminadas', async (t) => {
  await t.test('la lista de motivos tiene códigos SNOMED CT con formato válido y uno por defecto', () => {
    for (const m of TERM.MOTIVOS) assert.match(m.code, /^\d{6,18}$/, m.clave);
    assert.equal(TERM.motivo('clave-inexistente').code, '11429006');
  });
  await t.test('las unidades se traducen a UCUM', () => {
    assert.equal(TERM.ucum('mg/dl'), 'mg/dL');
    assert.equal(TERM.ucum('mmHg'), 'mm[Hg]');
    assert.equal(TERM.ucum('%'), '%');
    assert.equal(TERM.ucum('unidad rara'), null);
    assert.deepEqual(TERM.cantidad(5, 'unidad rara'), { value: 5, unit: 'unidad rara' }, 'sin UCUM no se inventa un código');
  });
  await t.test('todas las alarmas genéricas y de módulos tienen código SNOMED CT', () => {
    const gen = JSON.parse(fs.readFileSync(path.join(M.DIR, 'alarmas_genericas.json'), 'utf8')).alarmas;
    const mods = M.ids().flatMap((id) => M.get(id).configuracion.alarmas);
    for (const a of [...gen, ...mods]) assert.ok(a.snomed && /^\d{6,18}$/.test(a.snomed.code) && a.snomed.display, a.id);
  });
});

test('export FHIR con terminologías', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock' } });
  t.after(() => srv.detener());
  await ejecutarPlan(srv.api, {
    nombre: 'datos para el export',
    configuracion: { agregar: [{ nombre: 'Fiebre alta', tipo: 'texto', frases: 'fiebre de 39', motivo: 'sintoma_fiebre' }] },
    pasos: [
      { mensaje: 'Me duele el pecho' },
      { mensaje: 'Tengo fiebre de 39' },
      { mensaje: 'Me midió 150/95 la presión' },
      { mensaje: 'Me dio 145 en ayunas' },
      { archivo: 'foto_pie_lesion.jpg' },
      { archivo: 'blister_glibenclamida.jpg' },
      { archivo: 'informe_laboratorio.pdf' },
    ],
  });
  await srv.api('/api/sim/next-dose', { body: {} });
  const st = await srv.api('/api/state');
  const rem = st.messages.filter((m) => m.kind === 'reminder').pop();
  await srv.api(`/api/reminder/${rem.id}`, { body: { tomada: true } });
  const b = await srv.api('/api/fhir/bundle');
  const de = (tipo) => b.entry.map((e) => e.resource).filter((r) => r.resourceType === tipo);

  await t.test('Communication.reasonCode: coding SNOMED CT + texto original', () => {
    const coms = de('Communication').filter((c) => c.reasonCode);
    assert.ok(coms.length >= 4, `hay ${coms.length} derivaciones`);
    for (const c of coms) {
      const cod = c.reasonCode[0].coding[0];
      assert.equal(cod.system, SNOMED);
      assert.match(cod.code, /^\d+$/);
      assert.ok(c.reasonCode[0].text, 'conserva el motivo en texto');
    }
    const codigos = coms.map((c) => c.reasonCode[0].coding[0].code);
    for (const [code, motivo] of [['29857009', 'dolor torácico'], ['386661006', 'fiebre (alarma de la médica)'], ['416462003', 'foto de lesión'], ['182836005', 'medicamento no indicado']]) {
      assert.ok(codigos.includes(code), `falta ${code} (${motivo}); hay ${codigos.join(', ')}`);
    }
  });

  await t.test('Observation: unidades con sistema UCUM', () => {
    const obs = de('Observation');
    const cantidades = obs.flatMap((o) => [o.valueQuantity, ...(o.component || []).map((c) => c.valueQuantity)]).filter(Boolean);
    assert.ok(cantidades.length >= 10);
    for (const q of cantidades) {
      assert.equal(q.system, UCUM, `${q.value} ${q.unit}`);
      assert.ok(q.code, `${q.value} ${q.unit}`);
    }
    const pa = obs.find((o) => o.component);
    assert.deepEqual(pa.component.map((c) => c.valueQuantity.code), ['mm[Hg]', 'mm[Hg]']);
    const glu = obs.find((o) => o.code.coding[0].code === '2339-0');
    assert.equal(glu.valueQuantity.code, 'mg/dL');
  });

  await t.test('Goal: rangos de las metas con UCUM', () => {
    const g = de('Goal').find((x) => x.id === 'goal-dm2-glucemia');
    assert.equal(g.target[0].detailRange.low.code, 'mg/dL');
    assert.equal(g.target[0].detailRange.high.system, UCUM);
  });

  await t.test('MedicationStatement: medicación codificada en SNOMED CT como la MedicationRequest', () => {
    const ms = de('MedicationStatement');
    assert.ok(ms.length >= 1);
    for (const m of ms) assert.equal(m.medicationCodeableConcept.coding[0].system, SNOMED);
    const codes = new Set(ms.map((m) => m.medicationCodeableConcept.coding[0].code));
    assert.ok(codes.has('372567009') || codes.has('372658000'), [...codes].join(', '));
  });
});
