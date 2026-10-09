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
const CFG = require('./src/configuracion');
const SIM = require('./src/simulacion');
const T = require('./src/trazabilidad');
const LOGS = require('./src/logs');
const SEUD = require('./src/seudonimo');
const HCE = require('./src/envioHce');
const hce = require('./src/mocks/hce');
const OE = require('./src/mocks/openevidence');
const { seed14 } = require('./src/seed');
const MOD = require('./src/modulos');
const TERM = require('./src/terminologia');
const { uid, fmtDateTime } = require('./src/util');

const app = express();
app.use(express.json({ limit: '2mb' }));
// Quién hace cada pedido (para la auditoría y la procedencia). El simulador no tiene login: el panel es la
// Dra. Lucía y el teléfono es Marta. En un sistema real esto saldría de la autenticación.
app.use((req, res, next) => {
  const paciente = /^\/api\/(chat|reminder|slot)\b/.test(req.path);
  const base = paciente ? T.ACTORES.paciente : T.ACTORES.medica;
  T.conActor({ ...base, ip: req.ip || null }, next);
});
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
// Mientras corre una simulación con plan, la API no acepta cambios (sólo leer el estado o cancelar)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || !SIM.corriendo() || req.path === '/sim/plan/cancel') return next();
  res.status(409).json({ error: 'Hay una simulación con plan en curso. Esperá a que termine o cancelala.' });
});

const needAssistant = () => {
  if (!S.get().assistant) throw new Error('Primero la médica debe configurar el asistente.');
};

// ---------- Estado ----------
app.get('/api/state', (req, res) => {
  const st = S.get();
  if (st.assistant) ALM.ensure(st.assistant.config); // migra configuraciones guardadas antes de las alarmas configurables
  res.json({
    ...st,
    busy: busy > 0 || SIM.corriendo(),
    simulacion: SIM.estado(),
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
    hce: HCE.info(),
  });
});

// ---------- Simulación ----------
app.post('/api/sim/reset', wrap(() => CFG.reiniciarDemo()));
app.post('/api/sim/seed', wrap(() => { CFG.generarDatosEjemplo(seed14); }));
app.post('/api/sim/next-dose', wrap(() => { needAssistant(); A.advanceToNextDose(); }));
app.post('/api/sim/advance', wrap((req) => {
  needAssistant();
  A.avanzar(Math.max(1, Math.min(24 * 60, Number(req.body.minutes) || 60)));
}));

// Simulación a demanda con un plan JSON (ver muestras/planes/)
const PLANES_DIR = path.join(__dirname, 'muestras', 'planes');
app.get('/api/sim/planes', (req, res) => {
  const archivos = fs.existsSync(PLANES_DIR) ? fs.readdirSync(PLANES_DIR).filter((f) => f.endsWith('.json')).sort() : [];
  res.json(
    archivos.map((archivo) => {
      const contenido = JSON.parse(fs.readFileSync(path.join(PLANES_DIR, archivo), 'utf8'));
      const planes = Array.isArray(contenido.planes) ? contenido.planes : [contenido];
      return { archivo, nombre: contenido.nombre || archivo, descripcion: contenido.descripcion || '', planes: planes.length, pasos: planes.reduce((n, p) => n + (p.pasos || []).length, 0), contenido };
    }),
  );
});
app.post('/api/sim/plan/validate', wrap((req) => {
  const planes = SIM.validarPlanes(req.body.plan);
  return { ok: true, planes: planes.length, pasos: planes.reduce((n, p) => n + p.pasos.length, 0) };
}));
app.post('/api/sim/plan', wrap((req) => SIM.iniciar(req.body.plan, String(req.body.nombre || 'plan').slice(0, 120))));
app.post('/api/sim/plan/cancel', wrap(() => SIM.cancelar()));
app.get('/api/sim/plan', (req, res) => {
  const e = SIM.estado();
  if (!e) return res.status(404).json({ error: 'Todavía no se ejecutó ningún plan' });
  res.json(e);
});

// ---------- HCE (mock FHIR) ----------
app.post('/api/hce/import', wrap(() => CFG.importarHCE()));
// Ver los datos de origen de la HCE es un acceso a datos identificados: queda auditado
app.get('/api/hce/bundle', (req, res) => {
  const b = hce.everything();
  T.auditar({ accion: 'R', evento: 'Datos de la HCE consultados', objeto: { tipo: 'hce', id: hce.PATIENT_ID, nombre: 'Registro de la paciente en la HCE' }, detalle: `${b.entry.length} recursos vistos en el panel`, versionAntes: null, versionDespues: null });
  res.json(b);
});
app.get('/api/assistant/default', wrap(() => {
  const st = S.get();
  if (!st.hce) throw new Error('Importá primero los datos desde la HCE.');
  return A.defaultConfig(st.hce);
}));

app.post('/api/assistant', wrap((req) => { CFG.guardarAsistente(req.body.config); }));

// ---------- Alarmas (protocolo de urgencia) ----------
app.post('/api/alarms', wrap((req) => CFG.agregarAlarma(req.body)));
app.put('/api/alarms/:id', wrap((req) => CFG.modificarAlarma(req.params.id, req.body)));
app.delete('/api/alarms/:id', wrap((req) => CFG.eliminarAlarma(req.params.id)));

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
  await V.enviarMuestra(String(req.body.archivo || ''), String(req.body.caption || '').trim());
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
app.post('/api/suggestion/:id', wrap((req) => CFG.resolverSugerencia(req.params.id, String(req.body.estado || ''))));
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

// ---------- Trazabilidad y auditoría (logs/) ----------
app.get('/api/auditoria', (req, res) => {
  const sesion = req.query.alcance === 'todo' ? null : S.get().sesion;
  const limite = Math.min(Number(req.query.limite) || 300, 2000);
  res.json({
    sesion: S.get().sesion,
    alcance: sesion ? 'sesion' : 'todo',
    auditoria: LOGS.leer('auditoria', { sesion, limite }),
    procedencia: LOGS.leer('procedencia', { sesion, limite }),
    integridad: { auditoria: LOGS.verificar('auditoria'), procedencia: LOGS.verificar('procedencia'), trazas: LOGS.verificar('trazas') },
    seudonimo: SEUD.seudonimo(),
    archivos: LOGS.archivos(),
    versiones: T.versiones(),
  });
});

// Historial de trazas (logs/trazas.jsonl, sin datos de la paciente)
app.get('/api/trazas', (req, res) => {
  const sesion = req.query.alcance === 'todo' ? null : S.get().sesion;
  res.json({ sesion: S.get().sesion, trazas: LOGS.leer('trazas', { sesion, limite: Math.min(Number(req.query.limite) || 500, 5000) }), integridad: LOGS.verificar('trazas') });
});

// ---------- FHIR y CDS Hooks ----------
// Los datos identificados no se descargan a archivos: se ven en el panel (acceso auditado) y salen sólo
// por el envío a la HCE (exportación auditada).
const resumenFhir = (b) => b.entry.reduce((m, e) => ({ ...m, [e.resource.resourceType]: (m[e.resource.resourceType] || 0) + 1 }), {});
app.get('/api/fhir/resumen', (req, res) => {
  // cantidades por tipo de recurso, sin datos de la paciente (para la pestaña, sin generar accesos)
  res.json({ recursos: resumenFhir(F.bundle()), exportaciones: S.get().exportaciones || [], hce: HCE.info() });
});
app.get('/api/fhir/bundle', (req, res) => {
  const b = F.bundle(`${req.protocol}://${req.get('host')}`);
  T.auditar({ accion: 'R', evento: 'Bundle FHIR consultado', objeto: { tipo: 'hce', id: hce.PATIENT_ID, nombre: 'Bundle FHIR de la paciente' }, detalle: `${b.entry.length} recursos vistos en el panel`, versionAntes: null, versionDespues: null });
  res.type('application/fhir+json').send(JSON.stringify(b, null, 2));
});
app.post('/api/hce/export', wrap(async (req) => {
  needAssistant();
  const st = S.get();
  const destino = HCE.info();
  const tx = F.transaccion(`${req.protocol}://${req.get('host')}`);
  const recursos = resumenFhir(tx);
  let r = null;
  let error = null;
  try {
    r = await HCE.enviar(tx);
  } catch (e) {
    error = e;
  }
  const exp = { id: uid('exp'), ts: st.clock, real: Date.now(), recursos, total: tx.entry.length, destino: destino.url, modo: destino.modo, estado: error ? 'error' : r.estado, aceptados: r ? r.aceptados : 0, rechazados: r ? r.rechazados : 0, error: error ? error.message : null };
  st.exportaciones = st.exportaciones || [];
  st.exportaciones.push(exp);
  const lista = Object.entries(recursos).map(([k, v]) => `${v} ${k}`).join(', ');
  T.auditar({
    accion: 'E',
    categoria: 'exportacion',
    resultado: error ? 'error' : 'ok',
    evento: error ? 'Envío a la HCE fallido' : 'Bundle enviado a la HCE',
    objeto: { tipo: 'hce', id: hce.PATIENT_ID, nombre: 'Registro de la paciente en la HCE' },
    detalle: `POST ${destino.url} (${destino.modo === 'real' ? 'envío real' : 'envío simulado'}): Bundle transaction con ${tx.entry.length} recursos (${lista})${error ? ` · ERROR: ${error.message}` : r.http ? ` · HTTP ${r.http}, ${r.aceptados} aceptados` : ''}`,
    versionAntes: null,
    versionDespues: null,
  });
  S.trace(error ? 'Envío a la HCE fallido' : 'Exportación a la HCE', [{ paso: `HCE FHIR (${destino.modo})`, detalle: `POST ${destino.url} · Bundle transaction con ${tx.entry.length} recursos (PUT, idempotente)${error ? ` · ERROR: ${error.message}` : ''}` }]);
  S.save();
  if (error) throw new Error(`No se pudo enviar a la HCE: ${error.message}`);
  return exp;
}));
app.get('/cds-services', (req, res) => res.json(F.DISCOVERY));
app.post('/cds-services/seguimiento-entre-consultas', (req, res) => {
  const r = F.cdsCards();
  T.auditar({ accion: 'R', evento: 'Registro consultado vía CDS Hooks (patient-view)', objeto: { tipo: 'hce', id: hce.PATIENT_ID, nombre: 'Tarjetas CDS para la HCE' }, detalle: `${r.cards.length} tarjetas entregadas a la HCE`, versionAntes: null, versionDespues: null });
  res.json(r);
});

const PORT = Number(process.env.PORT) || 3000;
llm.init().then((s) => {
  app.listen(PORT, () => {
    console.log(`\n  Asistente DM2 – simulador`);
    console.log(`  ➜ http://localhost:${PORT}`);
    console.log(`  Motor IA: ${s.enabled ? s.model : 'MODO SIMULADO'}${s.detail ? `  (${s.detail})` : ''}\n`);
  });
});
