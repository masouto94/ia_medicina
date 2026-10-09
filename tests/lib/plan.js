// Ejecuta planes de simulación contra la API de la app (POST /api/sim/plan) y espera el reporte.
// La comparación obtenido vs. esperado y las métricas las hace la app (src/simulacion.js), así los tests
// y el botón "Simular → Ejecutar un plan JSON…" usan exactamente la misma lógica.
// Formato de los planes: tests/README.md (sección "Formato de un plan").

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Importa la HCE y genera el asistente por defecto, con los ajustes de `conf` (como hace un plan). */
async function prepararAsistente(api, conf = {}) {
  await api('/api/sim/reset', { body: {} });
  await api('/api/hce/import', { body: {} });
  const cfg = await api('/api/assistant/default');
  if (conf.modulos) cfg.modulos = conf.modulos;
  if (conf.indicaciones !== undefined) cfg.indicaciones = conf.indicaciones;
  await api('/api/assistant', { body: { config: cfg } });
  for (const id of conf.pausar || []) await api(`/api/alarms/${id}`, { method: 'PUT', body: { activa: false } });
  for (const a of conf.agregar || []) await api('/api/alarms', { body: a });
}

/** Ejecuta un plan o un archivo de planes ({planes: [...]}) y devuelve el reporte completo: { resultados, metricas, motor, ... }. */
async function ejecutarReporte(api, contenido, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const nombre = contenido.nombre || 'plan de test';
  await api('/api/sim/plan', { body: { plan: contenido, nombre } });
  const t0 = Date.now();
  for (;;) {
    const e = await api('/api/sim/plan');
    if (e.estado !== 'corriendo') {
      if (e.estado === 'error') throw new Error(`La simulación falló: ${e.error}`);
      return e;
    }
    if (Date.now() - t0 > timeoutMs) {
      await api('/api/sim/plan/cancel', { body: {} });
      throw new Error('La simulación no terminó a tiempo');
    }
    await espera(150);
  }
}

/** Ejecuta un plan y devuelve un resultado por paso: { plan, paso, entrada, esperado, obtenido, evaluado, ok, fallas, motor }. */
async function ejecutarPlan(api, plan, opciones) {
  const rep = await ejecutarReporte(api, plan, opciones);
  return rep.resultados.map((r) => ({ ...r, motor: rep.motor }));
}

module.exports = { ejecutarPlan, ejecutarReporte, prepararAsistente };
