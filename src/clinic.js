// Lógica clínica de registro: observaciones, tomas, alertas, derivaciones, mensajes y métricas.
const S = require('./state');
const { uid, atLocalTime, localDayKey, fmtTime } = require('./util');

const LOINC = {
  glucemia: { code: '2339-0', display: 'Glucemia (capilar)' },
  presion: { code: '85354-9', display: 'Presión arterial' },
  peso: { code: '29463-7', display: 'Peso corporal' },
  hba1c: { code: '4548-4', display: 'Hemoglobina A1c' },
  glucemia_lab: { code: '1558-6', display: 'Glucemia en ayunas (laboratorio)' },
  creatinina: { code: '2160-0', display: 'Creatinina' },
  ldl: { code: '13457-7', display: 'Colesterol LDL' },
  colesterol: { code: '2093-3', display: 'Colesterol total' },
  trigliceridos: { code: '2571-8', display: 'Triglicéridos' },
  hdl: { code: '2085-9', display: 'Colesterol HDL' },
  microalbuminuria: { code: '14959-1', display: 'Microalbuminuria' },
};

function addMessage(m) {
  const st = S.get();
  const msg = { id: uid('msg'), ts: st.clock, ...m };
  st.messages.push(msg);
  return msg;
}

function addObservation(o, { check = true } = {}) {
  const st = S.get();
  const obs = { id: uid('obs'), ts: st.clock, ...o };
  obs.loinc = obs.loinc || (LOINC[obs.tipo] && LOINC[obs.tipo].code);
  st.observations.push(obs);
  if (check) checkThresholds(obs);
  return obs;
}

function addAlert(nivel, motivo, extra = {}) {
  const st = S.get();
  const a = { id: uid('alr'), ts: st.clock, nivel, motivo, ack: false, ...extra };
  st.alerts.push(a);
  return a;
}

function addReferral(r) {
  const st = S.get();
  const ref = { id: uid('der'), ts: st.clock, estado: 'pendiente', prioridad: 'media', ...r };
  st.referrals.push(ref);
  return ref;
}

function addTopic(tema) {
  if (!tema) return;
  const st = S.get();
  const k = String(tema).toLowerCase().trim();
  st.topics[k] = (st.topics[k] || 0) + 1;
}

// Controla umbrales configurados por la médica
function checkThresholds(obs) {
  const st = S.get();
  const cfg = st.assistant && st.assistant.config;
  if (!cfg) return;
  const u = cfg.umbrales;
  if (obs.tipo === 'glucemia') {
    if (obs.valor < u.hipoGrave) addAlert('alta', `Hipoglucemia grave: ${obs.valor} mg/dl`, { obsId: obs.id });
    else if (obs.valor < u.hipo) addAlert('media', `Hipoglucemia: ${obs.valor} mg/dl`, { obsId: obs.id });
    else if (obs.valor > u.hiperGrave) addAlert('alta', `Hiperglucemia marcada: ${obs.valor} mg/dl`, { obsId: obs.id });
    else if (obs.valor > u.hiper) addAlert('media', `Glucemia elevada: ${obs.valor} mg/dl`, { obsId: obs.id });
  }
  if (obs.tipo === 'presion') {
    if (obs.valor >= u.paSisAlarma || obs.valor2 >= u.paDiaAlarma) addAlert('alta', `Presión muy elevada: ${obs.valor}/${obs.valor2} mmHg`, { obsId: obs.id });
    else if (obs.valor >= u.paSis || obs.valor2 >= u.paDia) addAlert('baja', `Presión por encima de la meta: ${obs.valor}/${obs.valor2} mmHg`, { obsId: obs.id });
  }
  if (obs.tipo === 'hba1c' && obs.valor > cfg.metas.hba1c) {
    addAlert('baja', `HbA1c ${obs.valor}% por encima de la meta (<${cfg.metas.hba1c}%)`, { obsId: obs.id });
  }
}

// ---------- Tomas de medicación ----------

function scheduleTimes(cfg) {
  const out = [];
  for (const m of cfg.medicacion) for (const h of m.horarios) out.push({ medId: m.id, nombre: m.nombre, hora: h });
  return out;
}

// Próximo horario de toma estrictamente posterior a `ms`
function nextDoseTime(ms) {
  const cfg = S.get().assistant.config;
  let best = null;
  for (let d = 0; d <= 1; d++) {
    for (const s of scheduleTimes(cfg)) {
      const t = atLocalTime(ms, s.hora, d);
      if (t > ms && (best === null || t < best)) best = t;
    }
  }
  return best;
}

// Crea las tomas programadas en el intervalo (from, to]
function materializeDoses(from, to, { status = 'pendiente' } = {}) {
  const st = S.get();
  const cfg = st.assistant.config;
  const created = [];
  const days = Math.ceil((to - from) / 86400e3) + 1;
  for (let d = 0; d <= days; d++) {
    for (const s of scheduleTimes(cfg)) {
      const t = atLocalTime(from, s.hora, d);
      if (t > from && t <= to && !st.doses.find((x) => x.medId === s.medId && x.programada === t)) {
        const dose = { id: uid('dose'), medId: s.medId, nombre: s.nombre, programada: t, estado: status, respondida: null };
        st.doses.push(dose);
        created.push(dose);
      }
    }
  }
  return created;
}

// Marca como "sin respuesta" las tomas pendientes de hace más de 4 horas
function expireDoses() {
  const st = S.get();
  for (const d of st.doses) if (d.estado === 'pendiente' && st.clock - d.programada > 4 * 3600e3) d.estado = 'sin_respuesta';
  checkConsecutiveMisses();
}

function respondDoses(doseIds, tomada) {
  const st = S.get();
  const out = [];
  for (const id of doseIds) {
    const d = st.doses.find((x) => x.id === id);
    if (!d) continue;
    d.estado = tomada ? 'tomada' : 'omitida';
    d.respondida = st.clock;
    out.push(d);
  }
  if (!tomada) checkConsecutiveMisses();
  return out;
}

// Registra una toma confirmada u omitida por texto libre (la pendiente más reciente)
function registerDoseFromText(tomada) {
  const st = S.get();
  const pend = st.doses.filter((d) => ['pendiente', 'sin_respuesta'].includes(d.estado) && d.programada <= st.clock + 3600e3 && st.clock - d.programada < 12 * 3600e3);
  if (!pend.length) return [];
  const last = Math.max(...pend.map((d) => d.programada));
  return respondDoses(pend.filter((d) => d.programada === last).map((d) => d.id), tomada);
}

function checkConsecutiveMisses() {
  const st = S.get();
  const cfg = st.assistant && st.assistant.config;
  if (!cfg) return;
  const n = cfg.umbrales.omisionesConsecutivas;
  for (const m of cfg.medicacion) {
    const ds = st.doses.filter((d) => d.medId === m.id && d.estado !== 'pendiente').sort((a, b) => a.programada - b.programada);
    const tail = ds.slice(-n);
    if (tail.length === n && tail.every((d) => d.estado !== 'tomada')) {
      const key = tail.map((d) => d.id).join(',');
      if (!st.alerts.find((a) => a.key === key)) addAlert('media', `${n} tomas consecutivas de ${m.nombre} omitidas o sin confirmar`, { key });
    }
  }
}

// ---------- Métricas para el panel ----------

function metrics(days = 14) {
  const st = S.get();
  const desde = st.clock - days * 86400e3;
  const doses = st.doses.filter((d) => d.programada > desde && d.programada <= st.clock && d.estado !== 'pendiente');
  const byDay = {};
  for (const d of doses) {
    const k = localDayKey(d.programada);
    byDay[k] = byDay[k] || { total: 0, tomadas: 0 };
    byDay[k].total++;
    if (d.estado === 'tomada') byDay[k].tomadas++;
  }
  const dias = Object.keys(byDay);
  const cubiertos = dias.filter((k) => byDay[k].tomadas === byDay[k].total).length;
  const glu = st.observations.filter((o) => o.tipo === 'glucemia' && o.ts > desde);
  const ayunas = glu.filter((o) => o.momento === 'ayunas');
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, o) => s + o.valor, 0) / arr.length) : null);
  const cfg = st.assistant && st.assistant.config;
  const enMeta = cfg ? glu.filter((o) => o.valor >= cfg.metas.ayunasMin && o.valor <= (o.momento === 'ayunas' ? cfg.metas.ayunasMax : cfg.metas.posprandialMax)).length : 0;
  return {
    periodoDias: days,
    pdc: dias.length ? Math.round((100 * cubiertos) / dias.length) : null,
    diasCubiertos: cubiertos,
    diasEvaluados: dias.length,
    adherenciaTomas: doses.length ? Math.round((100 * doses.filter((d) => d.estado === 'tomada').length) / doses.length) : null,
    tomasEvaluadas: doses.length,
    glucemiaPromedio: avg(glu),
    glucemiaAyunasPromedio: avg(ayunas),
    glucemiasRegistradas: glu.length,
    tiempoEnMeta: glu.length ? Math.round((100 * enMeta) / glu.length) : null,
    alertasAbiertas: st.alerts.filter((a) => !a.ack).length,
    derivacionesPendientes: st.referrals.filter((r) => r.estado === 'pendiente').length,
    sugerenciasPendientes: st.suggestions.filter((s) => s.estado === 'pendiente').length,
  };
}

function pendingDosesText() {
  const st = S.get();
  if (!st.assistant) return '';
  const nxt = nextDoseTime(st.clock);
  const cfg = st.assistant.config;
  const lst = scheduleTimes(cfg)
    .filter((s) => atLocalTime(st.clock, s.hora, 0) === nxt || atLocalTime(st.clock, s.hora, 1) === nxt)
    .map((s) => `${s.nombre} a las ${s.hora}`);
  return `Próxima toma: ${lst.join(', ')} (${fmtTime(nxt)})`;
}

module.exports = {
  LOINC,
  addMessage,
  addObservation,
  addAlert,
  addReferral,
  addTopic,
  nextDoseTime,
  materializeDoses,
  expireDoses,
  respondDoses,
  registerDoseFromText,
  metrics,
  scheduleTimes,
  pendingDosesText,
};
