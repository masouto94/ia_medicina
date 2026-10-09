// Trazabilidad y auditoría, como si el asistente fuera software como producto médico (SaMD).
//
// - Procedencia: cada respuesta del asistente queda asociada a la versión del modelo y del prompt, las versiones
//   de los módulos, la versión de la configuración de la médica y los fragmentos del RAG que intervinieron.
//   → logs/procedencia.jsonl + FHIR Provenance (logs/fhir/Provenance.ndjson)
// - Auditoría: cada cambio de configuración registra quién, cuándo y el valor antes y después.
//   → logs/auditoria.jsonl + FHIR AuditEvent (logs/fhir/AuditEvent.ndjson)
//
// Para no pasar un "contexto" por todas las funciones se usa AsyncLocalStorage: el servidor fija el actor de
// cada pedido (la médica, la paciente o la simulación) y cada interacción de la paciente abre un contexto donde
// el pipeline anota lo que usó (llamadas al modelo, fragmentos, guardrails, evidencia, mensajes, derivaciones).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('node:async_hooks');
const S = require('./state');
const M = require('./modulos');
const LOGS = require('./logs');
const SEUD = require('./seudonimo');
const { uid } = require('./util');

const RAIZ = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
const GENERICAS_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(M.DIR, 'alarmas_genericas.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
})();
const EXT_HASH = 'urn:asistente:extension:hash-cadena';
const SYS = (s) => `urn:asistente:${s}`;
const sha = LOGS.sha256;

// ---------------- Versiones ----------------
function commitGit() {
  try {
    const head = fs.readFileSync(path.join(RAIZ, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 7);
    const ref = head.slice(5).trim();
    const suelto = path.join(RAIZ, '.git', ref);
    if (fs.existsSync(suelto)) return fs.readFileSync(suelto, 'utf8').trim().slice(0, 7);
    const packed = fs.readFileSync(path.join(RAIZ, '.git', 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 7) : null;
  } catch {
    return null;
  }
}
const APP = { nombre: PKG.name, version: PKG.version, commit: commitGit() };

/** Huella estable de un objeto (las claves se ordenan antes de calcular el hash). */
function huella(obj) {
  const orden = (x) => (Array.isArray(x) ? x.map(orden) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, orden(x[k])])) : x);
  return sha(JSON.stringify(orden(obj)));
}

/** Versiones de todo lo que interviene en una respuesta, según la configuración vigente. */
function versiones() {
  const st = S.get();
  const a = st.assistant;
  const cfg = a ? a.config : null;
  return {
    app: APP,
    modulos: cfg ? M.activos(cfg).map((id) => ({ id, version: M.get(id).version || null })) : [],
    alarmasGenericas: GENERICAS_VERSION,
    configuracion: cfg ? { id: cfg.id, version: a.version || 1, sha256: huella(cfg) } : null,
  };
}

// ---------------- Actor (quién hace cada cosa) ----------------
const actorALS = new AsyncLocalStorage();
const ACTORES = {
  medica: { tipo: 'persona', id: 'lucia-001', nombre: 'Dra. Lucía Fernández', rol: 'médica', origen: 'panel médico (web)' },
  paciente: { tipo: 'persona', id: 'marta-001', nombre: 'Marta González', rol: 'paciente', origen: 'canal de la paciente (WhatsApp simulado)' },
  sistema: { tipo: 'sistema', id: 'asistente', nombre: 'Asistente (proceso interno)', rol: 'sistema', origen: 'servidor' },
};

function conActor(actor, fn) {
  return actorALS.run(actor, fn);
}
function actor() {
  return actorALS.getStore() || ACTORES.sistema;
}

// Nada personal de la paciente llega a logs/: cada registro pasa por la seudonimización antes de escribirse
function agregarSeudonimizado(tipo, reg, aFhir) {
  const limpio = SEUD.desidentificar(reg);
  return LOGS.agregar(tipo, limpio, aFhir ? (r) => SEUD.desidentificar(aFhir(r)) : null);
}

// ---------------- Interacciones de la paciente ----------------
const interALS = new AsyncLocalStorage();

/** Ejecuta fn dentro de un contexto de interacción y, al terminar, registra la procedencia de las respuestas. */
async function enInteraccion(tipo, fn) {
  const ctx = { id: uid('prov'), tipo, versiones: versiones(), llamadas: [], rag: [], contexto: [], guardrails: [], evidencia: [], mensajes: [], salidas: [], derivaciones: [], alertas: [], observaciones: [] };
  try {
    return await interALS.run(ctx, fn);
  } finally {
    try {
      registrarProcedencia(ctx);
    } catch (e) {
      console.error('No se pudo registrar la procedencia:', e);
    }
  }
}

/** Anota algo en la interacción en curso (si no hay ninguna, no hace nada). Las listas acumulan; el resto reemplaza. */
function anotar(campo, valor) {
  const c = interALS.getStore();
  if (!c) return;
  if (Array.isArray(c[campo]) && !Array.isArray(valor)) c[campo].push(valor);
  else c[campo] = valor;
}

const PRIORIDAD = { baja: 1, media: 2, alta: 3 };

function registrarProcedencia(ctx) {
  // respuestas a la paciente (mensajes) y otras salidas generadas (por ejemplo, el resumen preconsulta para la médica)
  const respuestas = [...ctx.mensajes.filter((m) => m.from === 'asistente'), ...ctx.salidas];
  if (!respuestas.length) return null;
  const st = S.get();
  const entrada = ctx.mensajes.find((m) => m.from === 'marta');
  const alarma = respuestas.find((m) => m.kind === 'alarm');
  const prio = ctx.derivaciones.reduce((p, r) => Math.max(p, PRIORIDAD[r.prioridad] || 0), 0);
  const versionFrag = (f) => (f.plan ? `config-v${(ctx.versiones.configuracion || {}).version}` : (ctx.versiones.modulos.find((m) => m.id === f.modulo) || {}).version || null);
  const citados = [...new Set(respuestas.flatMap((m) => (m.sources || []).map((s) => s.id)))];
  const llm = require('./llm');
  const reg = {
    id: ctx.id,
    tipo: 'procedencia',
    sesion: st.sesion,
    ts: st.clock,
    registrado: new Date().toISOString(),
    interaccion: ctx.tipo,
    actor: actor(),
    entrada: entrada ? { id: entrada.id, kind: entrada.kind, sha256: sha(entrada.text || (entrada.attachment && entrada.attachment.nombre) || '') } : null,
    respuestas: respuestas.map((m) => ({ id: m.id, kind: m.kind, recurso: m.recurso || 'Communication', destino: m.destino || 'paciente', intencion: m.intent || null, sha256: sha(m.text || '') })),
    decision: {
      intencion: entrada ? entrada.intent || null : null,
      alarma: !!alarma,
      origenAlarma: alarma ? alarma.origenAlarma || 'regla' : null,
      reglasAlarma: alarma ? (alarma.reglas || []).map((r) => r.id) : [],
      derivacion: prio ? Object.keys(PRIORIDAD).find((k) => PRIORIDAD[k] === prio) : null,
      codigosDerivacion: ctx.derivaciones.map((r) => (r.codigo ? r.codigo.code : null)).filter(Boolean),
      registros: ctx.observaciones.map((o) => o.tipo),
      evidencia: ctx.evidencia,
      guardrails: ctx.guardrails,
    },
    modelo: {
      usado: ctx.llamadas.some((l) => !l.error),
      motor: ctx.llamadas.length ? llm.MODEL : llm.enabled ? 'no intervino (reglas)' : 'simulado (sin IA)',
      llamadas: ctx.llamadas,
    },
    versiones: ctx.versiones,
    rag: {
      recuperados: ctx.rag.map((f) => ({ id: f.id, score: f.score, modulo: f.plan ? null : f.modulo || null, plan: !!f.plan, version: versionFrag(f) })),
      enviadosAlModelo: ctx.contexto,
      citados,
    },
  };
  const final = agregarSeudonimizado('procedencia', reg, aProvenance);
  for (const m of ctx.mensajes) if (m.from === 'asistente') m.procedencia = final.id;
  for (const s of ctx.salidas) {
    const sum = st.summaries.find((x) => x.id === s.id);
    if (sum) sum.procedencia = final.id;
  }
  S.save();
  return final;
}

// ---------------- Trazas (historial del paso a paso) ----------------
// Cada S.trace se guarda también en logs/trazas.jsonl, sin el texto de la paciente (lo que va entre comillas)
// ni sus datos personales. Si ocurre dentro de una interacción, queda vinculada a su procedencia.
function registrarTraza(t, sesion) {
  const ctx = interALS.getStore();
  const reg = {
    id: uid('trz'),
    tipo: 'traza',
    sesion,
    ts: t.ts,
    registrado: new Date(t.real).toISOString(),
    actor: actor(),
    interaccion: ctx ? ctx.id : null,
    evento: SEUD.sinTextoDePaciente(t.evento),
    pasos: (t.pasos || []).map((p) => ({ paso: SEUD.sinTextoDePaciente(p.paso), detalle: SEUD.sinTextoDePaciente(p.detalle == null ? '' : p.detalle) })),
  };
  return agregarSeudonimizado('trazas', reg, null);
}
S.onTrace(registrarTraza);

// ---------------- Auditoría de cambios ----------------
/** Diferencias campo por campo entre dos valores (recorre objetos; listas y valores simples se comparan enteros). */
function diferencias(antes, despues, prefijo = '') {
  const esObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (esObj(antes) && esObj(despues)) {
    const claves = [...new Set([...Object.keys(antes), ...Object.keys(despues)])];
    return claves.flatMap((k) => diferencias(antes[k], despues[k], prefijo ? `${prefijo}.${k}` : k));
  }
  if (JSON.stringify(antes) === JSON.stringify(despues)) return [];
  return [{ campo: prefijo || '(valor)', antes: antes === undefined ? null : antes, despues: despues === undefined ? null : despues }];
}

/**
 * Registra un cambio de configuración (o una acción sobre la demo).
 * @param {{accion:'C'|'U'|'D'|'E', evento:string, objeto:{tipo:string,id:string,nombre?:string}, antes?:any, despues?:any, versionAntes?:number|null, versionDespues?:number|null, detalle?:string}} e
 */
function auditar(e) {
  const st = S.get();
  const a = st.assistant;
  const reg = {
    id: uid('aud'),
    tipo: 'auditoria',
    sesion: e.sesion || st.sesion,
    ts: st.clock,
    registrado: new Date().toISOString(),
    accion: e.accion,
    categoria: e.categoria || (e.accion === 'R' ? 'consulta' : 'cambio'), // cambio | consulta | exportacion
    evento: e.evento,
    actor: actor(),
    objeto: e.objeto,
    detalle: e.detalle || null,
    configuracion: {
      id: a ? a.config.id : null,
      versionAntes: e.versionAntes === undefined ? null : e.versionAntes,
      versionDespues: e.versionDespues === undefined ? (a ? a.version || 1 : null) : e.versionDespues,
    },
    cambios: e.antes != null && e.despues != null ? diferencias(e.antes, e.despues) : [],
    antes: e.antes === undefined ? null : e.antes,
    despues: e.despues === undefined ? null : e.despues,
    app: APP,
  };
  return agregarSeudonimizado('auditoria', reg, aAuditEvent);
}

// ---------------- FHIR R4 ----------------
const ref = (sistema, valor, display) => ({ identifier: { system: SYS(sistema), value: String(valor) }, ...(display ? { display } : {}) });
const PACIENTE = () => ref('paciente', SEUD.seudonimo()); // sólo el seudónimo: sin nombre ni id de la HCE
const MEDICA = ref('usuario', 'lucia-001', 'Dra. Lucía Fernández');
const SOFTWARE = (app) => ref('software', app.nombre, `Asistente de seguimiento ${app.version}${app.commit ? ` (${app.commit})` : ''}`);
const meta = (r) => ({ tag: [{ system: SYS('sesion'), code: r.sesion }] });
const extHash = (r) => [{ url: EXT_HASH, valueString: r.hash }];

function aProvenance(r) {
  const tipoAgente = (code, display) => ({ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code, display }] });
  const modelos = [...new Map(r.modelo.llamadas.filter((l) => !l.error).map((l) => [l.modeloId || l.alias, l])).values()];
  const v = r.versiones;
  const agentes = [
    { type: tipoAgente('author', 'Author'), who: SOFTWARE(v.app), onBehalfOf: MEDICA },
    ...modelos.map((l) => ({ type: tipoAgente('assembler', 'Assembler'), who: ref('modelo', l.modeloId || l.alias, `${l.proveedor} · ${l.modeloId || l.alias}${l.cli ? ` (CLI ${l.cli})` : ''}`) })),
    ...(r.decision.guardrails.length ? [{ type: tipoAgente('verifier', 'Verifier'), who: ref('software', 'guardrails', 'Guardrails de alarmas del modelo') }] : []),
  ];
  const fuente = (what, role = 'source') => ({ role, what });
  const entidades = [
    ...(r.entrada ? [fuente({ type: 'Communication', ...ref('mensaje', r.entrada.id, 'Mensaje de la paciente') })] : []),
    ...(v.configuracion ? [fuente(ref('configuracion', `${v.configuracion.id}|v${v.configuracion.version}`, `Configuración de la médica v${v.configuracion.version} (sha256 ${v.configuracion.sha256.slice(0, 12)})`))] : []),
    ...v.modulos.map((m) => fuente(ref('modulo', `${m.id}|${m.version}`, `Módulo ${m.id} ${m.version}`))),
    ...(v.alarmasGenericas ? [fuente(ref('modulo', `alarmas_genericas|${v.alarmasGenericas}`, `Alarmas genéricas ${v.alarmasGenericas}`))] : []),
    ...r.rag.recuperados
      .filter((f) => r.rag.enviadosAlModelo.includes(f.id) || r.rag.citados.includes(f.id))
      .map((f) => fuente(ref('fragmento', `${f.id}|${f.version}`, `Fragmento ${f.id}${r.rag.citados.includes(f.id) ? ' (citado)' : ''}`), r.rag.citados.includes(f.id) ? 'quotation' : 'source')),
    ...[...new Set(r.modelo.llamadas.map((l) => l.plantilla).filter(Boolean))].map((p) => fuente(ref('prompt', p, 'Plantilla del prompt (sha256)'))),
  ];
  return {
    resourceType: 'Provenance',
    id: r.id,
    meta: meta(r),
    extension: extHash(r),
    target: r.respuestas.map((m) => ({ type: m.recurso || 'Communication', ...ref(m.recurso === 'Composition' ? 'documento' : 'mensaje', m.id, `${m.recurso === 'Composition' ? 'Documento' : 'Respuesta del asistente'} (${m.kind}) para ${m.destino || 'paciente'}`) })),
    occurredDateTime: new Date(r.ts).toISOString(),
    recorded: r.registrado,
    activity: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code: 'CREATE', display: 'create' }], text: `Respuesta del asistente (${r.interaccion})` },
    agent: agentes,
    entity: entidades,
  };
}

const SUBTIPO = { C: 'create', R: 'read', U: 'update', D: 'delete', E: 'operation' };

function aAuditEvent(r) {
  const persona = r.actor.tipo === 'persona';
  const detalle = [
    r.antes != null ? { type: 'antes', valueString: JSON.stringify(r.antes) } : null,
    r.despues != null ? { type: 'despues', valueString: JSON.stringify(r.despues) } : null,
    r.cambios.length ? { type: 'cambios', valueString: JSON.stringify(r.cambios) } : null,
    r.configuracion.versionAntes != null || r.configuracion.versionDespues != null ? { type: 'versionConfiguracion', valueString: `${r.configuracion.versionAntes ?? '—'} → ${r.configuracion.versionDespues ?? '—'}` } : null,
  ].filter(Boolean);
  return {
    resourceType: 'AuditEvent',
    id: r.id,
    meta: meta(r),
    extension: extHash(r),
    // una exportación de datos de la paciente es el evento DICOM "Export"; el resto, operaciones REST
    ...(r.categoria === 'exportacion'
      ? { type: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110106', display: 'Export' } }
      : { type: { system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'Restful Operation' }, subtype: [{ system: 'http://hl7.org/fhir/restful-interaction', code: SUBTIPO[r.accion] }] }),
    action: r.accion,
    period: { start: new Date(r.ts).toISOString() },
    recorded: r.registrado,
    outcome: '0',
    outcomeDesc: r.evento,
    agent: [
      {
        type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/extra-security-role-type', code: persona ? 'humanuser' : 'dataprocessor', display: persona ? 'human user' : 'data processor' }] },
        who: ref('usuario', r.actor.id, r.actor.nombre),
        requestor: true,
        ...(r.actor.ip ? { network: { address: r.actor.ip, type: '2' } } : {}),
      },
    ],
    source: {
      site: 'Asistente de seguimiento (simulador)',
      observer: { display: `${r.app.nombre} ${r.app.version}${r.app.commit ? ` (${r.app.commit})` : ''}` },
      type: [{ system: 'http://terminology.hl7.org/CodeSystem/security-source-type', code: '3', display: 'Web Server' }],
    },
    entity: [
      {
        what: ref(r.objeto.tipo, r.objeto.id, r.objeto.nombre),
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '2', display: 'System Object' },
        name: r.objeto.nombre || r.objeto.id,
        description: r.detalle || r.evento,
        ...(detalle.length ? { detail: detalle } : {}),
      },
      {
        what: PACIENTE(),
        type: { system: 'http://terminology.hl7.org/CodeSystem/audit-entity-type', code: '1', display: 'Person' },
        role: { system: 'http://terminology.hl7.org/CodeSystem/object-role', code: '1', display: 'Patient' },
      },
    ],
  };
}

module.exports = { conActor, actor, ACTORES, enInteraccion, anotar, auditar, versiones, diferencias, huella, aProvenance, aAuditEvent, APP, sha };
