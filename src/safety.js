// Filtro de seguridad clínica: PRIMERA CAPA, determinística, se ejecuta ANTES del modelo de lenguaje.
// Las reglas no están en el código: son las alarmas configuradas por la médica (ver src/alarmas.js).
const { normalize } = require('./util');
const A = require('./alarmas');

const GLUC_CONTEXTO = /glucemia|glucosa|azucar|glucometro|me dio|marca|medi|valor/;

function extraerGlucemia(t) {
  if (!GLUC_CONTEXTO.test(t)) return null;
  const m = t.match(/\b(\d{2,3})\b(?!\s*\/)/);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 20 && v <= 600 ? v : null;
}

function extraerPresion(t) {
  const m = t.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (!m) return null;
  return { sis: Number(m[1]), dia: Number(m[2]) };
}

function resultado(disparadas, extra) {
  return {
    alarma: disparadas.length > 0,
    motivos: [...new Set(disparadas.map((d) => d.motivo))],
    reglas: disparadas.map((d) => ({ id: d.id, nombre: d.nombre, detalle: d.detalle })),
    instrucciones: [...new Set(disparadas.map((d) => d.instruccion).filter(Boolean))],
    ...extra,
  };
}

/** Evalúa un mensaje de texto de la paciente contra las alarmas activas. */
function evaluar(texto, cfg) {
  const t = normalize(texto);
  const glucemia = extraerGlucemia(t);
  const presion = extraerPresion(t);
  A.ensure(cfg);
  return resultado(A.evaluarReglas({ t, glucemia, presion }, cfg), { glucemia, presion });
}

/** Evalúa una medición leída de un archivo (foto de glucómetro o tensiómetro) + el texto que la acompaña. */
function evaluarMedicion({ glucemia = null, presion = null }, cfg, texto = '') {
  A.ensure(cfg);
  return resultado(A.evaluarReglas({ t: normalize(texto), glucemia, presion }, cfg), { glucemia, presion });
}

const MENSAJE_ALARMA = (instrucciones = []) =>
  [
    '⚠️ Lo que me contás puede ser una urgencia.',
    ...instrucciones,
    'Llamá ya al 107 (o al número de emergencias de tu zona / obra social) o pedí que te lleven a la guardia más cercana. No te quedes sola.',
    'Ya le avisé a la Dra. Lucía.',
  ].join('\n');

module.exports = { evaluar, evaluarMedicion, MENSAJE_ALARMA, extraerGlucemia, extraerPresion };
