// Utilidades comunes
const crypto = require('crypto');

const TZ = 'America/Argentina/Buenos_Aires';

function uid(prefix = 'id') {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

// Normaliza texto en español: minúsculas, sin tildes, sin signos
function normalize(text = '') {
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s/.,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set(
  'a al algo con de del el en es esta este la las lo los me mi mis no o para pero por que se si sin su sus te tu un una y ya yo hoy como cual cuando donde hay ser estoy tengo puedo debo hago'.split(' ')
);

function tokens(text) {
  return normalize(text)
    .split(/[\s/.,]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    .map(stem);
}

// Stemming muy simple para español (suficiente para la demo)
function stem(t) {
  return t.replace(/(aciones|acion|amente|mente|idades|idad|ando|iendo|ados|idos|adas|idas|ado|ido|ada|ida|es|s)$/, '');
}

function fmtDateTime(ms) {
  return new Date(ms).toLocaleString('es-AR', {
    timeZone: TZ,
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString('es-AR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

// Devuelve el timestamp (ms) de una hora local "HH:MM" en el día local de `refMs` (Argentina, UTC-3 fijo)
function atLocalTime(refMs, hhmm, dayOffset = 0) {
  const [h, m] = hhmm.split(':').map(Number);
  const local = new Date(refMs - 3 * 3600e3); // reloj local "falso" en UTC
  const d = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, h, m);
  return d + 3 * 3600e3;
}

function localDayKey(ms) {
  const local = new Date(ms - 3 * 3600e3);
  return local.toISOString().slice(0, 10);
}

module.exports = { uid, normalize, tokens, fmtDateTime, fmtTime, atLocalTime, localDayKey, TZ };
