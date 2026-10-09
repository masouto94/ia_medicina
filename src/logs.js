// Registro de trazabilidad y auditoría en logs/ (separado del estado de la demo, que se borra al reiniciar).
//
// logs/
//   auditoria.jsonl          cambios de configuración (quién, cuándo, antes y después)  ─┐ un registro por línea,
//   procedencia.jsonl        origen de cada respuesta del asistente                      ─┘ encadenados por hash
//   fhir/AuditEvent.ndjson   los mismos registros como recursos FHIR R4 (NDJSON, formato Bulk Data)
//   fhir/Provenance.ndjson
//
// Los archivos sólo se agregan (append-only): "Reiniciar" la demo no los borra. Cada registro lleva la sesión
// de la demo en la que ocurrió. Cada línea de los .jsonl incluye el hash de la anterior (hashPrevio) y el suyo
// (hash = sha256 del registro con hashPrevio): si alguien edita o borra una línea, la verificación lo detecta.
// La carpeta se puede cambiar con LOGS_DIR (los tests usan una temporal).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.LOGS_DIR ? path.resolve(process.env.LOGS_DIR) : path.join(__dirname, '..', 'logs');
const GENESIS = '0'.repeat(64);
const TIPOS = {
  auditoria: { archivo: 'auditoria.jsonl', fhir: 'AuditEvent' },
  procedencia: { archivo: 'procedencia.jsonl', fhir: 'Provenance' },
};
const ultimoHash = {}; // tipo → hash de la última línea (se lee del archivo la primera vez)

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const archivo = (tipo) => path.join(DIR, TIPOS[tipo].archivo);
const archivoFhir = (tipo) => path.join(DIR, 'fhir', `${TIPOS[tipo].fhir}.ndjson`);

function lineas(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch {
    return [];
  }
}

function hashAnterior(tipo) {
  if (!(tipo in ultimoHash)) {
    const ls = lineas(archivo(tipo));
    let h = GENESIS;
    try {
      if (ls.length) h = JSON.parse(ls[ls.length - 1]).hash || GENESIS;
    } catch {}
    ultimoHash[tipo] = h;
  }
  return ultimoHash[tipo];
}

/**
 * Agrega un registro (y su recurso FHIR) al final del log. Devuelve el registro con su hash.
 * @param {'auditoria'|'procedencia'} tipo
 * @param {object} registro  datos del evento (sin hash)
 * @param {(r:object)=>object} aFhir  convierte el registro final en un recurso FHIR
 */
function agregar(tipo, registro, aFhir) {
  if (!TIPOS[tipo]) throw new Error(`Tipo de log desconocido: ${tipo}`);
  fs.mkdirSync(path.join(DIR, 'fhir'), { recursive: true });
  const cuerpo = { ...registro, hashPrevio: hashAnterior(tipo) };
  const final = { ...cuerpo, hash: sha256(JSON.stringify(cuerpo)) };
  fs.appendFileSync(archivo(tipo), `${JSON.stringify(final)}\n`, 'utf8');
  if (aFhir) fs.appendFileSync(archivoFhir(tipo), `${JSON.stringify(aFhir(final))}\n`, 'utf8');
  ultimoHash[tipo] = final.hash;
  return final;
}

/** Lee registros (los más nuevos primero). Filtros: sesion, limite. */
function leer(tipo, { sesion = null, limite = 500 } = {}) {
  const out = [];
  const ls = lineas(archivo(tipo));
  for (let i = ls.length - 1; i >= 0 && out.length < limite; i--) {
    try {
      const r = JSON.parse(ls[i]);
      if (!sesion || r.sesion === sesion) out.push(r);
    } catch {}
  }
  return out;
}

/** Lee los recursos FHIR de un tipo (en orden de registro). */
function leerFhir(tipo, { sesion = null } = {}) {
  const ids = sesion ? new Set(leer(tipo, { sesion, limite: Infinity }).map((r) => r.id)) : null;
  return lineas(archivoFhir(tipo))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((r) => r && (!ids || ids.has(r.id)));
}

/** Recorre la cadena de hashes. Devuelve { ok, registros, error?, linea? }. */
function verificar(tipo) {
  const ls = lineas(archivo(tipo));
  let prev = GENESIS;
  for (let i = 0; i < ls.length; i++) {
    let r;
    try {
      r = JSON.parse(ls[i]);
    } catch {
      return { ok: false, registros: ls.length, linea: i + 1, error: 'línea que no es JSON' };
    }
    const { hash, ...cuerpo } = r;
    if (cuerpo.hashPrevio !== prev) return { ok: false, registros: ls.length, linea: i + 1, error: 'la cadena se corta: falta o se reordenó un registro anterior' };
    if (sha256(JSON.stringify(cuerpo)) !== hash) return { ok: false, registros: ls.length, linea: i + 1, error: 'el contenido no coincide con su hash: el registro fue modificado' };
    prev = hash;
  }
  return { ok: true, registros: ls.length };
}

function archivos() {
  const info = (f) => {
    try {
      const s = fs.statSync(f);
      return { ruta: path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'), bytes: s.size };
    } catch {
      return { ruta: path.relative(path.join(__dirname, '..'), f).replace(/\\/g, '/'), bytes: 0 };
    }
  };
  return Object.fromEntries(Object.keys(TIPOS).flatMap((t) => [[t, info(archivo(t))], [TIPOS[t].fhir, info(archivoFhir(t))]]));
}

/** Ruta de un archivo de logs por nombre público (para descargarlo), o null si no es uno de los permitidos. */
function rutaDescarga(nombre) {
  const mapa = {};
  for (const t of Object.keys(TIPOS)) {
    mapa[TIPOS[t].archivo] = archivo(t);
    mapa[`${TIPOS[t].fhir}.ndjson`] = archivoFhir(t);
  }
  return mapa[nombre] || null;
}

module.exports = { agregar, leer, leerFhir, verificar, archivos, rutaDescarga, sha256, DIR, GENESIS, TIPOS };
