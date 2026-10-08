// Módulos = conocimiento + configuración. Incluye una patología nueva agregada sólo con un JSON.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('../../src/modulos');
const ALM = require('../../src/alarmas');

test('DM2 y HTA traen metas, umbrales, alertas y alarmas por defecto', () => {
  const cfg = ALM.ensure({ modulos: ['dm2', 'hta'] });
  assert.deepEqual(cfg.metas, { ayunasMin: 80, ayunasMax: 130, posprandialMax: 180, hba1c: 7, paSis: 130, paDia: 80 });
  assert.equal(cfg.umbrales.hipoGrave, 54);
  assert.equal(cfg.umbrales.paDiaAlarma, 110);
  assert.equal(cfg.umbrales.omisionesConsecutivas, 2);
  assert.ok(cfg.alarmas.some((a) => a.origen === 'dm2') && cfg.alarmas.some((a) => a.origen === 'hta'));
});

test('los módulos se activan según los diagnósticos SNOMED CT de la HCE', () => {
  assert.deepEqual(M.sugeridosPorDiagnostico(['44054006', '38341003']).sort(), ['dm2', 'hta']);
  assert.deepEqual(M.sugeridosPorDiagnostico(['44054006']), ['dm2']);
});

test('alertas para la médica: se informa la más grave por observación', () => {
  const cfg = ALM.ensure({ modulos: ['dm2', 'hta'] });
  assert.equal(M.evaluarAlerta({ tipo: 'glucemia', valor: 48 }, cfg).nivel, 'alta');
  assert.equal(M.evaluarAlerta({ tipo: 'glucemia', valor: 62 }, cfg).nivel, 'media');
  assert.equal(M.evaluarAlerta({ tipo: 'glucemia', valor: 120 }, cfg), null);
  assert.equal(M.evaluarAlerta({ tipo: 'presion', valor: 150, valor2: 95 }, cfg).nivel, 'baja');
  assert.match(M.evaluarAlerta({ tipo: 'hba1c', valor: 8.4 }, cfg).motivo, /HbA1c/);
});

test('las pautas del módulo para el modelo usan los valores configurados', () => {
  const cfg = ALM.ensure({ modulos: ['dm2'], umbrales: { hipo: 72, hipoGrave: 50 } });
  assert.match(M.instruccionesModelo(cfg)[0], /entre 50 y 72 mg\/dl/);
});

test('una patología nueva se suma con un JSON, sin tocar código', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-test-'));
  try {
    for (const f of fs.readdirSync(M.DIR)) fs.copyFileSync(path.join(M.DIR, f), path.join(dir, f));
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'modulo-epoc.json'), path.join(dir, 'epoc.json'));
    // se corre en otro proceso porque la carpeta de módulos se lee al cargar
    const script = `
      const M = require('./src/modulos'), ALM = require('./src/alarmas'), safety = require('./src/safety');
      const cfg = ALM.ensure({ modulos: M.sugeridosPorDiagnostico(['44054006', '13645005']) });
      console.log(JSON.stringify({
        ids: M.ids(),
        modulos: cfg.modulos,
        spo2Min: cfg.metas.spo2Min,
        alarmaTexto: safety.evaluar('Tengo los labios morados', cfg).reglas.map((r) => r.id),
        alarmaUmbral: ALM.evaluarReglas({ t: '', medidas: { spo2: 85 } }, cfg).map((r) => r.id),
        alerta: M.evaluarAlerta({ tipo: 'spo2', valor: 89 }, cfg),
        prompt: M.instruccionesModelo(cfg).length,
      }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), env: { ...process.env, KNOWLEDGE_DIR: dir } }).toString());
    assert.ok(out.ids.includes('epoc'));
    assert.deepEqual(out.modulos.sort(), ['dm2', 'epoc']);
    assert.equal(out.spo2Min, 92);
    assert.deepEqual(out.alarmaTexto, ['epoc-labios']);
    assert.deepEqual(out.alarmaUmbral, ['epoc-spo2']);
    assert.equal(out.alerta.reglaId, 'epoc-alerta-spo2');
    assert.equal(out.prompt, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
