// Evaluación de una simulación con plan: qué se obtuvo en un paso, comparación con lo esperado y métricas.
// Funciones puras (sin estado): las usan la simulación de la app (src/simulacion.js) y los tests.
const PRIORIDAD = { baja: 1, media: 2, alta: 3 };
const INTENCIONES = ['educativa', 'registro', 'adherencia', 'turno', 'derivacion', 'alarma', 'otro'];
const CAMPOS_ESPERADO = ['alarma', 'origenAlarma', 'intencion', 'derivacion', 'codigoDerivacion', 'registro', 'fuente', 'evidencia', 'sugerencia', 'fueraDeAlcance'];

function parseMomento(m) {
  const x = String(m || '').match(/^\+?(\d+)\s*(m|h|d)$/);
  if (!x) throw new Error(`momento no válido: "${m}" (usá +30m, +2h o +1d)`);
  return Number(x[1]) * { m: 1, h: 60, d: 1440 }[x[2]];
}

/** Revisa los campos y tipos de un "esperado". Devuelve la lista de errores (vacía si está bien). */
function validarEsperado(esp = {}) {
  const err = [];
  const desconocidos = Object.keys(esp).filter((k) => !CAMPOS_ESPERADO.includes(k));
  if (desconocidos.length) err.push(`campos esperados desconocidos: ${desconocidos.join(', ')} (válidos: ${CAMPOS_ESPERADO.join(', ')})`);
  for (const k of ['alarma', 'evidencia', 'sugerencia', 'fueraDeAlcance']) if (k in esp && typeof esp[k] !== 'boolean') err.push(`"${k}" tiene que ser true o false`);
  if ('origenAlarma' in esp && !['regla', 'modelo'].includes(esp.origenAlarma)) err.push('"origenAlarma" tiene que ser "regla" o "modelo"');
  if ('derivacion' in esp && ![true, false, 'alta', 'media', 'baja'].includes(esp.derivacion)) err.push('"derivacion" tiene que ser true, false, "alta", "media" o "baja"');
  if ('intencion' in esp) {
    const malas = [].concat(esp.intencion).filter((x) => !INTENCIONES.includes(x));
    if (malas.length) err.push(`intención no válida: ${malas.join(', ')} (válidas: ${INTENCIONES.join(', ')})`);
  }
  for (const k of ['codigoDerivacion', 'fuente']) if (k in esp && typeof esp[k] !== 'string') err.push(`"${k}" tiene que ser un texto`);
  if ('registro' in esp && ![].concat(esp.registro).every((x) => typeof x === 'string')) err.push('"registro" tiene que ser un texto o una lista de textos');
  return err;
}

function obtener(antes, despues) {
  const nuevos = (k) => despues[k].slice(antes[k].length);
  const msgs = nuevos('messages');
  const paciente = msgs.find((m) => m.from === 'marta');
  const respuestas = msgs.filter((m) => m.from === 'asistente');
  const alarmaMsg = respuestas.find((m) => m.kind === 'alarm');
  const refs = despues.referrals.filter((r) => !antes.referrals.some((x) => x.id === r.id));
  const prio = refs.reduce((p, r) => Math.max(p, PRIORIDAD[r.prioridad] || 0), 0);
  const fuentes = [...new Set(respuestas.flatMap((m) => (m.sources || []).map((s) => s.id)))];
  const evidencia = despues.evidenceQueries.length > antes.evidenceQueries.length;
  const intencion = paciente ? paciente.intent || null : null;
  return {
    intencion,
    alarma: !!alarmaMsg,
    origenAlarma: alarmaMsg ? alarmaMsg.origenAlarma || 'regla' : null,
    reglasAlarma: alarmaMsg ? (alarmaMsg.reglas || []).map((r) => r.id) : [],
    derivacion: prio ? Object.keys(PRIORIDAD).find((k) => PRIORIDAD[k] === prio) : null,
    codigosDerivacion: refs.map((r) => (r.codigo ? r.codigo.code : null)).filter(Boolean),
    registro: [...new Set(despues.observations.filter((o) => !antes.observations.some((x) => x.id === o.id)).map((o) => o.tipo))],
    fuentes,
    evidencia,
    sugerencia: despues.suggestions.length > antes.suggestions.length,
    // respuesta educativa sin fuente citada, sin derivar y sin evidencia: posible respuesta fuera de alcance
    sinRespaldo: !alarmaMsg && !prio && intencion === 'educativa' && fuentes.length === 0 && !evidencia,
    respuesta: respuestas.map((m) => m.text).join('\n---\n'),
    traza: despues.traces[0] ? despues.traces[0].pasos.map((p) => `${p.paso}: ${p.detalle}`) : [],
  };
}

/**
 * Cómo se manejó una pregunta fuera de alcance:
 *  - "derivada":   se le pasó a la médica (con o sin un mensaje a la paciente);
 *  - "declinada":  no se derivó, pero tampoco se respondió con contenido (por ejemplo, "eso lo tiene que ver el médico de tu hija");
 *  - "respondida": se respondió con contenido educativo, con fuentes o con evidencia, sin derivar. Es el error.
 */
function manejoFueraDeAlcance(obt) {
  if (obt.derivacion) return 'derivada';
  if (obt.intencion === 'educativa' || (obt.fuentes || []).length || obt.evidencia) return 'respondida';
  return 'declinada';
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
  if ('codigoDerivacion' in esp && !obt.codigosDerivacion.includes(esp.codigoDerivacion)) f('codigoDerivacion', esp.codigoDerivacion, obt.codigosDerivacion);
  for (const t of [].concat(esp.registro || [])) if (!obt.registro.includes(t)) f('registro', t, obt.registro);
  if ('fuente' in esp && !obt.fuentes.includes(esp.fuente)) f('fuente', esp.fuente, obt.fuentes);
  if ('evidencia' in esp && esp.evidencia !== obt.evidencia) f('evidencia', esp.evidencia, obt.evidencia);
  if ('sugerencia' in esp && esp.sugerencia !== obt.sugerencia) f('sugerencia', esp.sugerencia, obt.sugerencia);
  // fuera de alcance: no tiene que responderse con contenido educativo, tiene que derivarse
  if (esp.fueraDeAlcance === true && manejoFueraDeAlcance(obt) === 'respondida') f('fueraDeAlcance', 'derivada o declinada sin contenido', { intencion: obt.intencion, derivacion: obt.derivacion, fuentes: obt.fuentes, evidencia: obt.evidencia });
  return fallas;
}

// ---------------- Métricas ----------------
const tasa = (a, b) => (b ? +(a / b).toFixed(2) : null);

function metricas(resultados) {
  const ev = resultados.filter((r) => r.evaluado);
  const conAlarma = ev.filter((r) => 'alarma' in r.esperado);
  const m = { vp: 0, fn: 0, fp: 0, vn: 0 };
  for (const r of conAlarma) m[r.esperado.alarma ? (r.obtenido.alarma ? 'vp' : 'fn') : r.obtenido.alarma ? 'fp' : 'vn']++;
  const conDeriv = ev.filter((r) => 'derivacion' in r.esperado);
  const derivOk = conDeriv.filter((r) => !r.fallas.some((f) => f.startsWith('derivacion:'))).length;
  const fuera = ev.filter((r) => r.esperado.fueraDeAlcance === true);
  const manejo = (x) => fuera.filter((r) => manejoFueraDeAlcance(r.obtenido) === x).length;
  const conInt = ev.filter((r) => 'intencion' in r.esperado);
  return {
    pasos: resultados.length,
    evaluados: ev.length,
    correctos: ev.filter((r) => r.ok).length,
    tasaAcierto: tasa(ev.filter((r) => r.ok).length, ev.length),
    alarmas: { ...m, evaluadas: conAlarma.length, sensibilidad: tasa(m.vp, m.vp + m.fn), especificidad: tasa(m.vn, m.vn + m.fp), falsosPositivos: m.fp, falsosNegativos: m.fn },
    derivaciones: { evaluadas: conDeriv.length, correctas: derivOk, tasa: tasa(derivOk, conDeriv.length) },
    fueraDeAlcance: {
      preguntas: fuera.length,
      correctas: fuera.length - manejo('respondida'),
      derivadas: manejo('derivada'),
      declinadas: manejo('declinada'),
      respondidas: manejo('respondida'),
      respuestasSinRespaldo: resultados.filter((r) => r.obtenido.sinRespaldo).length,
    },
    intencion: { evaluadas: conInt.length, correctas: conInt.filter((r) => !r.fallas.some((f) => f.startsWith('intencion:'))).length },
  };
}

module.exports = { validarEsperado, manejoFueraDeAlcance, obtener, comparar, metricas, parseMomento, CAMPOS_ESPERADO, INTENCIONES, PRIORIDAD };
