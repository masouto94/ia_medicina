// Exportación de la experiencia del paciente como recursos HL7 FHIR R4 y servicio CDS Hooks.
const S = require('./state');
const C = require('./clinic');
const hce = require('./mocks/hce');
const M = require('./modulos');
const TERM = require('./terminologia');
const { fmtDateTime } = require('./util');
const LOGS = require('./logs');

const P = { reference: `Patient/${hce.PATIENT_ID}`, display: 'Marta González' };
const DR = { reference: `Practitioner/${hce.PRACTITIONER_ID}`, display: 'Dra. Lucía Fernández' };
const iso = (ms) => new Date(ms).toISOString();

function bundle(baseUrl = 'http://localhost:3000') {
  const st = S.get();
  const entries = [];
  const add = (r) => entries.push({ fullUrl: `urn:uuid:${r.resourceType.toLowerCase()}-${r.id}`, resource: r });
  const src = hce.everything().entry.map((e) => e.resource);
  src.filter((r) => ['Patient', 'Practitioner', 'Condition', 'MedicationRequest'].includes(r.resourceType)).forEach(add);

  const cfg = st.assistant && st.assistant.config;
  if (cfg) {
    // un Goal por variable con meta (según los módulos activos) y uno de texto para las metas sin variable
    const goals = [];
    for (const id of M.activos(cfg)) {
      const mc = M.get(id).configuracion;
      const porVar = {};
      for (const m of mc.metas) {
        if (!m.variable) {
          goals.push({ id: `goal-${id}-${m.clave}`, text: `${m.etiqueta} ${cfg.metas[m.clave]} ${m.unidad}`.trim(), modulo: id });
          continue;
        }
        porVar[m.variable] = porVar[m.variable] || { low: null, high: null };
        porVar[m.variable][m.limite === 'min' ? 'low' : 'high'] = cfg.metas[m.clave];
      }
      for (const [v, r] of Object.entries(porVar)) {
        const def = mc.variables[v] || {};
        const rango = r.low != null && r.high != null ? `${r.low}–${r.high}` : r.high != null ? `< ${r.high}` : `> ${r.low}`;
        goals.push({ id: `goal-${id}-${v}`, text: `${def.etiqueta || v} ${rango} ${def.unidad || ''}`.trim(), loinc: def.loinc, low: r.low, high: r.high, unit: def.ucum || def.unidad, modulo: id });
      }
    }
    for (const g of goals) {
      add({
        resourceType: 'Goal',
        id: g.id,
        lifecycleStatus: 'active',
        description: { text: g.text },
        subject: P,
        addresses: (M.get(g.modulo).snomed || []).map((c) => ({ display: `SNOMED CT ${c}` })),
        target: g.loinc ? [{ measure: { coding: [{ system: 'http://loinc.org', code: g.loinc }] }, detailRange: { low: g.low != null ? TERM.cantidad(g.low, g.unit) : undefined, high: g.high != null ? TERM.cantidad(g.high, g.unit) : undefined } }] : undefined,
      });
    }
    add({
      resourceType: 'CarePlan',
      id: 'careplan-asistente',
      status: 'active',
      intent: 'plan',
      title: `Configuración del asistente ${cfg.id}`,
      subject: P,
      author: DR,
      created: iso(st.assistant.creado),
      addresses: [{ reference: 'Condition/cond-dm2' }, { reference: 'Condition/cond-hta' }],
      goal: goals.map((g) => ({ reference: `Goal/${g.id}` })),
      description: `Módulos: ${cfg.modulos.join(', ')}. Temas habilitados: ${cfg.temas.join(', ')}. Nivel de lenguaje: ${cfg.nivelLenguaje}. Canal: ${cfg.canal}. Indicaciones: ${cfg.indicaciones}`,
      activity: cfg.medicacion.map((m) => ({ detail: { kind: 'MedicationRequest', status: 'in-progress', description: `${m.nombre} – ${m.horarios.join(' y ')}`, productReference: { reference: `MedicationRequest/medreq-${m.id}` } } })),
      extension: [{ url: 'urn:demo:assistant-config', valueString: JSON.stringify({ umbrales: cfg.umbrales, metas: cfg.metas }) }],
    });
  }

  // la medicación de cada toma se codifica igual que la MedicationRequest de la HCE (SNOMED CT)
  const medConcepto = {};
  for (const r of src.filter((x) => x.resourceType === 'MedicationRequest')) medConcepto[r.id.replace(/^medreq-/, '')] = r.medicationCodeableConcept;
  for (const d of st.doses.filter((x) => x.estado !== 'pendiente')) {
    add({
      resourceType: 'MedicationStatement',
      id: d.id,
      status: d.estado === 'tomada' ? 'completed' : 'not-taken',
      statusReason: d.estado === 'sin_respuesta' ? [{ text: 'Sin confirmación de la paciente' }] : undefined,
      medicationCodeableConcept: medConcepto[d.medId] || { text: d.nombre },
      subject: P,
      effectiveDateTime: iso(d.programada),
      dateAsserted: d.respondida ? iso(d.respondida) : undefined,
      basedOn: [{ reference: `MedicationRequest/medreq-${d.medId}` }],
      informationSource: P,
    });
  }

  for (const o of st.observations) {
    const meta = C.LOINC[o.tipo] || { code: o.loinc, display: o.nombre };
    const r = {
      resourceType: 'Observation',
      id: o.id,
      status: 'final',
      category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: ['glucemia', 'presion', 'peso'].includes(o.tipo) ? 'vital-signs' : 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: meta.code, display: meta.display }], text: o.nombre || meta.display },
      subject: P,
      effectiveDateTime: iso(o.ts),
      performer: [P],
      note: [{ text: `Fuente: ${o.fuente || '-'}${o.momento ? ` · momento: ${o.momento}` : ''}` }],
      derivedFrom: o.mediaId ? [{ reference: `Media/${o.mediaId}` }] : undefined,
    };
    if (o.tipo === 'presion') {
      r.component = [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Sistólica' }] }, valueQuantity: TERM.cantidad(o.valor, 'mmHg') },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastólica' }] }, valueQuantity: TERM.cantidad(o.valor2, 'mmHg') },
      ];
    } else r.valueQuantity = TERM.cantidad(o.valor, o.unidad);
    add(r);
  }

  for (const m of st.media) {
    const content = { contentType: m.mime, url: `${baseUrl}${m.url}`, title: m.nombre };
    if (m.mime === 'application/pdf') {
      add({ resourceType: 'DocumentReference', id: m.id, status: 'current', type: { text: 'Informe enviado por la paciente' }, subject: P, date: iso(m.ts), author: [P], content: [{ attachment: content }], description: m.extraido && m.extraido.nota_para_medico });
    } else {
      add({ resourceType: 'Media', id: m.id, status: 'completed', type: { text: 'photo' }, subject: P, createdDateTime: iso(m.ts), operator: P, content, note: [{ text: `Clasificación: ${m.tipo}. ${(m.extraido && m.extraido.nota_para_medico) || ''}` }] });
      if (m.tipo === 'informe_laboratorio' || m.tipo === 'herida_lesion') {
        add({ resourceType: 'DocumentReference', id: `doc-${m.id}`, status: 'current', type: { text: m.tipo === 'herida_lesion' ? 'Foto de lesión para evaluación' : 'Informe de laboratorio (foto)' }, subject: P, date: iso(m.ts), content: [{ attachment: content }] });
      }
    }
  }

  for (const r of st.referrals) {
    add({ resourceType: 'Communication', id: r.id, status: r.estado === 'pendiente' ? 'in-progress' : 'completed', category: [{ text: 'Derivación del asistente a la médica' }], priority: r.prioridad === 'alta' ? 'urgent' : 'routine', subject: P, sent: iso(r.ts), sender: { display: 'lucia-marta-assistant' }, recipient: [DR], reasonCode: [TERM.concepto(r.codigo || TERM.motivo('consulta'), r.motivo)], payload: [{ contentString: r.resumen }] });
    if (r.respuesta) add({ resourceType: 'Communication', id: `${r.id}-resp`, status: 'completed', inResponseTo: [{ reference: `Communication/${r.id}` }], subject: P, sent: iso(r.respondida), sender: DR, recipient: [P], payload: [{ contentString: r.respuesta }] });
  }
  // Sugerencias basadas en evidencia: lo que devolvió OpenEvidence (GuidanceResponse) y la decisión de la médica (Task)
  const ESTADO_TASK = { pendiente: 'requested', aceptada: 'accepted', descartada: 'rejected' };
  const NEGOCIO = { pendiente: 'Pendiente de revisión', aceptada: 'Evaluar en consulta', descartada: 'Descartada' };
  for (const s of st.suggestions || []) {
    add({
      resourceType: 'GuidanceResponse',
      id: `${s.id}-evidencia`,
      moduleUri: 'urn:asistente:openevidence-mock',
      status: 'success',
      subject: P,
      occurrenceDateTime: iso(s.ts),
      performer: { display: s.origen },
      reasonCode: [{ text: 'Consulta de la paciente que implica una posible decisión terapéutica' }],
      note: [{ text: `${s.tema}. ${s.texto}` }, ...s.citas.map((c) => ({ text: `${c.ref}${c.url ? ` ${c.url}` : ''}` }))],
    });
    add({
      resourceType: 'Task',
      id: s.id,
      status: ESTADO_TASK[s.estado] || 'requested',
      businessStatus: { text: NEGOCIO[s.estado] || s.estado },
      intent: 'proposal',
      code: { text: 'Revisar sugerencia basada en evidencia' },
      description: s.tema,
      focus: { reference: `GuidanceResponse/${s.id}-evidencia` },
      for: P,
      authoredOn: iso(s.ts),
      ...(s.resuelta ? { lastModified: iso(s.resuelta), executionPeriod: { end: iso(s.resuelta) } } : {}),
      owner: DR,
    });
  }
  for (const a of st.appointments) {
    add({ resourceType: 'Appointment', id: a.id, status: 'booked', start: iso(a.inicio), end: iso(a.inicio + 20 * 60e3), created: iso(a.ts), participant: [{ actor: P, status: 'accepted' }, { actor: DR, status: 'accepted' }], description: `Turno solicitado por el asistente – ${a.lugar}` });
  }
  for (const s of st.summaries) {
    add({ resourceType: 'Composition', id: s.id, status: 'final', type: { text: 'Resumen preconsulta del período entre consultas' }, subject: P, date: iso(s.ts), author: [{ display: `lucia-marta-assistant (${s.motor})` }], title: 'Resumen preconsulta', section: [{ title: 'Resumen', text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml"><pre>${escapeHtml(s.texto)}</pre></div>` } }] });
  }
  // Trazabilidad de esta sesión (desde logs/): origen de cada respuesta y cambios de configuración
  for (const r of LOGS.leerFhir('procedencia', { sesion: st.sesion })) add(r);
  for (const r of LOGS.leerFhir('auditoria', { sesion: st.sesion })) add(r);
  return JSON.parse(JSON.stringify({ resourceType: 'Bundle', id: `export-${Date.now()}`, type: 'collection', timestamp: iso(st.clock), entry: entries }));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

// ---------------- CDS Hooks ----------------
const DISCOVERY = {
  services: [
    {
      hook: 'patient-view',
      id: 'seguimiento-entre-consultas',
      title: 'Seguimiento entre consultas (asistente IA)',
      description: 'Muestra alertas, derivaciones y resumen de adherencia generados por el asistente conversacional al abrir el registro del paciente.',
      prefetch: { patient: 'Patient/{{context.patientId}}' },
    },
  ],
};

function cdsCards() {
  const st = S.get();
  if (!st.assistant) return { cards: [] };
  const m = C.metrics(14);
  const cards = [];
  const abiertas = st.alerts.filter((a) => !a.ack);
  const alta = abiertas.filter((a) => a.nivel === 'alta');
  if (alta.length) {
    cards.push({ uuid: 'card-alarma', summary: `${alta.length} alerta(s) de prioridad alta`, indicator: 'critical', detail: alta.map((a) => `- ${fmtDateTime(a.ts)}: ${a.motivo}`).join('\n'), source: { label: 'lucia-marta-assistant' } });
  }
  cards.push({
    uuid: 'card-adherencia',
    summary: `Adherencia 14 días: PDC ${m.pdc ?? '—'}% · glucemia promedio ${m.glucemiaPromedio ?? '—'} mg/dl`,
    indicator: m.pdc !== null && m.pdc < 80 ? 'warning' : 'info',
    detail: `Tomas confirmadas: ${m.adherenciaTomas ?? '—'}% de ${m.tomasEvaluadas}. Glucemias registradas: ${m.glucemiasRegistradas} (tiempo en meta ${m.tiempoEnMeta ?? '—'}%). Alertas abiertas: ${abiertas.length}.`,
    source: { label: 'lucia-marta-assistant' },
  });
  const pend = st.referrals.filter((r) => r.estado === 'pendiente');
  if (pend.length) cards.push({ uuid: 'card-derivaciones', summary: `${pend.length} consulta(s) de la paciente esperan respuesta`, indicator: 'warning', detail: pend.map((r) => `- ${r.motivo}`).join('\n'), source: { label: 'lucia-marta-assistant' }, links: [{ label: 'Abrir panel del asistente', url: '/', type: 'absolute' }] });
  const sug = st.suggestions.filter((s) => s.estado === 'pendiente');
  if (sug.length) cards.push({ uuid: 'card-evidencia', summary: `Sugerencia basada en evidencia: ${sug[0].tema}`, indicator: 'info', detail: sug[0].texto, source: { label: 'OpenEvidence (mock)', url: sug[0].citas[0] && sug[0].citas[0].url } });
  return { cards };
}

module.exports = { bundle, DISCOVERY, cdsCards };
