// Módulo multimodal: fotos e informes que envía la paciente.
// Las imágenes se usan con fines de REGISTRO, nunca de diagnóstico automático.
const fs = require('fs');
const S = require('./state');
const C = require('./clinic');
const llm = require('./llm');
const safety = require('./safety');
const M = require('./modulos');
const ALM = require('./alarmas');
const G = require('./guardrails');
const { normalize, uid, fmtDateTime } = require('./util');

const TOOL = {
  name: 'registrar_archivo',
  description: 'Clasifica el archivo enviado por la paciente y extrae los datos necesarios para su registro.',
  input_schema: {
    type: 'object',
    properties: {
      tipo: { type: 'string', enum: ['glucometro', 'tensiometro', 'blister_medicamento', 'herida_lesion', 'informe_laboratorio', 'otro'] },
      legible: { type: 'boolean', description: 'false si el valor no se puede leer con seguridad (mala iluminación, desenfoque, etc.)' },
      glucemia_mg_dl: { type: 'number' },
      presion: { type: 'object', properties: { sistolica: { type: 'number' }, diastolica: { type: 'number' }, pulso: { type: 'number' } } },
      medicamento: { type: 'object', properties: { nombre: { type: 'string' }, dosis: { type: 'string' }, coincide_con_plan: { type: 'boolean' } } },
      laboratorio: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            analito: { type: 'string', enum: ['hba1c', 'glucemia_lab', 'creatinina', 'ldl', 'hdl', 'colesterol', 'trigliceridos', 'microalbuminuria', 'otro'] },
            nombre_original: { type: 'string' },
            valor: { type: 'number' },
            unidad: { type: 'string' },
          },
          required: ['analito', 'nombre_original', 'valor', 'unidad'],
        },
      },
      fecha_informe: { type: 'string', description: 'AAAA-MM-DD si figura' },
      respuesta_para_paciente: { type: 'string' },
      nota_para_medico: { type: 'string', description: 'Nota objetiva y breve para la médica (sin diagnóstico)' },
      alarma: {
        type: 'object',
        description: 'Segunda capa de seguridad: sólo si la lectura o el comentario encajan en una alarma ACTIVA de la lista',
        properties: {
          es_alarma: { type: 'boolean' },
          regla_id: { type: 'string' },
          fundamento: { type: 'string', description: 'Cita textual del comentario o la lectura que la justifica' },
          valor: { type: 'number', description: 'Valor leído, si la alarma es de umbral' },
          fuentes: { type: 'array', items: { type: 'string' }, description: 'Sólo "CONFIG"' },
        },
        required: ['es_alarma'],
      },
    },
    required: ['tipo', 'legible', 'respuesta_para_paciente', 'nota_para_medico'],
  },
};

function systemPrompt(cfg) {
  return `Sos el módulo multimodal del asistente de seguimiento de ${cfg.paciente.nombre}, configurado por ${cfg.medico.nombre}. La paciente te envía fotos o documentos por WhatsApp. Tu función es de REGISTRO, no de diagnóstico.
Medicación del plan: ${cfg.medicacion.map((m) => m.nombre).join(', ')}.
Metas configuradas por la médica: ${M.metasTexto(cfg) || '—'}.
Reglas:
- glucometro: leé el valor de la pantalla en mg/dl. Si no es legible con seguridad, legible=false y pedí que lo escriba.
- tensiometro: leé sistólica, diastólica y pulso.
- blister_medicamento: identificá nombre y dosis; indicá si coincide con la medicación del plan. Si coincide, recordale para qué y en qué horario la toma según el plan. Si no coincide, no des indicaciones: decí que se lo consultás a la médica.
- herida_lesion (pie, piel, herida, uña, ampolla): NO describas la lesión, NO evalúes gravedad, NO recomiendes tratamientos. Respondé solo que la foto se envió a la Dra. Lucía para que la evalúe, y que si hay fiebre, mal olor, enrojecimiento que avanza o dolor intenso consulte a la guardia.
- informe_laboratorio: transcribí cada valor tal como figura (analito normalizado, nombre original, valor, unidad) y la fecha. A la paciente NO le interpretes los resultados: decile que quedaron guardados para que la médica los revise.
- otro: agradecé y explicá qué tipos de fotos podés registrar.
ALARMAS (segunda capa de seguridad): decidí SÓLO con la lista de alarmas activas configuradas por la médica, sin usar tu conocimiento médico general ni fuentes externas. Si la lectura o el comentario encajan en una alarma activa, completá alarma = { es_alarma: true, regla_id, fundamento (cita textual del comentario o la lectura), valor (si es de umbral), fuentes: ["CONFIG"] }. Si no, es_alarma false. Las alarmas pausadas no cuentan.
Alarmas activas:
${ALM.textoParaModelo(cfg)}
Respuestas en español rioplatense (voseo), breves y cálidas.`;
}

async function analyze(filePath, mime, nombre, caption, cfg) {
  if (llm.enabled) {
    const data = fs.readFileSync(filePath).toString('base64');
    const isPdf = mime === 'application/pdf';
    const block = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mime, data } };
    const r = await llm.structured({
      system: systemPrompt(cfg),
      messages: [{ role: 'user', content: [block, { type: 'text', text: `Archivo "${nombre}" enviado por la paciente.${caption ? ` Texto que lo acompaña: "${caption}"` : ''}` }] }],
      tool: TOOL,
      maxTokens: 1500,
    });
    llm.setError(null);
    return { data: r.data, motor: `${llm.MODEL} (visión)`, ms: r.ms };
  }
  return { data: mockAnalyze(nombre, mime, caption, cfg), motor: 'simulado por nombre de archivo' };
}

// Modo simulado: deduce el tipo por el nombre del archivo (ver carpeta /muestras)
function mockAnalyze(nombre, mime, caption) {
  const n = normalize(`${nombre} ${caption || ''}`);
  const num = (n.match(/\b(\d{2,3})\b/) || [])[1];
  if (/gluc/.test(n)) {
    const v = Number(num) || 182;
    return { tipo: 'glucometro', legible: true, glucemia_mg_dl: v, respuesta_para_paciente: `Leí ${v} mg/dl en tu glucómetro. Quedó registrado para la Dra. Lucía. Recordá contarme si fue en ayunas o después de comer.`, nota_para_medico: `Lectura de glucómetro: ${v} mg/dl.` };
  }
  if (/tension|presion|tensiometro/.test(n)) {
    const m = n.match(/(\d{2,3})\s+(\d{2,3})/) || [null, 142, 88];
    const [s, d] = [Number(m[1]), Number(m[2])];
    return { tipo: 'tensiometro', legible: true, presion: { sistolica: s, diastolica: d, pulso: 78 }, respuesta_para_paciente: `Leí ${s}/${d} mmHg, pulso 78. Quedó registrado para la Dra. Lucía.`, nota_para_medico: `Lectura de tensiómetro: ${s}/${d} mmHg, FC 78.` };
  }
  if (/glibenclamida/.test(n)) return { tipo: 'blister_medicamento', legible: true, medicamento: { nombre: 'Glibenclamida', dosis: '5 mg', coincide_con_plan: false }, respuesta_para_paciente: 'Veo que es Glibenclamida 5 mg. Ese remedio no figura en el tratamiento que te indicó la Dra. Lucía, así que no te puedo dar indicaciones sobre él: ya se lo consulté a ella. Mientras tanto, no cambies nada de lo que venís tomando sin hablarlo con ella.', nota_para_medico: 'Blíster identificado: Glibenclamida 5 mg (NO coincide con el plan).' };
  if (/blister|metformina|remedio|pastilla/.test(n)) return { tipo: 'blister_medicamento', legible: true, medicamento: { nombre: 'Metformina', dosis: '850 mg', coincide_con_plan: true }, respuesta_para_paciente: 'Es tu Metformina 850 mg, la que te indicó la Dra. Lucía para la diabetes. La tomás a las 08:00 y a las 20:00, con el desayuno y la cena.', nota_para_medico: 'Blíster identificado: Metformina 850 mg (coincide con el plan).' };
  if (/\bpie|herida|lesion|ampolla|piel/.test(n)) return { tipo: 'herida_lesion', legible: true, respuesta_para_paciente: 'Gracias, Marta. Le envié la foto a la Dra. Lucía para que la evalúe y te va a responder por acá. Si aparece fiebre, mal olor, enrojecimiento que avanza o dolor intenso, consultá a la guardia.', nota_para_medico: 'La paciente envía foto de lesión en pie para evaluación.' };
  if (/informe|laborator|analisis|pdf/.test(n) || mime === 'application/pdf')
    return {
      tipo: 'informe_laboratorio',
      legible: true,
      fecha_informe: '2026-10-02',
      laboratorio: [
        { analito: 'hba1c', nombre_original: 'Hemoglobina glicosilada (HbA1c)', valor: 8.4, unidad: '%' },
        { analito: 'glucemia_lab', nombre_original: 'Glucemia en ayunas', valor: 168, unidad: 'mg/dL' },
        { analito: 'creatinina', nombre_original: 'Creatinina', valor: 0.95, unidad: 'mg/dL' },
        { analito: 'colesterol', nombre_original: 'Colesterol total', valor: 212, unidad: 'mg/dL' },
        { analito: 'hdl', nombre_original: 'Colesterol HDL', valor: 44, unidad: 'mg/dL' },
        { analito: 'ldl', nombre_original: 'Colesterol LDL', valor: 131, unidad: 'mg/dL' },
        { analito: 'trigliceridos', nombre_original: 'Triglicéridos', valor: 185, unidad: 'mg/dL' },
        { analito: 'microalbuminuria', nombre_original: 'Microalbuminuria (orina aislada)', valor: 22, unidad: 'mg/g' },
      ],
      respuesta_para_paciente: 'Recibí tu análisis del 02/10. Guardé los resultados para que la Dra. Lucía los revise; si hace falta algo, ella te va a avisar.',
      nota_para_medico: 'Informe de laboratorio 02/10/2026 incorporado (8 analitos).',
    };
  return { tipo: 'otro', legible: false, respuesta_para_paciente: 'Recibí la imagen, pero no pude identificar qué es. Puedo registrar fotos del glucómetro, del tensiómetro, de tus remedios, de tus análisis o de una lesión para que la vea la médica.', nota_para_medico: '' };
}

async function handleFile({ path: filePath, mime, nombre, url, caption }) {
  const st = S.get();
  const cfg = st.assistant.config;
  const isPdf = mime === 'application/pdf';
  const inMsg = C.addMessage({ from: 'marta', kind: isPdf ? 'file' : 'image', text: caption || '', attachment: { url, nombre, mime } });
  const pasos = [{ paso: 'Módulo multimodal', detalle: `${isPdf ? 'Documento PDF recibido' : 'Imagen recibida'}: ${nombre}` }];

  let res;
  try {
    res = await analyze(filePath, mime, nombre, caption, cfg);
  } catch (e) {
    llm.setError(e);
    res = { data: mockAnalyze(nombre, mime, caption, cfg), motor: 'simulado (error del LLM)' };
    pasos.push({ paso: 'LLM no disponible → modo simulado', detalle: String(e.message || e).slice(0, 160) });
  }
  const d = res.data;
  pasos.push({ paso: `Clasificación (${res.motor})`, detalle: `Tipo: ${d.tipo}${d.legible === false ? ' · no legible' : ''}${res.ms ? ` · ${res.ms} ms` : ''}` });

  const media = { id: uid('media'), ts: st.clock, nombre, mime, url, tipo: d.tipo, extraido: d, mensajeId: inMsg.id };
  st.media.push(media);
  inMsg.mediaId = media.id;
  inMsg.intent = d.tipo === 'herida_lesion' ? 'derivacion' : d.tipo === 'otro' ? 'otro' : 'registro';
  inMsg.topic = { glucometro: 'registro de glucemia', tensiometro: 'registro de presión', blister_medicamento: 'identificación de medicamento', herida_lesion: 'lesión / herida', informe_laboratorio: 'informe de laboratorio', otro: 'otro' }[d.tipo];
  C.addTopic(inMsg.topic);
  let reply = d.respuesta_para_paciente;

  // primera capa: las alarmas configuradas se evalúan sobre la lectura (si la hay) y sobre el comentario que acompaña al archivo
  const medicion = {};
  if (d.tipo === 'glucometro' && d.legible && d.glucemia_mg_dl) medicion.glucemia = d.glucemia_mg_dl;
  if (d.tipo === 'tensiometro' && d.legible && d.presion && d.presion.sistolica) medicion.presion = { sis: d.presion.sistolica, dia: d.presion.diastolica };
  const sf = safety.evaluarMedicion(medicion, cfg, caption || '');
  const lectura = medicion.glucemia ? `glucemia ${medicion.glucemia} mg/dl` : medicion.presion ? `presion ${medicion.presion.sis}/${medicion.presion.dia} mmHg` : '';
  pasos.push({ paso: 'Filtro de seguridad', detalle: sf.alarma ? `ALARMA: ${sf.reglas.map((r) => `${r.nombre} [${r.id}] · ${r.detalle}`).join(' | ')}` : `Sin señales de alarma${lectura ? ` (${lectura})` : ''}${caption ? ' + comentario' : ''}` });

  if (medicion.glucemia) {
    const mom = /ayuna/.test(normalize(caption || '')) ? 'ayunas' : /despues|almuerzo|cena|comi/.test(normalize(caption || '')) ? 'posprandial' : 'otro';
    const o = C.addObservation({ tipo: 'glucemia', valor: d.glucemia_mg_dl, unidad: 'mg/dL', momento: mom, fuente: 'foto de glucómetro', mediaId: media.id }, { check: !sf.alarma });
    pasos.push({ paso: 'Registro', detalle: `Observation glucemia ${o.valor} mg/dl + Media` });
  } else if (medicion.presion) {
    C.addObservation({ tipo: 'presion', valor: d.presion.sistolica, valor2: d.presion.diastolica, pulso: d.presion.pulso, unidad: 'mmHg', fuente: 'foto de tensiómetro', mediaId: media.id }, { check: !sf.alarma });
    pasos.push({ paso: 'Registro', detalle: `Observation presión ${d.presion.sistolica}/${d.presion.diastolica} mmHg + Media` });
  } else if (d.tipo === 'blister_medicamento') {
    pasos.push({ paso: 'Verificación contra el plan', detalle: d.medicamento ? `${d.medicamento.nombre} ${d.medicamento.dosis || ''} → ${d.medicamento.coincide_con_plan ? 'coincide' : 'NO coincide'} con la medicación indicada` : 'No identificado' });
    if (d.medicamento && d.medicamento.coincide_con_plan === false) {
      C.addReferral({ motivo: 'Medicamento no incluido en el plan', resumen: `Marta envió foto de ${d.medicamento.nombre} ${d.medicamento.dosis || ''}, que no figura en su medicación indicada.`, prioridad: 'media', mensajeId: inMsg.id, mediaUrl: url });
    }
  } else if (d.tipo === 'herida_lesion') {
    C.addReferral({ motivo: 'Foto de lesión para evaluación', resumen: d.nota_para_medico || 'La paciente envía una foto de una lesión.', prioridad: 'media', mensajeId: inMsg.id, mediaUrl: url });
    pasos.push({ paso: 'Módulo de derivación', detalle: 'Foto enviada a la médica sin análisis automático (DocumentReference + Communication)' });
  } else if (d.tipo === 'informe_laboratorio' && Array.isArray(d.laboratorio)) {
    const fecha = d.fecha_informe ? Date.parse(`${d.fecha_informe}T09:00:00-03:00`) : st.clock;
    for (const l of d.laboratorio) {
      const tipo = l.analito === 'otro' ? 'lab' : l.analito;
      const meta = C.LOINC[tipo];
      C.addObservation({ tipo, nombre: l.nombre_original, valor: l.valor, unidad: l.unidad, fuente: `informe ${nombre}`, mediaId: media.id, ts: isNaN(fecha) ? st.clock : fecha, loinc: meta && meta.code });
    }
    pasos.push({ paso: 'Registro', detalle: `${d.laboratorio.length} Observations de laboratorio + DocumentReference` });
  }
  if (d.legible === false && d.tipo !== 'otro') reply = reply || 'No pude leer bien el valor. ¿Me lo escribís?';

  const { finishAlarm } = require('./assistant');
  const descripcion = `${{ glucometro: 'Foto de glucómetro', tensiometro: 'Foto de tensiómetro' }[d.tipo] || `Archivo (${d.tipo})`}${lectura ? `: ${lectura}` : ''}${caption ? ` – "${caption}"` : ''}`;
  if (sf.alarma) return finishAlarm(inMsg, sf.motivos, descripcion, pasos, sf);

  // segunda capa: alarma propuesta por el modelo de visión, validada por los guardrails
  if (d.alarma && d.alarma.es_alarma) {
    const g = G.validarAlarmaModelo({ alarma: d.alarma, evidencia: `${caption || ''} ${lectura}`, cfg, contextoIds: [], oeConsultado: false });
    pasos.push({ paso: 'Guardrail – alarma propuesta por el modelo', detalle: `${g.aceptada ? 'ACEPTADA' : 'RECHAZADA'} · ${g.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.check}: ${c.detalle}`).join(' | ')}` });
    if (g.aceptada) {
      return finishAlarm(inMsg, [g.regla.nombre], descripcion, pasos, { ...sf, origen: 'modelo', reglas: [{ id: g.regla.id, nombre: g.regla.nombre, detalle: `modelo: "${d.alarma.fundamento}"` }], instrucciones: g.regla.instruccion ? [g.regla.instruccion] : [], guardrail: g.checks });
    }
    C.addReferral({ motivo: 'Posible urgencia no validada por los guardrails', resumen: `El modelo propuso una alarma con el archivo ${nombre} que no pasó la validación (${g.checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}). ${descripcion}`, prioridad: 'alta', mensajeId: inMsg.id, mediaUrl: url });
    reply = `${reply}\nIgual le pasé tu mensaje a la Dra. Lucía con prioridad. Si te sentís peor, consultá a la guardia.`;
  }

  C.addMessage({ from: 'asistente', kind: 'text', text: reply, intent: inMsg.intent, topic: inMsg.topic, referral: d.tipo === 'herida_lesion' });
  S.trace(`Archivo de Marta: ${nombre}`, pasos);
  S.save();
}

module.exports = { handleFile };
