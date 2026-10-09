// Seudonimización de lo que se escribe en logs/ (auditoría, procedencia y trazas).
//
// Los logs no llevan datos personales de la paciente (nombre, documento, teléfono, fecha de nacimiento, id de
// la HCE): en su lugar va un SEUDÓNIMO estable, `pac-` + HMAC-SHA256(clave, id de la paciente en la HCE).
// - Estable: la misma paciente tiene siempre el mismo seudónimo, así sus registros se relacionan entre sí.
// - Re-identificable sólo desde el sistema: hace falta la clave para calcular el seudónimo de una paciente.
//   La clave sale de HASH_KEY (.env) o, si no está, se genera una vez en DATA_DIR/.clave-seudonimo.
//   Quien sólo tiene los logs no puede volver al nombre.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./state');
const hce = require('./mocks/hce');

let clave = null;
function obtenerClave() {
  if (clave) return clave;
  if (process.env.HASH_KEY) return (clave = process.env.HASH_KEY);
  const archivo = path.join(path.dirname(S.UPLOADS_DIR), '.clave-seudonimo');
  try {
    clave = fs.readFileSync(archivo, 'utf8').trim();
  } catch {}
  if (!clave) {
    clave = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(archivo, clave, { mode: 0o600 });
  }
  return clave;
}

/** Seudónimo estable de una paciente a partir de su id en la HCE. */
function seudonimo(pacienteId = hce.PATIENT_ID) {
  return `pac-${crypto.createHmac('sha256', obtenerClave()).update(String(pacienteId)).digest('hex').slice(0, 16)}`;
}

// Datos que identifican a la paciente, tomados de su registro en la HCE (y de lo importado, si difiere)
function identificadores() {
  const p = hce.everything().entry.map((e) => e.resource).find((r) => r.resourceType === 'Patient');
  const imp = (S.get().hce && S.get().hce.paciente) || {};
  const seud = seudonimo(p.id);
  const nombres = [...(p.name || []).flatMap((n) => [[...(n.given || []), n.family].filter(Boolean).join(' '), ...(n.given || []), n.family]), imp.nombre];
  const lista = [
    ...nombres.filter(Boolean).map((t) => [t, seud]),
    [p.id, seud],
    [imp.id, seud],
    ...(p.identifier || []).map((i) => [i.value, '[documento]']),
    ...(p.telecom || []).map((t) => [t.value, '[contacto]']),
    [imp.telefono, '[contacto]'],
    [p.birthDate, '[fecha de nacimiento]'],
  ].filter(([t]) => t && String(t).trim().length >= 3);
  // primero los más largos ("Marta González" antes que "Marta")
  return { seud, lista: [...new Map(lista.map((x) => [String(x[0]).toLowerCase(), x])).values()].sort((a, b) => String(b[0]).length - String(a[0]).length) };
}

const escapar = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function limpiarTexto(t, ids) {
  let s = t;
  for (const [dato, reemplazo] of ids.lista) s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapar(dato)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), `$1${reemplazo}`);
  return s;
}

/**
 * Copia de `valor` sin datos personales de la paciente: los textos se limpian y un objeto `paciente`
 * (nombre, edad, sexo, teléfono…) se reemplaza por su seudónimo.
 */
function desidentificar(valor, ids = identificadores()) {
  if (typeof valor === 'string') return limpiarTexto(valor, ids);
  if (Array.isArray(valor)) return valor.map((v) => desidentificar(v, ids));
  if (valor && typeof valor === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(valor)) {
      if (k === 'paciente' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = { seudonimo: ids.seud };
      else out[k] = desidentificar(v, ids);
    }
    return out;
  }
  return valor;
}

/** Saca de un texto libre lo que escribió la paciente (lo que va entre comillas) y sus datos personales. */
function sinTextoDePaciente(t, ids = identificadores()) {
  return limpiarTexto(String(t), ids)
    .replace(/"[^"]*"/g, '"[texto]"')
    .replace(/“[^”]*”/g, '“[texto]”');
}

/** Lista de datos personales que nunca deben aparecer en logs/ (para los tests y para verificar). */
function datosPersonales() {
  return identificadores().lista.map(([t]) => String(t));
}

module.exports = { seudonimo, desidentificar, sinTextoDePaciente, datosPersonales };
