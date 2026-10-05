// MOCK de la agenda institucional de turnos.
const { atLocalTime } = require('../util');

// Devuelve 3 turnos libres con la Dra. Lucía en los próximos días hábiles
function turnosDisponibles(nowMs) {
  const horarios = ['09:00', '11:30', '16:15'];
  const out = [];
  let day = 1;
  while (out.length < 3 && day < 15) {
    const t = atLocalTime(nowMs, horarios[out.length], day);
    const dow = new Date(t - 3 * 3600e3).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push({ id: `slot-${t}`, inicio: t, profesional: 'Dra. Lucía Fernández', lugar: 'CAPS / Consultorio 3' });
    day += out.length === 0 ? 1 : 2;
  }
  return out;
}

module.exports = { turnosDisponibles };
