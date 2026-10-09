// Estado de la simulación (en memoria, persistido en data/state.json)
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// DATA_DIR permite aislar el estado (por ejemplo, en los tests) sin tocar data/
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const FILE = path.join(DATA_DIR, 'state.json');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Inicio de la simulación: lunes 5/10/2026, 10:00 (hora Argentina), durante la consulta
const INICIO = Date.parse('2026-10-05T10:00:00-03:00');

function fresh() {
  return {
    version: 1,
    sesion: `ses-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`, // cada reinicio de la demo es una sesión nueva (los logs la registran)
    clock: INICIO,
    hce: null, // resumen importado desde la HCE
    assistant: null, // configuración generada por la médica
    messages: [],
    observations: [],
    doses: [],
    alerts: [],
    referrals: [],
    suggestions: [],
    appointments: [],
    pendingSlots: null,
    topics: {},
    media: [],
    summaries: [],
    evidenceQueries: [],
    traces: [],
  };
}

let state = load();

function load() {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
  } catch {
    return fresh();
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(FILE, JSON.stringify(state, null, 1));
  }, 200);
}

function get() {
  return state;
}

function reset() {
  state = fresh();
  try {
    for (const f of fs.readdirSync(UPLOADS_DIR)) fs.unlinkSync(path.join(UPLOADS_DIR, f));
  } catch {}
  save();
  return state;
}

// Registro de trazas internas del pipeline (para mostrar "cómo piensa" el sistema)
function trace(evento, pasos) {
  state.traces.unshift({ ts: state.clock, real: Date.now(), evento, pasos });
  state.traces = state.traces.slice(0, 80);
}

module.exports = { get, save, reset, trace, UPLOADS_DIR, INICIO };
