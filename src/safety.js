// Filtro de seguridad clínica (capa determinística, se ejecuta ANTES del modelo de lenguaje).
// Señales comunes a cualquier paciente + señales por patología y umbrales configurados por la médica.
const { normalize } = require('./util');

const GENERALES = [
  { re: /dolor (de|en el|en) pecho|duele (el|en el) pecho|dolor toracico|opresion en el pecho|me aprieta el pecho/, motivo: 'Dolor torácico' },
  { re: /falta de aire|no puedo respirar|me ahogo|me falta el aire|dificultad para respirar/, motivo: 'Dificultad respiratoria' },
  { re: /desmay|perdi el conocimiento|perdio el conocimiento|me desvaneci/, motivo: 'Pérdida de conocimiento' },
  { re: /convulsi/, motivo: 'Convulsiones' },
  { re: /no puedo hablar|cara torcida|se me paraliz|no puedo mover (el|la) (brazo|pierna)|debilidad de un lado/, motivo: 'Posible signo neurológico agudo (ACV)' },
  { re: /hinchazon de (labios|lengua|cara)|se me hincho la (lengua|cara|boca)|labios hinchados/, motivo: 'Posible angioedema' },
  { re: /confundid|confusion|no se donde estoy/, motivo: 'Confusión' },
];

const HIPO_SINTOMAS = /temblor|sudor|sudando|mareo|mareada|palpitaciones|hambre|debil/;
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

/**
 * Evalúa un texto del paciente.
 * @returns {{alarma:boolean, motivos:string[], glucemia:number|null, presion:object|null}}
 */
function evaluar(texto, config) {
  const t = normalize(texto);
  const motivos = [];
  for (const g of GENERALES) if (g.re.test(t)) motivos.push(g.motivo);

  const umb = (config && config.umbrales) || {};
  const glucemia = extraerGlucemia(t);
  const presion = extraerPresion(t);
  const modulos = (config && config.modulos) || [];

  if (modulos.includes('dm2')) {
    if (glucemia !== null && glucemia < (umb.hipoGrave ?? 54)) motivos.push(`Hipoglucemia grave (${glucemia} mg/dl)`);
    if (/hipoglucemia grave|no reacciona|no se despierta/.test(t)) motivos.push('Hipoglucemia grave referida');
    if (glucemia !== null && glucemia < (umb.hipo ?? 70) && HIPO_SINTOMAS.test(t) && /confund|no puedo|muy mal/.test(t)) motivos.push('Hipoglucemia sintomática');
    if (glucemia !== null && glucemia > (umb.hiperGrave ?? 300) && /vomit|somnolien|dormida|respir/.test(t)) motivos.push('Hiperglucemia con síntomas de alarma');
  }
  if (modulos.includes('hta') && presion && (presion.sis >= (umb.paSisAlarma ?? 180) || presion.dia >= (umb.paDiaAlarma ?? 110)) && /dolor|cabeza|vision|hablar|pecho/.test(t)) {
    motivos.push(`Presión ${presion.sis}/${presion.dia} con síntomas`);
  }
  return { alarma: motivos.length > 0, motivos: [...new Set(motivos)], glucemia, presion };
}

const MENSAJE_ALARMA = (motivos, esHipo) =>
  [
    '⚠️ Lo que me contás puede ser una urgencia.',
    esHipo
      ? 'Si estás consciente y podés tragar, tomá ahora 15 g de azúcar (3 cucharaditas en agua o medio vaso de jugo común).'
      : null,
    'Llamá ya al 107 (o al número de emergencias de tu zona / obra social) o pedí que te lleven a la guardia más cercana. No te quedes sola.',
    'Ya le avisé a la Dra. Lucía.',
  ]
    .filter(Boolean)
    .join('\n');

module.exports = { evaluar, MENSAJE_ALARMA, extraerGlucemia, extraerPresion };
