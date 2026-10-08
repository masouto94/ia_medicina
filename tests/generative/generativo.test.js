// Casos clínicos contra el asistente con el LLM real (Claude Code o API key, según .env).
// Es lento (5-25 s por paso) y no determinístico: la misma corrida puede variar.
// Opcional: GENERATIVE_REPEAT=3 repite cada plan para ver la variabilidad.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { iniciar } = require('../lib/servidor');
const { ejecutarPlan } = require('../lib/plan');

const { planes } = JSON.parse(fs.readFileSync(path.join(__dirname, 'casos.json'), 'utf8'));
const REPETIR = Math.max(1, Number(process.env.GENERATIVE_REPEAT) || 1);

test('casos clínicos con el LLM real', async (t) => {
  const srv = await iniciar();
  t.after(() => srv.detener());
  const estado = await srv.api('/api/state');
  assert.ok(estado.llm.enabled, `No hay un motor de IA disponible: ${estado.llm.detail || 'iniciá sesión en Claude Code o configurá ANTHROPIC_API_KEY'}. Para probar sin LLM: npm test logic`);
  console.log(`  Motor: ${estado.llm.model}  ·  ${planes.length} planes × ${REPETIR} repetición(es)\n`);

  const todos = [];
  for (let rep = 1; rep <= REPETIR; rep++) {
    for (const plan of planes) {
      await t.test(`${plan.nombre}${REPETIR > 1 ? ` (#${rep})` : ''}`, async () => {
        const res = await ejecutarPlan(srv.api, plan);
        todos.push(...res.map((r) => ({ ...r, repeticion: rep })));
        const fallas = res.filter((r) => !r.ok);
        assert.equal(fallas.length, 0, fallas.map((r) => `${r.entrada}\n    ${r.fallas.join('\n    ')}\n    respuesta: ${r.obtenido.respuesta.slice(0, 200)}`).join('\n'));
      });
    }
  }

  // Reporte: aciertos y matriz de alarmas (esperada vs obtenida)
  const conAlarma = todos.filter((r) => 'alarma' in r.esperado);
  const m = { vp: 0, fn: 0, fp: 0, vn: 0 };
  for (const r of conAlarma) m[r.esperado.alarma ? (r.obtenido.alarma ? 'vp' : 'fn') : r.obtenido.alarma ? 'fp' : 'vn']++;
  const reporte = {
    fecha: new Date().toISOString(),
    motor: estado.llm.model,
    pasos: todos.length,
    correctos: todos.filter((r) => r.ok).length,
    alarmas: { ...m, sensibilidad: m.vp + m.fn ? +(m.vp / (m.vp + m.fn)).toFixed(2) : null, falsosPositivos: m.fp },
    resultados: todos,
  };
  const dir = path.join(__dirname, '..', 'resultados');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, `generative-${reporte.fecha.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(archivo, JSON.stringify(reporte, null, 2));
  console.log(`\n  Correctos: ${reporte.correctos}/${reporte.pasos}  ·  alarmas: sensibilidad ${reporte.alarmas.sensibilidad ?? '—'}, falsos positivos ${m.fp}, falsos negativos ${m.fn}`);
  console.log(`  Reporte: ${path.relative(process.cwd(), archivo)}\n`);
});
