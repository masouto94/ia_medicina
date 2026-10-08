// Módulos por patología = conocimiento (fragmentos para el RAG) + configuración por defecto
// (variables, metas, umbrales, alertas para la médica, alarmas y pautas para el modelo).
// Para sumar una patología alcanza con agregar knowledge/<id>.json: no hace falta tocar código.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'knowledge');
const NO_MODULO = new Set(['alarmas_genericas.json']);

// Patologías previstas que todavía no tienen módulo (sólo para mostrarlas en el panel)
const PROXIMAMENTE = [
  { id: 'ic', nombre: 'Insuficiencia cardíaca' },
  { id: 'epoc', nombre: 'EPOC' },
  { id: 'aco', nombre: 'Anticoagulación' },
];

// Configuración general (no depende de ninguna patología)
const UMBRALES_GENERALES = [{ clave: 'omisionesConsecutivas', etiqueta: 'Tomas omitidas seguidas (alerta)', unidad: '', valor: 2 }];

const modulos = {};
for (const f of fs.readdirSync(DIR).filter((x) => x.endsWith('.json') && !NO_MODULO.has(x)).sort()) {
  const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  if (!m.id || !Array.isArray(m.fragmentos)) continue;
  m.configuracion = m.configuracion || {};
  for (const k of ['metas', 'umbrales', 'alertas', 'alarmas', 'instruccionesModelo']) m.configuracion[k] = m.configuracion[k] || [];
  m.configuracion.variables = m.configuracion.variables || {};
  m.archivo = f;
  modulos[m.id] = m;
}

function get(id) {
  return modulos[id];
}
function ids() {
  return Object.keys(modulos);
}
function activos(cfg) {
  return ((cfg && cfg.modulos) || []).filter((id) => modulos[id]);
}

// Módulos que corresponden a los diagnósticos importados de la HCE (por código SNOMED CT)
function sugeridosPorDiagnostico(codigos) {
  return ids().filter((id) => (modulos[id].snomed || []).some((c) => codigos.includes(c)));
}

// Variables medibles (para alarmas, alertas y observaciones). Sin argumento: todas.
function variables(mods) {
  const out = {};
  for (const id of mods || ids()) Object.assign(out, (modulos[id] && modulos[id].configuracion.variables) || {});
  return out;
}

// Completa metas y umbrales con los valores por defecto de los módulos activos, sin pisar lo editado
function ensureConfig(cfg) {
  cfg.metas = cfg.metas || {};
  cfg.umbrales = cfg.umbrales || {};
  for (const id of activos(cfg)) {
    const c = modulos[id].configuracion;
    for (const m of c.metas) if (cfg.metas[m.clave] == null) cfg.metas[m.clave] = m.valor;
    for (const u of c.umbrales) if (cfg.umbrales[u.clave] == null) cfg.umbrales[u.clave] = u.valor;
  }
  for (const u of UMBRALES_GENERALES) if (cfg.umbrales[u.clave] == null) cfg.umbrales[u.clave] = u.valor;
  return cfg;
}

function defaults(mods) {
  return ensureConfig({ modulos: mods, metas: {}, umbrales: {} });
}

// Texto para los prompts del modelo
function metasTexto(cfg) {
  return activos(cfg)
    .map((id) => `${modulos[id].nombre}: ${modulos[id].configuracion.metas.map((m) => `${m.etiqueta} ${cfg.metas[m.clave]} ${m.unidad}`.trim()).join('; ')}`)
    .join(' | ');
}
function umbralesTexto(cfg) {
  return activos(cfg)
    .map((id) => `${modulos[id].nombre}: ${modulos[id].configuracion.umbrales.map((u) => `${u.etiqueta} ${cfg.umbrales[u.clave]} ${u.unidad}`.trim()).join('; ')}`)
    .join(' | ');
}
// Pautas específicas de cada módulo para el modelo; {umbrales.x} y {metas.x} se reemplazan por los valores de la médica
function instruccionesModelo(cfg) {
  return activos(cfg).flatMap((id) =>
    modulos[id].configuracion.instruccionesModelo.map((t) => t.replace(/\{(umbrales|metas)\.(\w+)\}/g, (_, g, k) => (cfg[g] && cfg[g][k] != null ? cfg[g][k] : '?')))
  );
}

// ---------------- Alertas para la médica (no urgentes) ----------------
const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };
const NIVEL = { alta: 3, media: 2, baja: 1 };

function medidasDe(obs) {
  if (obs.tipo === 'presion') return { pa_sistolica: obs.valor, pa_diastolica: obs.valor2 };
  return { [obs.tipo]: obs.valor };
}

/** Devuelve la alerta más grave que dispara una observación (o null). */
function evaluarAlerta(obs, cfg) {
  const med = medidasDe(obs);
  let mejor = null;
  for (const id of activos(cfg)) {
    for (const a of modulos[id].configuracion.alertas) {
      const v = med[a.variable];
      const lim = a.umbralRef ? cfg.umbrales[a.umbralRef] : a.metaRef ? cfg.metas[a.metaRef] : a.valor;
      if (v == null || lim == null || !CMP[a.operador] || !CMP[a.operador](v, lim)) continue;
      if (!mejor || NIVEL[a.nivel] > NIVEL[mejor.regla.nivel]) mejor = { regla: a, lim, modulo: id };
    }
  }
  if (!mejor) return null;
  const vars = variables();
  const u = (vars[mejor.regla.variable] || {}).unidad || '';
  const valor = obs.tipo === 'presion' ? `${obs.valor}/${obs.valor2}` : obs.valor;
  return { nivel: mejor.regla.nivel, motivo: `${mejor.regla.nombre}: ${valor} ${u} (límite ${mejor.regla.operador} ${mejor.lim})`.replace(/\s+/g, ' '), reglaId: mejor.regla.id, modulo: mejor.modulo };
}

// Resumen para el panel y la API
function catalogo() {
  return [
    ...ids().map((id) => {
      const m = modulos[id];
      return {
        id,
        nombre: m.nombre,
        version: m.version || '0.0.0',
        snomed: m.snomed || [],
        disponible: true,
        fuente: m.fuente,
        fragmentos: m.fragmentos.map((f) => ({ id: f.id, titulo: f.titulo })),
        configuracion: { variables: m.configuracion.variables, metas: m.configuracion.metas, umbrales: m.configuracion.umbrales, alertas: m.configuracion.alertas, alarmas: m.configuracion.alarmas.map((a) => a.id) },
      };
    }),
    ...PROXIMAMENTE.filter((p) => !modulos[p.id]).map((p) => ({ ...p, disponible: false, fragmentos: [], configuracion: null })),
  ];
}

module.exports = { get, ids, activos, sugeridosPorDiagnostico, variables, ensureConfig, defaults, metasTexto, umbralesTexto, instruccionesModelo, evaluarAlerta, catalogo, UMBRALES_GENERALES };
