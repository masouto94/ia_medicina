// Alarmas configurables (protocolo de urgencia).
// Cada alarma es una regla de datos, no código:
//   - tipo "texto":  dispara si el mensaje contiene alguna de sus frases.
//   - tipo "umbral": dispara si una medición cruza un valor (opcionalmente, sólo si además hay síntomas).
// Orígenes: "generica" (no se puede eliminar), un módulo de patología ("dm2", "hta"…) o "medica" (creada por la médica).
const fs = require('fs');
const path = require('path');
const { uid, normalize } = require('./util');

const GENERICAS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', 'alarmas_genericas.json'), 'utf8'));

const AZUCAR = 'Si estás consciente y podés tragar, tomá ahora 15 g de azúcar (3 cucharaditas en agua o medio vaso de jugo común).';

// Criterios por patología (provisorio: en el punto 2 pasan a los módulos de knowledge/)
const POR_MODULO = {
  dm2: [
    { id: 'dm2-hipo-grave', nombre: 'Hipoglucemia grave', tipo: 'umbral', variable: 'glucemia', operador: '<', umbralRef: 'hipoGrave', instruccion: AZUCAR },
    { id: 'dm2-hipo-grave-referida', nombre: 'Hipoglucemia grave referida', tipo: 'texto', frases: ['hipoglucemia grave', 'no reacciona', 'no se despierta'], instruccion: AZUCAR },
    { id: 'dm2-hipo-signos', nombre: 'Hipoglucemia con signos de gravedad', tipo: 'umbral', variable: 'glucemia', operador: '<', umbralRef: 'hipo', sintomas: ['muy mal', 'no puedo', 'confund', 'no me puedo levantar'], instruccion: AZUCAR },
    { id: 'dm2-hiper-sintomas', nombre: 'Hiperglucemia con síntomas de alarma', tipo: 'umbral', variable: 'glucemia', operador: '>', umbralRef: 'hiperGrave', sintomas: ['vomit', 'somnolien', 'dormida', 'respir'] },
  ],
  hta: [
    { id: 'hta-pas-sintomas', nombre: 'PA sistólica muy alta con síntomas', tipo: 'umbral', variable: 'pa_sistolica', operador: '>=', umbralRef: 'paSisAlarma', sintomas: ['dolor', 'cabeza', 'vision', 'hablar', 'pecho'] },
    { id: 'hta-pad-sintomas', nombre: 'PA diastólica muy alta con síntomas', tipo: 'umbral', variable: 'pa_diastolica', operador: '>=', umbralRef: 'paDiaAlarma', sintomas: ['dolor', 'cabeza', 'vision', 'hablar', 'pecho'] },
  ],
};

const VARIABLES = {
  glucemia: { label: 'Glucemia', unidad: 'mg/dl' },
  pa_sistolica: { label: 'PA sistólica', unidad: 'mmHg' },
  pa_diastolica: { label: 'PA diastólica', unidad: 'mmHg' },
};
const OPERADORES = ['<', '<=', '>', '>='];
const ORIGENES = { generica: 'Genérica', medica: 'Agregada por la médica', dm2: 'Módulo DM2', hta: 'Módulo HTA' };

function nueva(base, origen) {
  return { ...JSON.parse(JSON.stringify(base)), origen, activa: true };
}

// Completa la lista de alarmas de una configuración (genéricas + módulos activos), sin pisar lo editado
function ensure(cfg) {
  if (!cfg) return cfg;
  cfg.alarmas = Array.isArray(cfg.alarmas) ? cfg.alarmas : [];
  cfg.alarmasEliminadas = Array.isArray(cfg.alarmasEliminadas) ? cfg.alarmasEliminadas : [];
  if (cfg.umbrales && cfg.umbrales.paDiaAlarma == null) cfg.umbrales.paDiaAlarma = 110;
  const ids = new Set(cfg.alarmas.map((a) => a.id));
  for (const g of GENERICAS.alarmas) if (!ids.has(g.id)) cfg.alarmas.push(nueva(g, 'generica'));
  for (const mod of cfg.modulos || []) {
    for (const a of POR_MODULO[mod] || []) {
      if (!ids.has(a.id) && !cfg.alarmasEliminadas.includes(a.id)) cfg.alarmas.push(nueva(a, mod));
    }
  }
  return cfg;
}

// ¿La regla aplica a esta paciente? (activa y, si es de un módulo, ese módulo está activo)
function aplica(a, cfg) {
  return a.activa !== false && (a.origen === 'generica' || a.origen === 'medica' || (cfg.modulos || []).includes(a.origen));
}

function valorUmbral(a, cfg) {
  return a.umbralRef ? (cfg.umbrales || {})[a.umbralRef] : a.valor;
}

function describir(a, cfg) {
  if (a.tipo === 'texto') return `el mensaje menciona: ${a.frases.map((f) => `"${f}"`).join(', ')}`;
  const v = VARIABLES[a.variable] || { label: a.variable, unidad: '' };
  const s = a.sintomas && a.sintomas.length ? ` y además menciona: ${a.sintomas.map((f) => `"${f}"`).join(', ')}` : '';
  return `${v.label} ${a.operador} ${valorUmbral(a, cfg)} ${v.unidad}${s}`;
}

// ---------------- Coincidencia de frases (con negación simple) ----------------
const NEGACION = /(?:^|\s)(no tengo|no tuve|no hay|sin|nada de|tampoco|ni)\s+(\S+\s+){0,2}$/;

function contiene(t, frase) {
  const f = normalize(frase);
  if (!f) return false;
  let i = t.indexOf(f);
  while (i >= 0) {
    const antes = t.slice(Math.max(0, i - 28), i);
    // "no puedo respirar" lleva su propia negación: sólo se descarta si la negación precede a la frase
    if (!NEGACION.test(antes)) return true;
    i = t.indexOf(f, i + 1);
  }
  return false;
}

function coincideAlguna(t, frases) {
  return (frases || []).find((f) => contiene(t, f)) || null;
}

const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };

/**
 * Evalúa las alarmas activas contra un texto normalizado y/o mediciones.
 * @param {{t:string, glucemia?:number|null, presion?:{sis:number,dia:number}|null}} datos
 * @returns {Array<{id, nombre, motivo, instruccion}>}
 */
function evaluarReglas(datos, cfg) {
  const out = [];
  const t = datos.t || '';
  const medidas = {
    glucemia: datos.glucemia ?? null,
    pa_sistolica: datos.presion ? datos.presion.sis : null,
    pa_diastolica: datos.presion ? datos.presion.dia : null,
  };
  for (const a of cfg.alarmas || []) {
    if (!aplica(a, cfg)) continue;
    if (a.tipo === 'texto') {
      const f = coincideAlguna(t, a.frases);
      if (f) out.push({ id: a.id, nombre: a.nombre, motivo: a.nombre, detalle: `frase "${f}"`, instruccion: a.instruccion || null });
    } else if (a.tipo === 'umbral') {
      const v = medidas[a.variable];
      const lim = Number(valorUmbral(a, cfg));
      if (v == null || isNaN(lim) || !CMP[a.operador] || !CMP[a.operador](v, lim)) continue;
      let s = null;
      if (a.sintomas && a.sintomas.length) {
        s = coincideAlguna(t, a.sintomas);
        if (!s) continue;
      }
      const u = VARIABLES[a.variable] ? VARIABLES[a.variable].unidad : '';
      out.push({ id: a.id, nombre: a.nombre, motivo: `${a.nombre} (${v} ${u})`, detalle: `${a.variable} ${v} ${a.operador} ${lim}${s ? ` + "${s}"` : ''}`, instruccion: a.instruccion || null });
    }
  }
  return out;
}

// ---------------- Edición (validación) ----------------
function limpiarFrases(x) {
  const arr = Array.isArray(x) ? x : String(x || '').split(/[,\n;]/);
  return [...new Set(arr.map((f) => normalize(f)).filter((f) => f.length >= 3))];
}

function validar(a) {
  if (!a.nombre || !String(a.nombre).trim()) throw new Error('La alarma necesita un nombre');
  if (a.tipo === 'texto') {
    if (!a.frases || !a.frases.length) throw new Error('Agregá al menos una frase (3 letras o más)');
  } else if (a.tipo === 'umbral') {
    if (!VARIABLES[a.variable]) throw new Error('Variable no válida');
    if (!OPERADORES.includes(a.operador)) throw new Error('Operador no válido');
    if (!a.umbralRef && (a.valor === undefined || a.valor === null || isNaN(Number(a.valor)))) throw new Error('Indicá un valor numérico');
  } else throw new Error('Tipo de alarma no válido');
}

function crear(datos) {
  const a = {
    id: uid('alm'),
    origen: 'medica',
    activa: datos.activa !== false,
    nombre: String(datos.nombre || '').trim(),
    tipo: datos.tipo,
    instruccion: String(datos.instruccion || '').trim() || undefined,
  };
  if (a.tipo === 'texto') a.frases = limpiarFrases(datos.frases);
  else {
    a.variable = datos.variable;
    a.operador = datos.operador;
    a.valor = Number(datos.valor);
    a.sintomas = limpiarFrases(datos.sintomas);
  }
  validar(a);
  return a;
}

// Aplica cambios permitidos. Devuelve {antes, despues}. Las genéricas no cambian de tipo ni de origen.
function modificar(cfg, id, cambios) {
  const a = cfg.alarmas.find((x) => x.id === id);
  if (!a) throw new Error('Alarma no encontrada');
  const antes = JSON.parse(JSON.stringify(a));
  const umbralAntes = a.umbralRef ? cfg.umbrales[a.umbralRef] : undefined;
  if ('activa' in cambios) a.activa = !!cambios.activa;
  if ('nombre' in cambios) a.nombre = String(cambios.nombre || '').trim();
  if ('instruccion' in cambios) a.instruccion = String(cambios.instruccion || '').trim() || undefined;
  if (a.tipo === 'texto' && 'frases' in cambios) a.frases = limpiarFrases(cambios.frases);
  if (a.tipo === 'umbral') {
    if ('operador' in cambios) a.operador = cambios.operador;
    if ('sintomas' in cambios) a.sintomas = limpiarFrases(cambios.sintomas);
    if ('valor' in cambios && cambios.valor !== '' && cambios.valor != null) {
      // si la alarma usa un umbral de la configuración, se edita ese umbral (una sola fuente de verdad)
      if (a.umbralRef) cfg.umbrales[a.umbralRef] = Number(cambios.valor);
      else a.valor = Number(cambios.valor);
    }
  }
  try {
    validar(a);
  } catch (e) {
    Object.assign(a, antes);
    if (a.umbralRef) cfg.umbrales[a.umbralRef] = umbralAntes;
    throw e;
  }
  return { antes: { ...antes, valorEfectivo: umbralAntes ?? antes.valor }, despues: { ...JSON.parse(JSON.stringify(a)), valorEfectivo: valorUmbral(a, cfg) } };
}

function eliminar(cfg, id) {
  const i = cfg.alarmas.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('Alarma no encontrada');
  const a = cfg.alarmas[i];
  if (a.origen === 'generica') throw new Error('Las alarmas genéricas no se pueden eliminar (sí pausar o modificar)');
  cfg.alarmas.splice(i, 1);
  if (a.origen !== 'medica') cfg.alarmasEliminadas.push(a.id); // para que el módulo no la vuelva a agregar
  return a;
}

module.exports = { ensure, aplica, describir, evaluarReglas, crear, modificar, eliminar, valorUmbral, VARIABLES, OPERADORES, ORIGENES, AZUCAR };
