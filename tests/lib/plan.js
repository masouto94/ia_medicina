// Ejecuta un "plan" de simulación contra la API de la app y compara lo obtenido con lo esperado.
//
// Formato de un plan (JSON):
// {
//   "nombre": "Dolor torácico con la alarma pausada",
//   "configuracion": {                     // opcional, se aplica después de generar el asistente
//     "modulos": ["dm2", "hta"],           // reemplaza los módulos activos
//     "indicaciones": "Caminar 45 minutos", // reemplaza las indicaciones propias de la médica
//     "pausar": ["gen-dolor-toracico"],    // ids de alarmas a pausar
//     "agregar": [{ "nombre": "Fiebre alta", "tipo": "texto", "frases": "fiebre de 39" }]
//   },
//   "pasos": [
//     {
//       "id": "p1",
//       "momento": "+2h",                  // opcional: adelanta el reloj simulado (m, h o d)
//       "mensaje": "Me duele el pecho",    // o "archivo": "glucometro_48.jpg" (de muestras/) + "comentario"
//       "esperado": {
//         "alarma": false,                 // ¿se activó el protocolo de urgencia?
//         "origenAlarma": "regla",         // "regla" | "modelo"
//         "intencion": ["derivacion"],     // una o varias intenciones aceptables
//         "derivacion": "alta",            // true | false | "alta" | "media" | "baja"
//         "registro": ["glucemia"],        // tipos de observación que se tienen que registrar
//         "fuente": "IND-1",               // id de fragmento que la respuesta tiene que citar
//         "evidencia": false,              // ¿se consultó OpenEvidence?
//         "sugerencia": true               // ¿llegó una sugerencia de evidencia a la médica?
//       }
//     }
//   ]
// }
const PRIORIDAD = { baja: 1, media: 2, alta: 3 };

function parseMomento(m) {
  const x = String(m || '').match(/^\+?(\d+)\s*(m|h|d)$/);
  if (!x) throw new Error(`Momento no válido: "${m}" (usá +30m, +2h o +1d)`);
  return Number(x[1]) * { m: 1, h: 60, d: 1440 }[x[2]];
}

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

function obtener(antes, despues) {
  const nuevos = (k) => despues[k].slice(antes[k].length);
  const msgs = nuevos('messages');
  const paciente = msgs.find((m) => m.from === 'marta');
  const respuestas = msgs.filter((m) => m.from === 'asistente');
  const alarmaMsg = respuestas.find((m) => m.kind === 'alarm');
  const refs = despues.referrals.filter((r) => !antes.referrals.some((x) => x.id === r.id));
  const prio = refs.reduce((p, r) => Math.max(p, PRIORIDAD[r.prioridad] || 0), 0);
  return {
    intencion: paciente ? paciente.intent || null : null,
    alarma: !!alarmaMsg,
    origenAlarma: alarmaMsg ? alarmaMsg.origenAlarma || 'regla' : null,
    reglasAlarma: alarmaMsg ? (alarmaMsg.reglas || []).map((r) => r.id) : [],
    derivacion: prio ? Object.keys(PRIORIDAD).find((k) => PRIORIDAD[k] === prio) : null,
    registro: [...new Set(despues.observations.filter((o) => !antes.observations.some((x) => x.id === o.id)).map((o) => o.tipo))],
    fuentes: [...new Set(respuestas.flatMap((m) => (m.sources || []).map((s) => s.id)))],
    evidencia: despues.evidenceQueries.length > antes.evidenceQueries.length,
    sugerencia: despues.suggestions.length > antes.suggestions.length,
    respuesta: respuestas.map((m) => m.text).join('\n---\n'),
    traza: despues.traces[0] ? despues.traces[0].pasos.map((p) => `${p.paso}: ${p.detalle}`) : [],
  };
}

function comparar(esp = {}, obt) {
  const fallas = [];
  const f = (campo, e, o) => fallas.push(`${campo}: se esperaba ${JSON.stringify(e)} y se obtuvo ${JSON.stringify(o)}`);
  if ('alarma' in esp && esp.alarma !== obt.alarma) f('alarma', esp.alarma, obt.alarma);
  if ('origenAlarma' in esp && esp.origenAlarma !== obt.origenAlarma) f('origenAlarma', esp.origenAlarma, obt.origenAlarma);
  if ('intencion' in esp) {
    const ok = [].concat(esp.intencion);
    if (!ok.includes(obt.intencion)) f('intencion', ok, obt.intencion);
  }
  if ('derivacion' in esp) {
    const e = esp.derivacion;
    const ok = e === true ? !!obt.derivacion : e === false ? !obt.derivacion : obt.derivacion === e;
    if (!ok) f('derivacion', e, obt.derivacion);
  }
  for (const t of [].concat(esp.registro || [])) if (!obt.registro.includes(t)) f('registro', t, obt.registro);
  if ('fuente' in esp && !obt.fuentes.includes(esp.fuente)) f('fuente', esp.fuente, obt.fuentes);
  if ('evidencia' in esp && esp.evidencia !== obt.evidencia) f('evidencia', esp.evidencia, obt.evidencia);
  if ('sugerencia' in esp && esp.sugerencia !== obt.sugerencia) f('sugerencia', esp.sugerencia, obt.sugerencia);
  return fallas;
}

/** Ejecuta un plan completo. Devuelve un resultado por paso. */
async function ejecutarPlan(api, plan) {
  await prepararAsistente(api, plan.configuracion);
  const resultados = [];
  for (const [i, paso] of plan.pasos.entries()) {
    if (paso.momento) await api('/api/sim/advance', { body: { minutes: parseMomento(paso.momento) } });
    const antes = await api('/api/state');
    if (paso.archivo) await api('/api/chat/sample', { body: { archivo: paso.archivo, caption: paso.comentario || '' } });
    else await api('/api/chat/text', { body: { text: paso.mensaje } });
    const despues = await api('/api/state');
    const obtenido = obtener(antes, despues);
    const fallas = comparar(paso.esperado, obtenido);
    resultados.push({ plan: plan.nombre, paso: paso.id || `paso ${i + 1}`, entrada: paso.mensaje || `[${paso.archivo}] ${paso.comentario || ''}`.trim(), esperado: paso.esperado || {}, obtenido, ok: fallas.length === 0, fallas, motor: despues.llm.model || 'simulado' });
  }
  return resultados;
}

module.exports = { ejecutarPlan, prepararAsistente, obtener, comparar, parseMomento };
