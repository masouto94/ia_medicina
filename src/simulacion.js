// Simulación a demanda con un plan JSON: ejecuta los pasos de la paciente contra el asistente
// y compara lo obtenido con lo esperado. Formato documentado en tests/README.md y en muestras/planes/.
//
// Plan:     { nombre, reiniciar?, configuracion?: { modulos, indicaciones, pausar, agregar }, pasos: [...] }
// Archivo:  un plan, o { planes: [plan, ...] }
// Paso:     { id?, momento?: "+30m" | "+2h" | "+1d", mensaje? | archivo? (+ comentario?), esperado?: {...} }
const fs = require('fs');
const path = require('path');
const S = require('./state');
const A = require('./assistant');
const V = require('./vision');
const CFG = require('./configuracion');
const MOD = require('./modulos');
const llm = require('./llm');
const T = require('./trazabilidad');
const { validarEsperado, obtener, comparar, metricas, parseMomento, CAMPOS_ESPERADO } = require('./evaluacion');


// ---------------- Validación ----------------
/** Normaliza el contenido (un plan o {planes}) y devuelve la lista de planes, o lanza un error que explica qué falta. */
function validarPlanes(contenido) {
  if (!contenido || typeof contenido !== 'object') throw new Error('El plan tiene que ser un objeto JSON');
  const planes = Array.isArray(contenido.planes) ? contenido.planes : [contenido];
  if (!planes.length) throw new Error('No hay planes para ejecutar');
  planes.forEach((p, i) => {
    const donde = `plan ${i + 1}${p && p.nombre ? ` ("${p.nombre}")` : ''}`;
    if (!p || !Array.isArray(p.pasos) || !p.pasos.length) throw new Error(`${donde}: falta la lista "pasos"`);
    p.pasos.forEach((paso, j) => {
      const d = `${donde}, paso ${j + 1}`;
      if (!paso || typeof paso !== 'object') throw new Error(`${d}: el paso tiene que ser un objeto`);
      if (paso.mensaje && paso.archivo) throw new Error(`${d}: usá "mensaje" o "archivo", no los dos (el texto que acompaña a un archivo va en "comentario")`);
      if (!paso.mensaje && !paso.archivo) throw new Error(`${d}: falta "mensaje" o "archivo"`);
      if (paso.archivo && !fs.existsSync(path.join(V.MUESTRAS, path.basename(paso.archivo)))) throw new Error(`${d}: el archivo "${paso.archivo}" no está en muestras/`);
      if (paso.momento) {
        try {
          parseMomento(paso.momento);
        } catch (e) {
          throw new Error(`${d}: ${e.message}`);
        }
      }
      const errores = validarEsperado(paso.esperado || {});
      if (errores.length) throw new Error(`${d}: ${errores.join('; ')}`);
    });
    const c = p.configuracion;
    if (c) {
      if (c.modulos !== undefined) {
        if (!Array.isArray(c.modulos) || !c.modulos.length) throw new Error(`${donde}: "configuracion.modulos" tiene que ser una lista de módulos`);
        const malos = c.modulos.filter((m) => !MOD.ids().includes(m));
        if (malos.length) throw new Error(`${donde}: módulos desconocidos: ${malos.join(', ')} (disponibles: ${MOD.ids().join(', ')})`);
      }
      if (c.indicaciones !== undefined && typeof c.indicaciones !== 'string') throw new Error(`${donde}: "configuracion.indicaciones" tiene que ser un texto`);
      if (c.pausar !== undefined && !(Array.isArray(c.pausar) && c.pausar.every((x) => typeof x === 'string'))) throw new Error(`${donde}: "configuracion.pausar" tiene que ser una lista de ids de alarmas`);
      if (c.agregar !== undefined && !(Array.isArray(c.agregar) && c.agregar.every((x) => x && typeof x === 'object'))) throw new Error(`${donde}: "configuracion.agregar" tiene que ser una lista de alarmas`);
    }
    if (p.configuracion && p.reiniciar === false) throw new Error(`${donde}: "configuracion" sólo se aplica cuando el plan reinicia la demo (sacá "reiniciar": false)`);
    if (p.reiniciar === false && !S.get().assistant && i === 0) throw new Error(`${donde}: "reiniciar": false necesita un asistente ya generado`);
  });
  return planes;
}

// ---------------- Ejecución ----------------
function snapshot() {
  return JSON.parse(JSON.stringify(S.get()));
}

async function prepararAsistente(conf = {}) {
  CFG.reiniciarDemo();
  CFG.importarHCE();
  const cfg = A.defaultConfig(S.get().hce);
  if (conf.modulos) cfg.modulos = conf.modulos;
  if (conf.indicaciones !== undefined) cfg.indicaciones = conf.indicaciones;
  CFG.guardarAsistente(cfg);
  for (const id of conf.pausar || []) CFG.modificarAlarma(id, { activa: false });
  for (const a of conf.agregar || []) CFG.agregarAlarma(a);
}

/** Ejecuta los planes en este proceso. onPaso(resultado, hechos, total) se llama después de cada paso. */
async function ejecutarPlanes(planes, { onPaso = () => {}, cancelado = () => false } = {}) {
  const total = planes.reduce((n, p) => n + p.pasos.length, 0);
  const resultados = [];
  for (const plan of planes) {
    if (cancelado()) break;
    if (plan.reiniciar !== false) {
      try {
        await prepararAsistente(plan.configuracion);
      } catch (e) {
        throw new Error(`${plan.nombre || 'plan sin nombre'}: no se pudo aplicar la configuración: ${e.message}`);
      }
    }
    for (const [i, paso] of plan.pasos.entries()) {
      if (cancelado()) break;
      if (paso.momento) A.avanzar(parseMomento(paso.momento));
      const antes = snapshot();
      if (paso.archivo) await V.enviarMuestra(paso.archivo, paso.comentario || '');
      else await A.handleText(paso.mensaje);
      const obtenido = obtener(antes, snapshot());
      const fallas = comparar(paso.esperado, obtenido);
      const r = {
        plan: plan.nombre || 'plan sin nombre',
        paso: paso.id || `paso ${i + 1}`,
        entrada: paso.mensaje || `[${paso.archivo}] ${paso.comentario || ''}`.trim(),
        esperado: paso.esperado || {},
        obtenido,
        evaluado: Object.keys(paso.esperado || {}).length > 0,
        ok: fallas.length === 0,
        fallas,
      };
      resultados.push(r);
      onPaso(r, resultados.length, total);
    }
  }
  return resultados;
}

// ---------------- Ejecución en segundo plano (para la app) ----------------
let actual = null; // { id, estado, nombre, total, hechos, resultados, metricas, inicio, fin, error, cancelar }

function estado() {
  if (!actual) return null;
  const { cancelar, ...rest } = actual;
  return rest;
}

function iniciar(contenido, nombreArchivo = 'plan') {
  if (actual && actual.estado === 'corriendo') throw new Error('Ya hay una simulación en curso');
  const planes = validarPlanes(contenido);
  const total = planes.reduce((n, p) => n + p.pasos.length, 0);
  actual = { id: `sim-${Date.now()}`, estado: 'corriendo', nombre: nombreArchivo, planes: planes.map((p) => p.nombre || 'plan sin nombre'), total, hechos: 0, resultados: [], metricas: null, motor: llm.status().model || 'simulado (sin IA)', inicio: Date.now(), fin: null, error: null, cancelar: false };
  const job = actual;
  T.auditar({ accion: 'E', evento: 'Simulación con plan iniciada', objeto: { tipo: 'simulacion', id: job.id, nombre: job.nombre }, detalle: `${planes.length} plan(es), ${total} pasos: ${job.planes.join(' · ')}`, versionAntes: null, versionDespues: null });
  // los cambios que hace la simulación quedan a nombre de la simulación (iniciada por quien la lanzó)
  const quien = T.actor();
  const actorSim = { tipo: 'sistema', id: `simulacion:${job.id}`, nombre: `Simulación con plan "${job.nombre}"`, rol: 'sistema', origen: `Simular → plan JSON (iniciada por ${quien.nombre})`, iniciadoPor: quien.id };
  T.conActor(actorSim, () => ejecutarPlanes(planes, {
    onPaso: (r, hechos) => {
      job.resultados.push(r);
      job.hechos = hechos;
      job.metricas = metricas(job.resultados);
    },
    cancelado: () => job.cancelar,
  }))
    .then(() => {
      job.estado = job.cancelar ? 'cancelada' : 'terminada';
    })
    .catch((e) => {
      job.estado = 'error';
      job.error = String(e.message || e);
    })
    .finally(() => {
      job.fin = Date.now();
      job.metricas = metricas(job.resultados);
      S.trace(`Simulación con plan: ${job.nombre}`, [{ paso: 'Simulación', detalle: `${job.hechos}/${job.total} pasos · ${job.metricas.correctos}/${job.metricas.evaluados} correctos · estado: ${job.estado}` }]);
      S.save();
    });
  return estado();
}

function cancelar() {
  if (actual && actual.estado === 'corriendo') actual.cancelar = true;
  return estado();
}

function corriendo() {
  return !!(actual && actual.estado === 'corriendo');
}

module.exports = { validarPlanes, ejecutarPlanes, prepararAsistente, iniciar, cancelar, estado, corriendo, CAMPOS_ESPERADO };
