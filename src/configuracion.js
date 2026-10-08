// Acciones de la médica sobre la configuración: importar la HCE, generar o actualizar el asistente
// y administrar las alarmas. Las usan la API (server.js) y la simulación con planes (src/simulacion.js).
const S = require('./state');
const C = require('./clinic');
const ALM = require('./alarmas');
const hce = require('./mocks/hce');

function importarHCE() {
  const b = hce.everything();
  const st = S.get();
  st.hce = hce.toSummary(b);
  S.trace('Importación desde la HCE', [{ paso: 'HCE (mock FHIR)', detalle: `GET /Patient/${hce.PATIENT_ID}/$everything → ${b.entry.length} recursos` }]);
  S.save();
  return { summary: st.hce, bundle: b };
}

function guardarAsistente(cfg) {
  const st = S.get();
  if (!st.hce) throw new Error('Importá primero los datos desde la HCE.');
  if (!cfg || !cfg.medicacion || !cfg.medicacion.length) throw new Error('Configuración inválida');
  const nuevo = !st.assistant;
  const prev = nuevo ? null : st.assistant.config;
  // las alarmas se editan con sus propias acciones (cada cambio queda registrado): el formulario no las pisa
  if (prev) {
    cfg.alarmas = prev.alarmas;
    cfg.alarmasEliminadas = prev.alarmasEliminadas;
  }
  ALM.ensure(cfg);
  st.assistant = { config: cfg, creado: nuevo ? st.clock : st.assistant.creado, actualizado: Date.now(), version: nuevo ? 1 : (st.assistant.version || 1) + 1 };
  // Si la médica cambia indicaciones u horarios, se le avisa a la paciente
  if (prev) {
    const avisos = [];
    if ((prev.indicaciones || '') !== (cfg.indicaciones || '')) avisos.push(`📋 Nuevas indicaciones:\n${cfg.indicaciones || '(sin indicaciones adicionales)'}`);
    const hs = (c) => c.medicacion.map((m) => `${m.nombre} a las ${m.horarios.join(' y ')}`).join('; ');
    if (hs(prev) !== hs(cfg)) avisos.push(`⏰ Nuevos horarios de medicación: ${hs(cfg)}`);
    if (avisos.length) C.addMessage({ from: 'asistente', kind: 'text', intent: 'otro', text: `Marta, la Dra. Lucía actualizó tu plan de cuidado.\n${avisos.join('\n')}` });
  }
  if (nuevo) {
    C.addMessage({
      from: 'asistente',
      kind: 'text',
      intent: 'otro',
      text: `¡Hola, Marta! 👋 Soy tu asistente de seguimiento, configurado por la Dra. Lucía.\nTe voy a recordar tus remedios (${cfg.medicacion.map((m) => `${m.nombre} a las ${m.horarios.join(' y ')}`).join('; ')}), responder dudas sobre tu tratamiento, registrar tus valores y ayudarte con los turnos.\nPodés escribirme, mandarme audios o fotos del glucómetro, tensiómetro, remedios o análisis.\nNo reemplazo a tu médica: si algo lo tiene que ver ella, se lo paso. Ante una urgencia, llamá al 107.`,
    });
  }
  S.trace(nuevo ? 'Asistente generado' : 'Configuración actualizada', [
    { paso: 'Panel médico', detalle: `${cfg.id}: módulos ${cfg.modulos.join('+')}, ${cfg.temas.length} temas, nivel ${cfg.nivelLenguaje}, canal ${cfg.canal}` },
    { paso: 'Instancia del LLM', detalle: 'Sin reentrenamiento: modelo general parametrizado por el plan de cuidado (prompt de sistema + RAG)' },
  ]);
  S.save();
  return { nuevo };
}

// ---------------- Alarmas ----------------
function necesitaAsistente() {
  const st = S.get();
  if (!st.assistant) throw new Error('Primero la médica debe configurar el asistente.');
  return st.assistant.config;
}

function alarmaCambiada(accion, detalle) {
  const st = S.get();
  st.assistant.actualizado = Date.now();
  st.assistant.version = (st.assistant.version || 1) + 1;
  S.trace(`Alarma ${accion}`, [{ paso: 'Panel médico – alarmas', detalle }]);
  S.save();
  return { alarmas: st.assistant.config.alarmas, umbrales: st.assistant.config.umbrales, actualizado: st.assistant.actualizado, version: st.assistant.version };
}

function agregarAlarma(datos) {
  const cfg = necesitaAsistente();
  const a = ALM.crear(datos || {});
  cfg.alarmas.push(a);
  return alarmaCambiada('agregada', `${a.nombre} [${a.id}]: ${ALM.describir(a, cfg)}`);
}

function modificarAlarma(id, cambios = {}) {
  const cfg = necesitaAsistente();
  const { despues } = ALM.modificar(cfg, id, cambios);
  const accion = 'activa' in cambios && Object.keys(cambios).length === 1 ? (despues.activa ? 'reactivada' : 'pausada') : 'modificada';
  return alarmaCambiada(accion, `${despues.nombre} [${despues.id}]${accion === 'modificada' ? `: ${ALM.describir(despues, cfg)}` : ''}`);
}

function eliminarAlarma(id) {
  const cfg = necesitaAsistente();
  const a = ALM.eliminar(cfg, id);
  return alarmaCambiada('eliminada', `${a.nombre} [${a.id}]`);
}

module.exports = { importarHCE, guardarAsistente, agregarAlarma, modificarAlarma, eliminarAlarma };
