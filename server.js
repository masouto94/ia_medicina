// Servidor del simulador: API + archivos estáticos
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');

const S = require('./src/state');
const C = require('./src/clinic');
const A = require('./src/assistant');
const V = require('./src/vision');
const F = require('./src/fhir');
const llm = require('./src/llm');
const ALM = require('./src/alarmas');
const hce = require('./src/mocks/hce');
const OE = require('./src/mocks/openevidence');
const { seed14 } = require('./src/seed');
const MOD = require('./src/modulos');
const TERM = require('./src/terminologia');
const { uid, fmtDateTime } = require('./src/util');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(S.UPLOADS_DIR));
app.use('/muestras', express.static(path.join(__dirname, 'muestras')));

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf', 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/wav': '.wav' };
const upload = multer({
  storage: multer.diskStorage({
    destination: S.UPLOADS_DIR,
    filename: (req, file, cb) => cb(null, `${uid('f')}${EXT[file.mimetype.split(';')[0]] || path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
});

let busy = 0;
const wrap = (fn) => async (req, res) => {
  try {
    busy++;
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out || { ok: true });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(400).json({ error: String(e.message || e) });
  } finally {
    busy--;
  }
};
const needAssistant = () => {
  if (!S.get().assistant) throw new Error('Primero la médica debe configurar el asistente.');
};

// ---------- Estado ----------
app.get('/api/state', (req, res) => {
  const st = S.get();
  if (st.assistant) ALM.ensure(st.assistant.config); // migra configuraciones guardadas antes de las alarmas configurables
  res.json({
    ...st,
    busy: busy > 0,
    clockText: fmtDateTime(st.clock),
    metrics: st.assistant ? C.metrics(14) : null,
    nextDose: st.assistant ? C.pendingDosesText() : null,
    llm: llm.status(),
  });
});

app.get('/api/catalog', (req, res) => {
  res.json({
    alarmas: { variables: MOD.variables(), operadores: ALM.OPERADORES, origenes: ALM.origenes() },
    temas: A.TEMAS,
    niveles: A.NIVELES,
    modulos: MOD.catalogo(),
    umbralesGenerales: MOD.UMBRALES_GENERALES,
    motivos: TERM.MOTIVOS,
  });
});

// ---------- Simulación ----------
app.post('/api/sim/reset', wrap(() => { S.reset(); }));
app.post('/api/sim/seed', wrap(() => {
  needAssistant();
  if (S.get().seeded) throw new Error('Los 14 días de ejemplo ya fueron generados. Reiniciá la demo para volver a empezar.');
  seed14();
}));
app.post('/api/sim/next-dose', wrap(() => { needAssistant(); A.advanceToNextDose(); }));
app.post('/api/sim/advance', wrap((req) => {
  needAssistant();
  const min = Math.max(1, Math.min(24 * 60, Number(req.body.minutes) || 60));
  const st = S.get();
  const target = st.clock + min * 60e3;
  // si hay tomas en el intervalo, se envían los recordatorios en orden
  let t = C.nextDoseTime(st.clock);
  while (t && t <= target) {
    A.advanceTo(t, true);
    t = C.nextDoseTime(st.clock);
  }
  A.advanceTo(target, false);
}));

// ---------- HCE (mock FHIR) ----------
app.post('/api/hce/import', wrap(() => {
  const b = hce.everything();
  const st = S.get();
  st.hce = hce.toSummary(b);
  S.trace('Importación desde la HCE', [{ paso: 'HCE (mock FHIR)', detalle: `GET /Patient/${hce.PATIENT_ID}/$everything → ${b.entry.length} recursos` }]);
  S.save();
  return { summary: st.hce, bundle: b };
}));
app.get('/api/hce/bundle', (req, res) => res.json(hce.everything()));
app.get('/api/assistant/default', wrap(() => {
  const st = S.get();
  if (!st.hce) throw new Error('Importá primero los datos desde la HCE.');
  return A.defaultConfig(st.hce);
}));

app.post('/api/assistant', wrap((req) => {
  const st = S.get();
  if (!st.hce) throw new Error('Importá primero los datos desde la HCE.');
  const cfg = req.body.config;
  if (!cfg || !cfg.medicacion || !cfg.medicacion.length) throw new Error('Configuración inválida');
  const nuevo = !st.assistant;
  const prev = nuevo ? null : st.assistant.config;
  // las alarmas se editan con sus propios endpoints (cada cambio queda registrado): el formulario no las pisa
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
}));

// ---------- Alarmas (protocolo de urgencia) ----------
function alarmChanged(accion, detalle) {
  const st = S.get();
  st.assistant.actualizado = Date.now();
  st.assistant.version = (st.assistant.version || 1) + 1;
  S.trace(`Alarma ${accion}`, [{ paso: 'Panel médico – alarmas', detalle }]);
  S.save();
  return { alarmas: st.assistant.config.alarmas, umbrales: st.assistant.config.umbrales, actualizado: st.assistant.actualizado, version: st.assistant.version };
}
app.post('/api/alarms', wrap((req) => {
  needAssistant();
  const cfg = S.get().assistant.config;
  const a = ALM.crear(req.body || {});
  cfg.alarmas.push(a);
  return alarmChanged('agregada', `${a.nombre} [${a.id}]: ${ALM.describir(a, cfg)}`);
}));
app.put('/api/alarms/:id', wrap((req) => {
  needAssistant();
  const cfg = S.get().assistant.config;
  const { antes, despues } = ALM.modificar(cfg, req.params.id, req.body || {});
  const accion = 'activa' in (req.body || {}) && Object.keys(req.body).length === 1 ? (despues.activa ? 'reactivada' : 'pausada') : 'modificada';
  return alarmChanged(accion, `${despues.nombre} [${despues.id}]${accion === 'modificada' ? `: ${ALM.describir(despues, cfg)}` : ''}`);
}));
app.delete('/api/alarms/:id', wrap((req) => {
  needAssistant();
  const cfg = S.get().assistant.config;
  const a = ALM.eliminar(cfg, req.params.id);
  return alarmChanged('eliminada', `${a.nombre} [${a.id}]`);
}));

// ---------- Chat de la paciente ----------
app.post('/api/chat/text', wrap(async (req) => {
  needAssistant();
  const text = String(req.body.text || '').trim().slice(0, 2000);
  if (!text) throw new Error('Mensaje vacío');
  await A.handleText(text);
}));

app.post('/api/chat/audio', upload.single('audio'), wrap(async (req) => {
  needAssistant();
  const transcript = String(req.body.transcript || '').trim();
  if (!transcript) throw new Error('No se obtuvo la transcripción del audio');
  const attachment = req.file ? { audioUrl: `/uploads/${req.file.filename}`, duracion: Number(req.body.duration) || null } : null;
  await A.handleText(transcript, { via: 'audio', attachment });
}));

app.post('/api/chat/file', upload.single('file'), wrap(async (req) => {
  needAssistant();
  if (!req.file) throw new Error('No se recibió archivo');
  const mime = req.file.mimetype;
  if (!ALLOWED.includes(mime)) {
    fs.unlinkSync(req.file.path);
    throw new Error('Formato no soportado (usá JPG, PNG, WEBP o PDF)');
  }
  await V.handleFile({ path: req.file.path, mime, nombre: Buffer.from(req.file.originalname, 'latin1').toString('utf8'), url: `/uploads/${req.file.filename}`, caption: String(req.body.caption || '').trim() });
}));

app.get('/api/muestras', (req, res) => {
  const dir = path.join(__dirname, 'muestras');
  const desc = JSON.parse(fs.readFileSync(path.join(dir, 'muestras.json'), 'utf8'));
  res.json(desc.filter((d) => fs.existsSync(path.join(dir, d.archivo))));
});

app.post('/api/chat/sample', wrap(async (req) => {
  needAssistant();
  const name = path.basename(String(req.body.archivo || ''));
  const src = path.join(__dirname, 'muestras', name);
  if (!fs.existsSync(src)) throw new Error('Muestra no encontrada');
  const mime = name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dest = `${uid('f')}${path.extname(name)}`;
  fs.copyFileSync(src, path.join(S.UPLOADS_DIR, dest));
  await V.handleFile({ path: path.join(S.UPLOADS_DIR, dest), mime, nombre: name, url: `/uploads/${dest}`, caption: String(req.body.caption || '').trim() });
}));

app.post('/api/reminder/:id', wrap((req) => { A.answerReminder(req.params.id, !!req.body.tomada); }));
app.post('/api/slot/:id', wrap((req) => { A.bookSlot(req.params.id); }));

// ---------- Médica ----------
app.post('/api/referral/:id/reply', wrap((req) => {
  const t = String(req.body.texto || '').trim();
  if (!t) throw new Error('Escribí una respuesta');
  A.doctorReply(req.params.id, t);
}));
app.post('/api/alert/:id/ack', wrap((req) => {
  const a = S.get().alerts.find((x) => x.id === req.params.id);
  if (a) a.ack = true;
  S.save();
}));
app.post('/api/suggestion/:id', wrap((req) => {
  const s = S.get().suggestions.find((x) => x.id === req.params.id);
  if (s) s.estado = req.body.estado === 'aceptada' ? 'aceptada' : 'descartada';
  S.save();
}));
app.post('/api/summary', wrap(async () => { needAssistant(); return A.preconsultaSummary(); }));
app.post('/api/evidence', wrap((req) => {
  const q = String(req.body.pregunta || '').trim();
  if (!q) throw new Error('Escribí una pregunta');
  const st = S.get();
  const ev = OE.consultar(q, 'diabetes tipo 2');
  st.evidenceQueries.unshift({ ...ev, ts: st.clock, origen: 'médica (panel)', pregunta: ev.query_anonimizada });
  S.trace('Consulta de evidencia (médica)', [{ paso: 'OpenEvidence (mock)', detalle: `"${ev.query_anonimizada}" → ${ev.tema}` }]);
  S.save();
  return ev;
}));

// ---------- FHIR y CDS Hooks ----------
app.get('/api/fhir/bundle', (req, res) => {
  const b = F.bundle(`${req.protocol}://${req.get('host')}`);
  if (req.query.download) res.setHeader('Content-Disposition', 'attachment; filename="marta-fhir-bundle.json"');
  res.type('application/fhir+json').send(JSON.stringify(b, null, 2));
});
app.get('/cds-services', (req, res) => res.json(F.DISCOVERY));
app.post('/cds-services/seguimiento-entre-consultas', (req, res) => res.json(F.cdsCards()));

const PORT = Number(process.env.PORT) || 3000;
llm.init().then((s) => {
  app.listen(PORT, () => {
    console.log(`\n  Asistente DM2 – simulador`);
    console.log(`  ➜ http://localhost:${PORT}`);
    console.log(`  Motor IA: ${s.enabled ? s.model : 'MODO SIMULADO'}${s.detail ? `  (${s.detail})` : ''}\n`);
  });
});
