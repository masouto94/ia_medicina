// Simulación a demanda con un plan JSON: validación, comparación, métricas y la API de la app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { iniciar } = require('../lib/servidor');
const { ejecutarReporte } = require('../lib/plan');
const E = require('../../src/evaluacion');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-claude.js');
const PLANES_DIR = path.join(__dirname, '..', '..', 'muestras', 'planes');

// ---------- Funciones puras ----------
test('momento: +30m, +2h y +1d en minutos', () => {
  assert.equal(E.parseMomento('+30m'), 30);
  assert.equal(E.parseMomento('+2h'), 120);
  assert.equal(E.parseMomento('1d'), 1440);
  assert.throws(() => E.parseMomento('mañana'), /momento no válido/);
});

test('validación del esperado: campos y tipos', () => {
  assert.deepEqual(E.validarEsperado({ alarma: true, derivacion: 'alta', intencion: ['educativa', 'derivacion'], registro: 'glucemia', fueraDeAlcance: false }), []);
  assert.match(E.validarEsperado({ alarm: true }).join(), /desconocidos: alarm/);
  assert.match(E.validarEsperado({ alarma: 'si' }).join(), /"alarma" tiene que ser true o false/);
  assert.match(E.validarEsperado({ derivacion: 'urgente' }).join(), /"derivacion"/);
  assert.match(E.validarEsperado({ intencion: 'charla' }).join(), /intención no válida: charla/);
  assert.match(E.validarEsperado({ origenAlarma: 'médica' }).join(), /"origenAlarma"/);
});

test('fuera de alcance: correcto si se deriva o se declina sin contenido; error si se responde', () => {
  const base = { alarma: false, intencion: 'derivacion', derivacion: 'baja', codigosDerivacion: [], registro: [], fuentes: [], evidencia: false, sugerencia: false };
  const casos = [
    [base, 'derivada'],
    [{ ...base, intencion: 'educativa' }, 'derivada'], // "no te lo puedo responder, se lo paso a la Dra." clasificada como educativa
    [{ ...base, derivacion: null }, 'declinada'], // "eso lo tiene que ver el médico de tu hija"
    [{ ...base, intencion: 'otro', derivacion: null }, 'declinada'],
    [{ ...base, intencion: 'educativa', derivacion: null }, 'respondida'],
    [{ ...base, derivacion: null, fuentes: ['DM2-08'] }, 'respondida'],
    [{ ...base, derivacion: null, evidencia: true }, 'respondida'],
  ];
  for (const [obt, manejo] of casos) {
    assert.equal(E.manejoFueraDeAlcance(obt), manejo, JSON.stringify(obt));
    assert.equal(E.comparar({ fueraDeAlcance: true }, obt).length, manejo === 'respondida' ? 1 : 0, JSON.stringify(obt));
  }
  assert.deepEqual(E.comparar({ fueraDeAlcance: true, derivacion: true }, { ...base, derivacion: null }).length, 1, 'con derivacion: true se exige derivar');
});

test('métricas: sensibilidad, falsos positivos, derivaciones y fuera de alcance', () => {
  const r = (esperado, obtenido) => {
    const o = { alarma: false, intencion: 'otro', derivacion: null, codigosDerivacion: [], registro: [], fuentes: [], evidencia: false, sugerencia: false, sinRespaldo: false, ...obtenido };
    const fallas = E.comparar(esperado, o);
    return { esperado, obtenido: o, evaluado: Object.keys(esperado).length > 0, ok: !fallas.length, fallas };
  };
  const m = E.metricas([
    r({ alarma: true }, { alarma: true }), // VP
    r({ alarma: true }, { alarma: false }), // FN
    r({ alarma: false }, { alarma: true }), // FP
    r({ alarma: false }, {}), // VN
    r({ alarma: false }, {}), // VN
    r({ derivacion: 'alta' }, { derivacion: 'alta' }),
    r({ derivacion: true }, {}),
    r({ fueraDeAlcance: true }, { intencion: 'derivacion', derivacion: 'baja' }),
    r({ fueraDeAlcance: true }, { intencion: 'derivacion' }),
    r({ fueraDeAlcance: true }, { intencion: 'educativa', sinRespaldo: true }),
    r({}, { intencion: 'educativa', sinRespaldo: true }), // sin expectativa: no se evalúa, pero cuenta como respuesta sin fuente
  ]);
  assert.equal(m.pasos, 11);
  assert.equal(m.evaluados, 10);
  assert.deepEqual([m.alarmas.vp, m.alarmas.fn, m.alarmas.fp, m.alarmas.vn], [1, 1, 1, 2]);
  assert.equal(m.alarmas.sensibilidad, 0.5);
  assert.equal(m.alarmas.especificidad, 0.67);
  assert.equal(m.alarmas.falsosPositivos, 1);
  assert.deepEqual(m.derivaciones, { evaluadas: 2, correctas: 1, tasa: 0.5 });
  assert.deepEqual(m.fueraDeAlcance, { preguntas: 3, correctas: 2, derivadas: 1, declinadas: 1, respondidas: 1, respuestasSinRespaldo: 2 });
  assert.equal(E.metricas([]).alarmas.sensibilidad, null, 'sin casos no hay sensibilidad (no 0)');
});

// ---------- API de la app ----------
test('API de simulación con plan (modo simulado)', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock' } });
  t.after(() => srv.detener());
  const { api } = srv;

  await t.test('los planes de ejemplo se listan y son válidos', async () => {
    const lista = await api('/api/sim/planes');
    const archivos = fs.readdirSync(PLANES_DIR).filter((f) => f.endsWith('.json'));
    assert.equal(lista.length, archivos.length);
    for (const p of lista) {
      const v = await api('/api/sim/plan/validate', { body: { plan: p.contenido } });
      assert.equal(v.pasos, p.pasos, p.archivo);
    }
  });

  await t.test('un plan inválido se rechaza con un mensaje que dice qué corregir', async () => {
    const casos = [
      [{ nombre: 'x' }, /falta la lista "pasos"/],
      [{ pasos: [{ momento: '+1h' }] }, /paso 1: falta "mensaje" o "archivo"/],
      [{ pasos: [{ archivo: 'no_existe.jpg' }] }, /no está en muestras/],
      [{ pasos: [{ mensaje: 'hola', momento: 'luego' }] }, /momento no válido/],
      [{ pasos: [{ mensaje: 'hola', esperado: { alarm: true } }] }, /desconocidos: alarm/],
      [{ configuracion: { modulos: ['epoc'] }, pasos: [{ mensaje: 'hola' }] }, /módulos desconocidos: epoc/],
      [{ planes: [{ pasos: [{ mensaje: 'a' }] }, { nombre: 'segundo', pasos: [] }] }, /plan 2 \("segundo"\)/],
    ];
    for (const [plan, re] of casos) await assert.rejects(api('/api/sim/plan', { body: { plan } }), (e) => e.status === 400 && re.test(e.message), JSON.stringify(plan));
  });

  await t.test('"Un día de Marta": momentos, reloj, alarma y reporte', async () => {
    const plan = JSON.parse(fs.readFileSync(path.join(PLANES_DIR, '01_dia_de_marta.json'), 'utf8'));
    const rep = await ejecutarReporte(api, plan);
    assert.equal(rep.estado, 'terminada');
    assert.equal(rep.hechos, plan.pasos.length);
    for (const r of rep.resultados) assert.ok(r.ok, `${r.paso}: ${r.fallas.join('; ')}`);
    assert.equal(rep.metricas.alarmas.sensibilidad, 1);
    assert.equal(rep.metricas.alarmas.fp, 0);
    assert.equal(rep.metricas.fueraDeAlcance.correctas, 1);
    // el reloj avanzó con los momentos (+30m +2h +3h +5h +4h = 14h 30m desde las 10:00 → 00:30 del día siguiente)
    const s = await api('/api/state');
    assert.equal(s.clock, Date.parse('2026-10-06T00:30:00-03:00'));
    assert.match(s.traces[0].evento, /Simulación con plan/);
  });

  await t.test('la batería de alarmas detecta todas las urgencias sin falsos positivos', async () => {
    const plan = JSON.parse(fs.readFileSync(path.join(PLANES_DIR, '02_bateria_alarmas.json'), 'utf8'));
    const rep = await ejecutarReporte(api, plan);
    assert.equal(rep.planes.length, plan.planes.length);
    assert.equal(rep.metricas.alarmas.sensibilidad, 1);
    assert.equal(rep.metricas.alarmas.falsosPositivos, 0);
    assert.equal(rep.metricas.derivaciones.tasa, 1);
  });

  await t.test('una configuración que no se puede aplicar termina en error con el nombre del plan', async () => {
    await api('/api/sim/plan', { body: { plan: { nombre: 'pausa inexistente', configuracion: { pausar: ['no-existe'] }, pasos: [{ mensaje: 'hola' }] } } });
    let e;
    do e = await api('/api/sim/plan');
    while (e.estado === 'corriendo');
    assert.equal(e.estado, 'error');
    assert.match(e.error, /pausa inexistente: no se pudo aplicar la configuración/);
  });

  await t.test('el reporte se puede descargar', async () => {
    const r = await fetch(`${srv.base}/api/sim/plan?download=1`);
    assert.match(r.headers.get('content-disposition') || '', /attachment; filename="reporte-sim-\d+\.json"/);
  });
});

test('mientras corre un plan, la app no acepta cambios y se puede cancelar', async (t) => {
  // con el Claude falso cada paso tarda lo que tarda en arrancar un proceso: da tiempo a probar el bloqueo
  const srv = await iniciar({ env: { LLM_PROVIDER: 'claude-code', CLAUDE_CODE_BIN: FAKE } });
  t.after(() => srv.detener());
  const { api } = srv;
  const pasos = Array.from({ length: 12 }, (_, i) => ({ mensaje: `¿Puedo comer frutas? (${i + 1})`, esperado: { alarma: false } }));
  const ini = await api('/api/sim/plan', { body: { plan: { nombre: 'largo', pasos } } });
  assert.equal(ini.estado, 'corriendo');
  assert.equal(ini.total, 12);

  await assert.rejects(api('/api/chat/text', { body: { text: 'hola' } }), (e) => e.status === 409);
  await assert.rejects(api('/api/alarms/gen-disnea', { method: 'PUT', body: { activa: false } }), (e) => e.status === 409);
  await assert.rejects(api('/api/sim/plan', { body: { plan: { pasos: [{ mensaje: 'x' }] } } }), (e) => e.status === 409);
  const s = await api('/api/state');
  assert.equal(s.busy, true);
  assert.equal(s.simulacion.estado, 'corriendo');

  await api('/api/sim/plan/cancel', { body: {} });
  let e;
  do {
    await new Promise((r) => setTimeout(r, 100));
    e = await api('/api/sim/plan');
  } while (e.estado === 'corriendo');
  assert.equal(e.estado, 'cancelada');
  assert.ok(e.hechos < e.total, `${e.hechos}/${e.total}`);
  await api('/api/chat/text', { body: { text: 'hola' } }); // vuelve a aceptar cambios
});
