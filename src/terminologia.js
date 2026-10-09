// Terminologías para el export FHIR: SNOMED CT (motivos de derivación, alarmas, medicación) y UCUM (unidades).
// Los códigos viven en knowledge/terminologia.json; acá sólo se arman las estructuras FHIR.
const fs = require('fs');
const path = require('path');
const M = require('./modulos');

const T = JSON.parse(fs.readFileSync(path.join(M.DIR, 'terminologia.json'), 'utf8'));
const SNOMED = T.sistemas.snomed;
const UCUM = T.sistemas.ucum;
const POR_CLAVE = Object.fromEntries(T.motivosDerivacion.map((m) => [m.clave, m]));
const DEFECTO = POR_CLAVE.consulta;

/** Motivo de derivación por clave; si la clave no es válida, "Consultation". */
function motivo(clave) {
  const m = POR_CLAVE[clave] || DEFECTO;
  return { clave: m.clave, code: m.code, display: m.display };
}

function esClaveValida(clave) {
  return !!POR_CLAVE[clave];
}

function snomedCoding(c) {
  return c && c.code ? { system: SNOMED, code: c.code, display: c.display } : null;
}

/** CodeableConcept con SNOMED CT (si hay código) y el texto libre original. */
function concepto(c, texto) {
  const coding = snomedCoding(c);
  return { ...(coding ? { coding: [coding] } : {}), text: texto || (c && c.display) };
}

/** Código UCUM para una unidad escrita como venga (mg/dl, mmHg, %…), o null si no se conoce. */
function ucum(unidad) {
  if (!unidad) return null;
  const u = String(unidad).trim();
  return T.ucum[u] || T.ucum[u.toLowerCase()] || null;
}

/** Quantity FHIR con sistema UCUM cuando la unidad es conocida. */
function cantidad(valor, unidad) {
  const code = ucum(unidad);
  return code ? { value: valor, unit: unidad, system: UCUM, code } : { value: valor, unit: unidad };
}

module.exports = { motivo, esClaveValida, snomedCoding, concepto, ucum, cantidad, MOTIVOS: T.motivosDerivacion, SNOMED, UCUM };
