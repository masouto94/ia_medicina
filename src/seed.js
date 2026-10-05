// Genera 14 días de seguimiento de ejemplo (para demostrar el panel sin tener que simular cada día).
const S = require('./state');
const C = require('./clinic');
const rag = require('./rag');
const OE = require('./mocks/openevidence');
const { atLocalTime, uid } = require('./util');

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function seed14() {
  const st = S.get();
  const t0 = st.clock;
  const rnd = rng(42);
  const day = (d, hhmm) => atLocalTime(t0, hhmm, d);
  const src = (id) => {
    const c = rag.getChunk(id);
    return [{ id: c.id, titulo: c.titulo, modulo: c.modulo }];
  };

  // Tomas: ~88% confirmadas; día 6 y 7 se omiten las de la noche (genera alerta por omisiones consecutivas)
  const fin = day(14, '07:50');
  const doses = C.materializeDoses(t0, fin, { status: 'tomada' });
  for (const d of doses) {
    const k = Math.floor((d.programada - t0) / 86400e3);
    const noche = new Date(d.programada - 3 * 3600e3).getUTCHours() >= 19;
    let estado = 'tomada';
    if (noche && (k === 6 || k === 7)) estado = 'omitida';
    else if (rnd() < 0.07) estado = 'sin_respuesta';
    else if (rnd() < 0.05) estado = 'omitida';
    d.estado = estado;
    d.respondida = estado === 'sin_respuesta' ? null : d.programada + Math.floor(rnd() * 40) * 60e3;
  }

  // Glucemias en ayunas con tendencia a la baja + algunas posprandiales
  const msgs = [];
  for (let k = 1; k <= 13; k++) {
    if (k === 9) continue;
    const v = Math.round(162 - k * 2.6 + (rnd() - 0.5) * 26);
    st.observations.push({ id: uid('obs'), ts: day(k, '07:30'), tipo: 'glucemia', valor: v, unidad: 'mg/dL', momento: 'ayunas', fuente: rnd() < 0.5 ? 'foto de glucómetro' : 'mensaje', loinc: '2339-0' });
    if ([2, 5, 9, 12].includes(k)) st.observations.push({ id: uid('obs'), ts: day(k, '15:00'), tipo: 'glucemia', valor: Math.round(165 + (rnd() - 0.5) * 40), unidad: 'mg/dL', momento: 'posprandial', fuente: 'mensaje', loinc: '2339-0' });
    if (k % 3 === 1) st.observations.push({ id: uid('obs'), ts: day(k, '09:00'), tipo: 'presion', valor: Math.round(134 + (rnd() - 0.5) * 12), valor2: Math.round(84 + (rnd() - 0.5) * 8), unidad: 'mmHg', fuente: 'foto de tensiómetro', loinc: '85354-9' });
  }

  // Conversaciones representativas
  const conv = (ts, from, text, extra = {}) => msgs.push({ id: uid('msg'), ts, from, kind: 'text', text, seeded: true, ...extra });
  const topic = (k, n = 1) => (st.topics[k] = (st.topics[k] || 0) + n);

  conv(day(2, '21:12'), 'marta', 'Anoche me olvidé la pastilla de la noche, ¿la tomo ahora?', { intent: 'educativa', topic: 'dosis olvidada' });
  conv(day(2, '21:12') + 20e3, 'asistente', 'Tranqui, Marta. Si ya pasó mucho tiempo y falta poco para la próxima toma, salteá la dosis olvidada y seguí con el horario habitual. Nunca tomes dos juntas para compensar. Si te pasa seguido, contale a la Dra. Lucía.', { intent: 'educativa', topic: 'dosis olvidada', sources: src('DM2-02') });
  topic('dosis olvidada', 2);

  const g262 = { id: uid('obs'), ts: day(4, '14:40'), tipo: 'glucemia', valor: 262, unidad: 'mg/dL', momento: 'posprandial', fuente: 'mensaje', loinc: '2339-0' };
  st.observations.push(g262);
  conv(day(4, '14:40'), 'marta', 'Me dio 262 después del almuerzo, fue el cumple de mi nieta 🙈', { intent: 'registro', topic: 'registro de glucemia' });
  conv(day(4, '14:40') + 20e3, 'asistente', 'Anotado: 262 mg/dl después de comer. Un valor alto aislado puede deberse a una comida especial. Tomá agua, seguí con tu medicación y volvé a medir más tarde. Si se mantiene por encima de 250 o aparecen vómitos o somnolencia, consultá de inmediato.', { intent: 'registro', topic: 'registro de glucemia', sources: src('DM2-11') });
  st.alerts.push({ id: uid('alr'), ts: day(4, '14:40'), nivel: 'media', motivo: 'Glucemia elevada: 262 mg/dl', ack: true, obsId: g262.id });
  topic('registro de glucemia', 6);

  conv(day(6, '10:05'), 'marta', '¿Puedo comer frutas? Me dijeron que tienen mucha azúcar', { intent: 'educativa', topic: 'alimentación' });
  conv(day(6, '10:05') + 20e3, 'asistente', 'Sí, las frutas están permitidas en porciones moderadas, mejor enteras que en jugo. Una guía práctica es el plato: mitad verduras, un cuarto proteínas y un cuarto almidones. Y preferí agua a las bebidas azucaradas.', { intent: 'educativa', topic: 'alimentación', sources: src('DM2-08') });
  topic('alimentación', 2);

  st.alerts.push({ id: uid('alr'), ts: day(8, '00:05'), nivel: 'media', motivo: '2 tomas consecutivas de Metformina 850 mg omitidas o sin confirmar', ack: false, key: 'seed-omisiones' });

  const g66 = { id: uid('obs'), ts: day(9, '11:20'), tipo: 'glucemia', valor: 66, unidad: 'mg/dL', momento: 'otro', fuente: 'foto de glucómetro', loinc: '2339-0' };
  st.observations.push(g66, { id: uid('obs'), ts: day(9, '11:40'), tipo: 'glucemia', valor: 98, unidad: 'mg/dL', momento: 'otro', fuente: 'mensaje', loinc: '2339-0' });
  conv(day(9, '11:20'), 'marta', 'Me dio 66 y estoy un poco temblorosa, hoy no desayuné', { intent: 'educativa', topic: 'hipoglucemia' });
  conv(day(9, '11:20') + 20e3, 'asistente', 'Anotado: 66 mg/dl. Es una glucemia baja. Tomá ahora 15 g de azúcar rápida (3 cucharaditas en agua o medio vaso de jugo común), esperá 15 minutos y volvé a medir. Si no mejora o te sentís confundida, es una urgencia. Avisame cómo seguís.', { intent: 'educativa', topic: 'hipoglucemia', sources: src('DM2-05') });
  conv(day(9, '11:41'), 'marta', 'Ya me dio 98, me siento mejor. Gracias!', { intent: 'registro', topic: 'registro de glucemia' });
  conv(day(9, '11:41') + 20e3, 'asistente', '¡Qué bueno, Marta! Anotado 98 mg/dl. Comé algo ahora y tratá de no saltear el desayuno. Le dejo registrado el episodio a la Dra. Lucía.', { intent: 'registro', topic: 'registro de glucemia' });
  st.alerts.push({ id: uid('alr'), ts: day(9, '11:20'), nivel: 'media', motivo: 'Hipoglucemia: 66 mg/dl (sin desayuno)', ack: false, obsId: g66.id });
  topic('hipoglucemia', 2);

  conv(day(11, '19:30'), 'marta', 'A la noche siento hormigueo en los pies, ¿es normal?', { intent: 'derivacion', topic: 'síntoma nuevo' });
  conv(day(11, '19:30') + 20e3, 'asistente', 'Gracias por contarme. Esto prefiero que lo evalúe la Dra. Lucía: ya le pasé tu consulta con un resumen y te va a responder por acá. Mientras tanto, revisá tus pies todos los días y avisá si aparece una herida o cambio de color.', { intent: 'derivacion', topic: 'síntoma nuevo', sources: src('DM2-10'), referral: true });
  st.referrals.push({ id: uid('der'), ts: day(11, '19:30'), estado: 'pendiente', prioridad: 'media', motivo: 'Síntoma nuevo: parestesias en pies', resumen: 'Marta refiere hormigueo nocturno en ambos pies desde hace unos días. Sin heridas referidas. DM2 de 7 años de evolución. Sugerido: evaluación de neuropatía en próxima consulta.', texto: 'A la noche siento hormigueo en los pies, ¿es normal?' });
  topic('cuidado de los pies');

  const pregunta = '¿Me puedo pasar al Ozempic? Mi vecina bajó mucho de peso';
  const ev = OE.consultar(pregunta);
  conv(day(12, '09:15'), 'marta', pregunta, { intent: 'derivacion', topic: 'cambio de tratamiento' });
  conv(day(12, '09:15') + 25e3, 'asistente', 'Entiendo tu interés. Hay otros medicamentos que en algunas personas se suman a la metformina, pero si te conviene o no lo decide tu médica según tu caso. Ya le pasé tu consulta a la Dra. Lucía. Mientras tanto, seguí con tu tratamiento actual sin cambios.', { intent: 'derivacion', topic: 'cambio de tratamiento', evidence: { tema: ev.tema, citas: ev.citas.length, servicio: ev.servicio }, referral: true });
  st.evidenceQueries.push({ ...ev, ts: day(12, '09:15'), origen: 'paciente (en segundo plano)', pregunta: ev.query_anonimizada });
  st.suggestions.push({ id: uid('sug'), ts: day(12, '09:15'), estado: 'pendiente', origen: 'OpenEvidence (mock)', pregunta, tema: ev.tema, texto: ev.respuesta, citas: ev.citas });
  st.referrals.push({ id: uid('der'), ts: day(12, '09:15'), estado: 'pendiente', prioridad: 'media', motivo: 'Consulta sobre cambio de tratamiento (arGLP-1)', resumen: 'Marta pregunta por semaglutida (Ozempic) por referencia de una vecina. La evidencia recuperada sugiere evaluar intensificación con iSGLT2/arGLP-1 según riesgo CV (ver sugerencias).', texto: pregunta });
  topic('cambio de tratamiento');

  const slot = day(17, '11:30');
  conv(day(13, '18:02'), 'marta', 'Quiero sacar turno para la semana que viene', { intent: 'turno', topic: 'turnos' });
  conv(day(13, '18:02') + 20e3, 'asistente', `Listo, te reservé el turno con la Dra. Lucía el jueves 22/10 a las 11:30 en CAPS / Consultorio 3. Te voy a recordar el día anterior. 📅`, { intent: 'turno', topic: 'turnos' });
  st.appointments.push({ id: uid('apt'), ts: day(13, '18:02'), inicio: slot, profesional: 'Dra. Lucía Fernández', lugar: 'CAPS / Consultorio 3', estado: 'booked' });
  topic('turnos');
  topic('actividad física');

  st.messages.push(...msgs);
  st.messages.sort((a, b) => a.ts - b.ts);
  st.observations.sort((a, b) => a.ts - b.ts);
  st.alerts.sort((a, b) => a.ts - b.ts);
  st.clock = fin;
  st.seeded = true;
  S.trace('Simulación de 14 días', [{ paso: 'Datos de ejemplo', detalle: `${doses.length} tomas, ${st.observations.length} observaciones, ${msgs.length} mensajes generados` }]);
  S.save();
}

module.exports = { seed14 };
