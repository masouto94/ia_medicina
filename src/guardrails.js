// Guardrails del modelo para alarmas (SEGUNDA CAPA).
//
// La primera capa es determinística (src/safety.js). El modelo sólo puede proponer una alarma que:
//   1. corresponda a una alarma ACTIVA configurada por la médica (regla_id),
//   2. esté anclada en lo que dijo la paciente (fundamento citado del mensaje o del archivo),
//   3. se apoye sólo en la configuración ("CONFIG") o en fragmentos del RAG que se le pasaron,
//   4. si la alarma es de umbral, traiga un valor que efectivamente cruce el umbral configurado,
//   5. se haya decidido sin consultar fuentes externas (OpenEvidence) en ese mensaje.
// Si alguna condición falla, la propuesta se rechaza: no se activa el protocolo de urgencia, pero la
// consulta se deriva a la médica con prioridad alta (nunca se descarta en silencio).
const ALM = require('./alarmas');
const { tokens, normalize } = require('./util');

const FUENTES_PROHIBIDAS = /openevidence|evidencia externa|conocimiento general|internet|literatura|pubmed|guia externa/i;
const CMP = { '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b };

/**
 * @param {object} p
 * @param {object} p.alarma        propuesta del modelo {es_alarma, regla_id, fundamento, valor, fuentes}
 * @param {string} p.evidencia     texto contra el que se ancla el fundamento (mensaje, o comentario + lectura del archivo)
 * @param {object} p.cfg           configuración de la médica
 * @param {string[]} p.contextoIds ids de los fragmentos que efectivamente se le pasaron al modelo
 * @param {boolean} p.oeConsultado true si en este mensaje ya se consultó OpenEvidence antes de decidir
 * @returns {{aceptada:boolean, motivo:string, regla:object|null, checks:Array<{check:string, ok:boolean, detalle:string}>}}
 */
function validarAlarmaModelo({ alarma, evidencia, cfg, contextoIds = [], oeConsultado = false }) {
  const checks = [];
  const add = (check, ok, detalle) => checks.push({ check, ok, detalle });
  const fin = (motivo, regla = null) => ({ aceptada: checks.every((c) => c.ok), motivo, regla, checks });

  if (!alarma || !alarma.es_alarma) return { aceptada: false, motivo: 'El modelo no propuso alarma', regla: null, checks };

  // 5. sin fuentes externas: la decisión se toma antes de cualquier consulta a OpenEvidence
  add('sin_fuentes_externas_previas', !oeConsultado, oeConsultado ? 'Se consultó OpenEvidence antes de decidir' : 'OpenEvidence no se consultó antes de la decisión');

  // 1. regla configurada y activa
  ALM.ensure(cfg);
  const regla = (cfg.alarmas || []).find((a) => a.id === alarma.regla_id);
  if (!regla) {
    add('regla_configurada', false, `"${alarma.regla_id || '(sin id)'}" no es una alarma configurada por la médica`);
    return fin('La alarma propuesta no corresponde a ninguna alarma configurada');
  }
  const activa = ALM.aplica(regla, cfg);
  add('regla_configurada', true, `${regla.nombre} [${regla.id}]`);
  add('regla_activa', activa, activa ? 'activa' : 'pausada o de un módulo inactivo');

  // 3. fuentes permitidas: sólo la configuración o fragmentos del RAG que se le pasaron
  const fuentes = Array.isArray(alarma.fuentes) ? alarma.fuentes.map(String) : [];
  const permitidas = new Set(['CONFIG', ...contextoIds]);
  const indebidas = fuentes.filter((f) => !permitidas.has(f) || FUENTES_PROHIBIDAS.test(f));
  add('fuentes_permitidas', fuentes.length > 0 && indebidas.length === 0, fuentes.length === 0 ? 'No declaró fuentes' : indebidas.length ? `Fuentes no permitidas: ${indebidas.join(', ')}` : `Fuentes: ${fuentes.join(', ')}`);

  const fTok = [...new Set(tokens(alarma.fundamento || ''))];
  const eTok = new Set(tokens(evidencia || ''));
  // 4. alarmas de umbral: el valor tiene que cruzar el umbral configurado (verificación determinística)
  let umbralOk = false;
  if (regla.tipo === 'umbral') {
    const v = alarma.valor == null || alarma.valor === '' ? NaN : Number(alarma.valor);
    const lim = Number(ALM.valorUmbral(regla, cfg));
    const enMensaje = !isNaN(v) && new RegExp(`(^|[^0-9])${v}([^0-9]|$)`).test(normalize(evidencia || ''));
    const cumple = !isNaN(v) && !isNaN(lim) && !!CMP[regla.operador] && CMP[regla.operador](v, lim);
    umbralOk = cumple && enMensaje;
    add('umbral_verificado', umbralOk, isNaN(v) ? 'No informó el valor medido' : !enMensaje ? `el valor ${v} no aparece en el mensaje` : `${v} ${regla.operador} ${lim}: ${cumple ? 'cumple' : 'no cumple'}`);
  }

  // 2. fundamento anclado en lo que dijo la paciente (no en conocimiento general)
  const cubiertos = fTok.filter((t) => eTok.has(t)).length;
  const textoAnclado = fTok.length > 0 && cubiertos / fTok.length >= 0.6;
  // en umbrales sin síntomas alcanza con el valor medido; si la regla exige síntomas, el fundamento tiene que estar en el texto
  const anclado = textoAnclado || (umbralOk && !(regla.sintomas && regla.sintomas.length));
  add('fundamento_en_mensaje', anclado, anclado && !textoAnclado ? 'Anclado por el valor medido que figura en el mensaje o en la lectura' : fTok.length ? `${cubiertos}/${fTok.length} términos del fundamento están en el mensaje: "${(alarma.fundamento || '').slice(0, 80)}"` : 'Sin fundamento');

  const ok = checks.every((c) => c.ok);
  return fin(ok ? `Alarma del modelo validada: ${regla.nombre}` : `Alarma del modelo rechazada: ${checks.filter((c) => !c.ok).map((c) => c.check).join(', ')}`, regla);
}

module.exports = { validarAlarmaModelo };
