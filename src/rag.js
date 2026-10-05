// Recuperación (la "R" de RAG) sobre las bases especializadas por patología.
// Para la demo se usa un ranking léxico tipo BM25; en producción sería un índice vectorial.
const fs = require('fs');
const path = require('path');
const { tokens } = require('./util');

const MODULOS_DISPONIBLES = [
  { id: 'dm2', nombre: 'Diabetes tipo 2', disponible: true },
  { id: 'hta', nombre: 'Hipertensión arterial', disponible: true },
  { id: 'ic', nombre: 'Insuficiencia cardíaca', disponible: false },
  { id: 'epoc', nombre: 'EPOC', disponible: false },
  { id: 'aco', nombre: 'Anticoagulación', disponible: false },
];

const bases = {};
for (const m of MODULOS_DISPONIBLES.filter((m) => m.disponible)) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'knowledge', `${m.id}.json`), 'utf8'));
  data.fragmentos.forEach((f) => {
    f.modulo = m.id;
    f._tok = tokens(`${f.titulo} ${f.tema} ${f.palabras} ${f.palabras} ${f.texto}`);
  });
  bases[m.id] = data;
}

function getBase(id) {
  return bases[id];
}

function allChunks(modulos) {
  return modulos.flatMap((id) => (bases[id] ? bases[id].fragmentos : []));
}

// Convierte las indicaciones propias de la médica en fragmentos recuperables (prioritarios)
function planChunks(cfg) {
  const txt = String((cfg && cfg.indicaciones) || '').trim();
  if (!txt) return [];
  return txt
    .split(/(?<=[.;])\s+|\n+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 3)
    .map((t, i) => ({ id: `IND-${i + 1}`, modulo: 'plan', tema: 'indicación de la médica', titulo: 'Indicación de la Dra. Lucía', texto: t, _tok: tokens(`${t} ${t}`), plan: true }));
}

function retrieve(query, modulos, k = 3, extra = []) {
  const chunks = [...extra, ...allChunks(modulos)];
  if (!chunks.length) return [];
  const q = tokens(query);
  if (!q.length) return [];
  const N = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c._tok.length, 0) / N;
  const df = {};
  for (const c of chunks) for (const t of new Set(c._tok)) df[t] = (df[t] || 0) + 1;
  const k1 = 1.2;
  const b = 0.75;
  const scored = chunks.map((c) => {
    let score = 0;
    for (const t of new Set(q)) {
      const tf = c._tok.filter((x) => x === t).length;
      if (!tf) continue;
      const idf = Math.log(1 + (N - df[t] + 0.5) / (df[t] + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c._tok.length) / avgLen)));
    }
    const hits = [...new Set(q)].filter((t) => c._tok.includes(t)).length;
    return { c, score, hits };
  });
  return scored
    .filter((s) => s.score > 0.8)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ c, score, hits }) => ({ id: c.id, modulo: c.modulo, tema: c.tema, titulo: c.titulo, texto: c.texto, plan: !!c.plan, hits, score: +score.toFixed(2) }));
}

function getChunk(id, cfg) {
  if (/^IND-/.test(id)) return planChunks(cfg).find((c) => c.id === id) || null;
  for (const b of Object.values(bases)) {
    const f = b.fragmentos.find((x) => x.id === id);
    if (f) return { id: f.id, modulo: f.modulo, tema: f.tema, titulo: f.titulo, texto: f.texto };
  }
  return null;
}

module.exports = { MODULOS_DISPONIBLES, retrieve, getChunk, getBase, planChunks };
