/* Simulador del asistente – interfaz (panel médico + canal de la paciente) */
'use strict';

const TZ = 'America/Argentina/Buenos_Aires';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (ms, o) => new Date(ms).toLocaleString('es-AR', { timeZone: TZ, hour12: false, ...o });
const fDT = (ms) => fmt(ms, { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const fT = (ms) => fmt(ms, { hour: '2-digit', minute: '2-digit' });
const fD = (ms) => fmt(ms, { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

let S = null; // estado del servidor
let CAT = null; // catálogo (temas, módulos, niveles)
let MUESTRAS = [];
let currentTab = 'config';
let configDraft = null;
const rendered = {};

// ---------------- API ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.form ? undefined : { 'Content-Type': 'application/json' },
    body: opts.form || (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}
async function act(path, body, okMsg) {
  try {
    const r = await api(path, { method: 'POST', body: body || {} });
    if (okMsg) toast(okMsg);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
  }
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 3500);
}

// Reemplaza el HTML de una región sólo si cambió, preservando borradores ([data-draft])
function setHTML(id, html) {
  if (rendered[id] === html) return false;
  const el = document.getElementById(id);
  const drafts = {};
  $$('[data-draft]', el).forEach((i) => (drafts[i.dataset.draft] = i.value));
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.draft : null;
  el.innerHTML = html;
  $$('[data-draft]', el).forEach((i) => {
    if (drafts[i.dataset.draft] != null) i.value = drafts[i.dataset.draft];
    if (focused && i.dataset.draft === focused) i.focus();
  });
  rendered[id] = html;
  return true;
}

// ---------------- Ciclo principal ----------------
async function refresh() {
  try {
    S = await api('/api/state');
    render();
  } catch (e) {
    $('#engine').textContent = 'Servidor no disponible';
    $('#engine').className = 'engine err';
  }
}

function render() {
  renderHeader();
  renderStepper();
  renderConfig();
  renderPanel();
  renderEvidence();
  renderFhir();
  renderTraces();
  renderAlarmas();
  renderChat();
}

function renderHeader() {
  const e = $('#engine');
  if (S.llm.enabled && !S.llm.lastError) {
    e.textContent = `Motor IA: ${S.llm.model}`;
    e.title = S.llm.detail || '';
    e.className = 'engine real';
  } else if (S.llm.enabled) {
    e.textContent = 'Error del LLM → respaldo simulado';
    e.className = 'engine err';
    e.title = S.llm.lastError;
  } else {
    e.textContent = 'Modo simulado (sin IA)';
    e.className = 'engine mock';
    e.title = S.llm.detail || 'Iniciá sesión en Claude Code (comando claude) o configurá ANTHROPIC_API_KEY';
  }
  $('#clock').textContent = S.clockText;
  const has = !!S.assistant;
  $('#btnNext').disabled = !has;
  $('#btnHour').disabled = !has;
  $('#btnSeed').disabled = !has || S.seeded;
  const n = S.metrics ? S.metrics.alertasAbiertas + S.metrics.derivacionesPendientes : 0;
  $('#tabBadge').innerHTML = n ? `<span class="count">${n}</span>` : '';
}

function renderStepper() {
  const hasMsgs = S.messages.some((m) => m.from === 'marta');
  const steps = [
    { n: 1, t: 'Importar datos de la HCE', done: !!S.hce, tab: 'config' },
    { n: 2, t: 'Configurar el asistente', done: !!S.assistant, tab: 'config' },
    { n: 3, t: 'Seguimiento por WhatsApp', done: hasMsgs, tab: null },
    { n: 4, t: 'Panel y resumen preconsulta', done: S.summaries.length > 0, tab: 'panel' },
    { n: 5, t: 'Exportar a la HCE (FHIR)', done: !!window.__exported, tab: 'fhir' },
  ];
  const cur = steps.find((s) => !s.done);
  setHTML('stepper', steps.map((s) => `<div class="step ${s.done ? 'done' : ''} ${s === cur ? 'current' : ''}" data-goto="${s.tab || ''}"><b>${s.done ? '✓' : s.n}</b>${s.t}</div>`).join(''));
}

// ================= 1. Configuración =================
function renderConfig() {
  const sig = JSON.stringify([!!S.hce, S.assistant && S.assistant.actualizado, !!CAT]);
  if (rendered.configSig === sig) return;
  rendered.configSig = sig;
  const el = $('#tab-config');
  if (!S.hce) {
    el.innerHTML = `
      <div class="stack">
        <div class="callout">Durante la consulta, la Dra. Lucía abre el panel e importa desde la historia clínica electrónica los datos básicos de Marta: diagnósticos, medicación vigente y últimos resultados.</div>
        <div class="section">
          <h3>Importar desde la HCE <span class="hint">integración HL7 FHIR (mock)</span></h3>
          <p class="mono small muted">GET https://hce.institucion.ar/fhir/Patient/marta-001/$everything</p>
          <button class="btn primary" id="btnImport">Importar datos de Marta</button>
        </div>
      </div>`;
    return;
  }
  if (!CAT) return;
  const h = S.hce;
  const cfg = S.assistant ? S.assistant.config : null;
  el.innerHTML = `
    <div class="stack">
      <div class="grid2">
        <div class="section">
          <h3>Datos importados <span class="pill">HCE · FHIR</span></h3>
          <dl class="kv">
            <dt>Paciente</dt><dd>${esc(h.paciente.nombre)} · ${h.paciente.edad} años</dd>
            <dt>Diagnósticos</dt><dd>${h.diagnosticos.map((d) => `${esc(d.texto)} <span class="muted small">SNOMED ${d.codigo}</span>`).join('<br>')}</dd>
            <dt>Medicación</dt><dd>${h.medicacion.map((m) => `${esc(m.nombre)} – <span class="muted">${esc(m.indicacion)}</span>`).join('<br>')}</dd>
            <dt>Presión</dt><dd>${h.presion.sistolica}/${h.presion.diastolica} mmHg <span class="muted small">(${h.presion.fecha})</span></dd>
          </dl>
        </div>
        <div class="section">
          <h3>Último laboratorio</h3>
          <table class="t"><tr><th>Determinación</th><th>Valor</th><th>Fecha</th></tr>
          ${h.laboratorio.map((l) => `<tr><td>${esc(l.nombre)}</td><td class="num">${l.valor} ${esc(l.unidad)}</td><td>${l.fecha}</td></tr>`).join('')}</table>
        </div>
      </div>
      ${cfg ? `<div class="callout">Asistente activo: <b class="mono">${esc(cfg.id)}</b> · creado ${fDT(S.assistant.creado)}. Podés modificar la configuración y guardarla: los cambios se aplican en el próximo mensaje (no hay reentrenamiento).</div>` : ''}
      <div id="cfgForm"></div>
      <div id="alarmasBox"></div>
    </div>`;
  delete rendered.alarmasBox;
  if (!configDraft || !S.assistant || configDraft._from !== S.assistant.actualizado) {
    loadDraft(cfg);
  } else {
    renderForm();
  }
}

async function loadDraft(cfg) {
  if (cfg) configDraft = JSON.parse(JSON.stringify(cfg));
  else configDraft = await api('/api/assistant/default');
  configDraft._from = S.assistant ? S.assistant.actualizado : null;
  renderForm();
}

function renderForm() {
  const c = configDraft;
  const box = $('#cfgForm');
  if (!box) return;
  const num = (path, label, step = 1) => {
    const [g, k] = path.split('.');
    return `<label class="field">${label}<input type="number" step="${step}" data-cfg="${path}" value="${c[g][k]}"></label>`;
  };
  box.innerHTML = `
    <div class="stack">
      <div class="section">
        <h3>Medicación y horarios de toma <span class="hint">el módulo de recordatorios avisa en cada horario</span></h3>
        ${c.medicacion.map((m, i) => `
          <div class="medrow">
            <label class="field">Medicamento<input data-med="${i}" data-k="nombre" value="${esc(m.nombre)}"></label>
            <label class="field">Horarios (HH:MM, separados por coma)<input data-med="${i}" data-k="horarios" value="${esc(m.horarios.join(', '))}"></label>
          </div>`).join('')}
      </div>
      <div class="grid2">
        <div class="section">
          <h3>Metas terapéuticas</h3>
          <div class="inline-fields">
            ${num('metas.ayunasMin', 'Ayunas mín (mg/dl)')}${num('metas.ayunasMax', 'Ayunas máx (mg/dl)')}
            ${num('metas.posprandialMax', 'Posprandial máx')}${num('metas.hba1c', 'HbA1c < (%)', 0.1)}
            ${num('metas.paSis', 'PA sistólica <')}${num('metas.paDia', 'PA diastólica <')}
          </div>
        </div>
        <div class="section">
          <h3>Umbrales de alerta</h3>
          <div class="inline-fields">
            ${num('umbrales.hipo', 'Hipoglucemia <')}${num('umbrales.hipoGrave', 'Hipo grave (alarma) <')}
            ${num('umbrales.hiper', 'Glucemia alta >')}${num('umbrales.hiperGrave', 'Glucemia marcada >')}
            ${num('umbrales.paSis', 'PA sist. alerta ≥')}${num('umbrales.paDia', 'PA diast. alerta ≥')}
            ${num('umbrales.paSisAlarma', 'PA sist. alarma ≥')}${num('umbrales.paDiaAlarma', 'PA diast. alarma ≥')}
            ${num('umbrales.omisionesConsecutivas', 'Omisiones seguidas')}
          </div>
        </div>
      </div>
      <div class="grid2">
        <div class="section">
          <h3>Bases especializadas (módulos por patología)</h3>
          <div class="checks" style="grid-template-columns:1fr">
            ${CAT.modulos.map((m) => `<label class="check ${m.disponible ? '' : 'disabled'}"><input type="checkbox" data-mod="${m.id}" ${c.modulos.includes(m.id) ? 'checked' : ''} ${m.disponible ? '' : 'disabled'}> <span>${esc(m.nombre)}${m.disponible ? ` <span class="muted small">· ${m.fragmentos.length} fragmentos</span>` : ' <span class="muted small">(próximamente)</span>'}</span></label>`).join('')}
          </div>
          <p class="small muted" style="margin:8px 0 0">Contenido educativo basado en guías nacionales y validado por el equipo de salud. Combinables en multimorbilidad.</p>
        </div>
        <div class="section">
          <h3>Temas que el asistente puede abordar</h3>
          <div class="checks" style="grid-template-columns:1fr">
            ${CAT.temas.map((t) => `<label class="check"><input type="checkbox" data-tema="${t.id}" ${c.temas.includes(t.id) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('')}
          </div>
          <p class="small muted" style="margin:8px 0 0">Lo que quede fuera se deriva a la médica.</p>
        </div>
      </div>
      <div class="grid2">
        <div class="section">
          <h3>Comunicación</h3>
          <div class="inline-fields" style="grid-template-columns:1fr 1fr">
            <label class="field">Nivel de lenguaje<select data-cfg="nivelLenguaje">${Object.keys(CAT.niveles).map((k) => `<option value="${k}" ${c.nivelLenguaje === k ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
            <label class="field">Canal<select data-cfg="canal"><option value="whatsapp" ${c.canal === 'whatsapp' ? 'selected' : ''}>WhatsApp</option><option value="app" ${c.canal === 'app' ? 'selected' : ''}>App propia</option></select></label>
          </div>
        </div>
        <div class="section">
          <h3>Indicaciones propias de la médica</h3>
          <label class="field"><textarea data-cfg="indicaciones">${esc(c.indicaciones)}</textarea></label>
        </div>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn primary" id="btnCreate">${S.assistant ? 'Guardar cambios' : 'Generar asistente “lucia-marta-assistant”'}</button>
        <details style="flex:1"><summary class="small muted" style="cursor:pointer">Ver configuración (JSON que parametriza al modelo)</summary><pre class="json" id="cfgJson"></pre></details>
      </div>
    </div>`;
  updateCfgJson();
}

function readForm() {
  const c = configDraft;
  $$('[data-cfg]').forEach((i) => {
    const p = i.dataset.cfg.split('.');
    if (p.length === 2) c[p[0]][p[1]] = Number(i.value);
    else c[p[0]] = i.value;
  });
  $$('[data-med]').forEach((i) => {
    const m = c.medicacion[Number(i.dataset.med)];
    if (i.dataset.k === 'nombre') m.nombre = i.value;
    else m.horarios = i.value.split(',').map((x) => x.trim()).filter((x) => /^\d{1,2}:\d{2}$/.test(x)).map((x) => x.padStart(5, '0'));
  });
  c.modulos = $$('[data-mod]').filter((i) => i.checked).map((i) => i.dataset.mod);
  c.temas = $$('[data-tema]').filter((i) => i.checked).map((i) => i.dataset.tema);
  updateCfgJson();
}
function updateCfgJson() {
  const pre = $('#cfgJson');
  if (pre) {
    const { _from, ...clean } = configDraft;
    pre.textContent = JSON.stringify(clean, null, 2);
  }
}

// ================= Alarmas (protocolo de urgencia) =================
let alarmEdit = null; // {id, tipo} | null
const ORIG_PILL = { generica: 'Genérica', medica: 'Médica', dm2: 'DM2', hta: 'HTA' };

function alarmCfg() {
  return S.assistant ? S.assistant.config : configDraft;
}
function valorAlarma(a, c) {
  return a.umbralRef ? c.umbrales[a.umbralRef] : a.valor;
}
function describirAlarma(a, c) {
  if (a.tipo === 'texto') return `Menciona: ${a.frases.map((f) => `“${esc(f)}”`).join(', ')}`;
  const v = (CAT.alarmas.variables[a.variable] || {}).label || a.variable;
  const u = (CAT.alarmas.variables[a.variable] || {}).unidad || '';
  const sint = a.sintomas && a.sintomas.length ? ` <span class="muted">+ síntomas: ${a.sintomas.map((f) => `“${esc(f)}”`).join(', ')}</span>` : '';
  return `<b>${esc(v)} ${esc(a.operador)} ${esc(valorAlarma(a, c))}</b> ${u}${a.umbralRef ? ` <span class="muted small">(umbral “${a.umbralRef}”)</span>` : ''}${sint}`;
}

function alarmEditor(a, c) {
  const id = a ? a.id : 'nuevo';
  const tipo = a ? a.tipo : alarmEdit.tipo;
  const k = (f) => `alm-${id}-${f}`;
  const V = CAT.alarmas.variables;
  return `<div class="section" style="background:var(--surface-2);margin-top:8px">
    <h3>${a ? `Modificar: ${esc(a.nombre)}` : 'Nueva alarma'} ${a && a.origen === 'generica' ? '<span class="hint">genérica: se puede pausar y modificar, no eliminar</span>' : ''}</h3>
    <div class="inline-fields" style="grid-template-columns:2fr 1fr">
      <label class="field">Nombre<input data-draft="${k('nombre')}" value="${esc(a ? a.nombre : '')}" placeholder="Ej.: Fiebre alta con escalofríos"></label>
      <label class="field">Tipo<select data-draft="${k('tipo')}" ${a ? 'disabled' : 'data-alm-tipo'}>
        <option value="texto" ${tipo === 'texto' ? 'selected' : ''}>Frases en el mensaje</option>
        <option value="umbral" ${tipo === 'umbral' ? 'selected' : ''}>Umbral de una medición</option></select></label>
    </div>
    ${tipo === 'texto'
      ? `<label class="field" style="margin-top:8px">Frases que la disparan (separadas por coma; sin tildes; puede ser el comienzo de una palabra)<textarea data-draft="${k('frases')}">${esc(a ? a.frases.join(', ') : '')}</textarea></label>`
      : `<div class="inline-fields" style="margin-top:8px;grid-template-columns:1.3fr .7fr 1fr">
          <label class="field">Medición<select data-draft="${k('variable')}" ${a ? 'disabled' : ''}>${Object.keys(V).map((v) => `<option value="${v}" ${a && a.variable === v ? 'selected' : ''}>${V[v].label} (${V[v].unidad})</option>`).join('')}</select></label>
          <label class="field">Operador<select data-draft="${k('operador')}">${CAT.alarmas.operadores.map((o) => `<option ${(a ? a.operador : '<') === o ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
          <label class="field">Valor${a && a.umbralRef ? ` (umbral “${a.umbralRef}”)` : ''}<input type="number" data-draft="${k('valor')}" value="${a ? esc(valorAlarma(a, c)) : ''}"></label>
        </div>
        <label class="field" style="margin-top:8px">Sólo si además menciona alguno de estos síntomas (opcional, separados por coma)<textarea data-draft="${k('sintomas')}">${esc(a && a.sintomas ? a.sintomas.join(', ') : '')}</textarea></label>`}
    <label class="field" style="margin-top:8px">Indicación inmediata para la paciente (opcional; se suma al mensaje de urgencia)<textarea data-draft="${k('instruccion')}" style="min-height:44px">${esc(a && a.instruccion ? a.instruccion : '')}</textarea></label>
    <div style="display:flex;gap:8px;margin-top:10px"><button class="btn primary" id="almSave" data-id="${id}">Guardar alarma</button><button class="btn" id="almCancel">Cancelar</button></div>
  </div>`;
}

function renderAlarmas() {
  const box = document.getElementById('alarmasBox');
  if (!box || !CAT) return;
  const c = alarmCfg();
  if (!c || !c.alarmas) return setHTML('alarmasBox', '');
  const editable = !!S.assistant;
  const mods = c.modulos || [];
  const rows = c.alarmas
    .map((a) => {
      const modInactivo = !['generica', 'medica'].includes(a.origen) && !mods.includes(a.origen);
      const on = a.activa !== false;
      return `<tr style="${!on || modInactivo ? 'opacity:.55' : ''}">
        <td><label class="check"><input type="checkbox" data-alm-toggle="${a.id}" ${on ? 'checked' : ''} ${editable ? '' : 'disabled'}> ${on ? 'Activa' : 'Pausada'}</label></td>
        <td><b>${esc(a.nombre)}</b><br><span class="pill">${ORIG_PILL[a.origen] || esc(a.origen)}</span>${modInactivo ? ' <span class="small muted">módulo inactivo</span>' : ''}</td>
        <td class="small">${describirAlarma(a, c)}${a.instruccion ? `<div class="muted" style="margin-top:2px">↳ ${esc(a.instruccion)}</div>` : ''}</td>
        <td style="white-space:nowrap">${editable ? `<button class="btn sm" data-alm-edit="${a.id}">Modificar</button> ${a.origen === 'generica' ? '<button class="btn sm" disabled title="Las genéricas no se pueden eliminar">Eliminar</button>' : `<button class="btn sm danger" data-alm-del="${a.id}">Eliminar</button>`}` : ''}</td>
      </tr>${alarmEdit && alarmEdit.id === a.id ? `<tr><td colspan="4">${alarmEditor(a, c)}</td></tr>` : ''}`;
    })
    .join('');
  const activas = c.alarmas.filter((a) => a.activa !== false && (['generica', 'medica'].includes(a.origen) || mods.includes(a.origen))).length;
  setHTML(
    'alarmasBox',
    `<div class="section" style="margin-top:14px">
      <h3>Alarmas (protocolo de urgencia) <span class="hint">${activas} activas de ${c.alarmas.length} · primera capa determinística, se evalúa antes del modelo</span></h3>
      ${editable ? '<div class="small muted" style="margin-bottom:8px">Los cambios se aplican al instante. Si una alarma se dispara, el asistente no intenta resolver: indica emergencias y avisa a la médica.</div>' : '<div class="callout warn" style="margin-bottom:8px">Estas son las alarmas predeterminadas (genéricas + módulos activos). Generá el asistente para pausarlas, modificarlas o agregar nuevas.</div>'}
      <table class="t"><tr><th style="width:96px">Estado</th><th>Alarma</th><th>Criterio</th><th></th></tr>${rows}</table>
      ${editable ? (alarmEdit && alarmEdit.id === 'nuevo' ? alarmEditor(null, c) : '<button class="btn" id="almAdd" style="margin-top:10px">＋ Agregar alarma</button>') : ''}
    </div>`
  );
}

async function alarmOp(method, path, body, okMsg) {
  try {
    const r = await api(path, { method, body: body || {} });
    const prev = S.assistant.config.umbrales;
    if (configDraft) {
      configDraft.alarmas = r.alarmas;
      for (const key of Object.keys(r.umbrales)) if (r.umbrales[key] !== prev[key]) configDraft.umbrales[key] = r.umbrales[key];
      configDraft._from = r.actualizado;
    }
    alarmEdit = null;
    if (okMsg) toast(okMsg);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

function alarmFormData(id, tipo) {
  const g = (f) => {
    const el = document.querySelector(`[data-draft="alm-${id}-${f}"]`);
    return el ? el.value : undefined;
  };
  const d = { nombre: g('nombre'), instruccion: g('instruccion') };
  if (tipo === 'texto') d.frases = g('frases');
  else Object.assign(d, { variable: g('variable'), operador: g('operador'), valor: g('valor'), sintomas: g('sintomas') });
  if (id === 'nuevo') d.tipo = tipo;
  return d;
}

// ================= 2. Panel =================
function renderPanel() {
  if (!S.assistant) {
    setHTML('tab-panel', `<div class="empty">El panel se activa cuando la médica genera el asistente.</div>`);
    return;
  }
  const m = S.metrics;
  const cfg = S.assistant.config;
  const st = (v, good, warn) => (v == null ? '' : v >= good ? `<span class="status" style="color:#0a7a0a">● En meta</span>` : v >= warn ? `<span class="status" style="color:#9a6a00">▲ Revisar</span>` : `<span class="status" style="color:var(--critical)">▼ Bajo</span>`);
  const kpis = `
    <div class="kpis">
      <div class="kpi"><div class="label">Proporción de días cubiertos</div><div class="value">${m.pdc ?? '—'}${m.pdc != null ? '%' : ''}</div><div class="sub">${m.diasCubiertos}/${m.diasEvaluados} días · 14 d</div>${st(m.pdc, 80, 60)}</div>
      <div class="kpi"><div class="label">Tomas confirmadas</div><div class="value">${m.adherenciaTomas ?? '—'}${m.adherenciaTomas != null ? '%' : ''}</div><div class="sub">${m.tomasEvaluadas} tomas evaluadas</div></div>
      <div class="kpi"><div class="label">Glucemia en ayunas (prom.)</div><div class="value">${m.glucemiaAyunasPromedio ?? '—'}</div><div class="sub">mg/dl · meta ${cfg.metas.ayunasMin}–${cfg.metas.ayunasMax}</div></div>
      <div class="kpi"><div class="label">Glucemias en meta</div><div class="value">${m.tiempoEnMeta ?? '—'}${m.tiempoEnMeta != null ? '%' : ''}</div><div class="sub">${m.glucemiasRegistradas} registros</div>${st(m.tiempoEnMeta, 70, 50)}</div>
      <div class="kpi"><div class="label">Alertas abiertas</div><div class="value" style="color:${m.alertasAbiertas ? 'var(--critical)' : 'inherit'}">${m.alertasAbiertas}</div><div class="sub">${S.alerts.filter((a) => !a.ack && a.nivel === 'alta').length} de prioridad alta</div></div>
      <div class="kpi"><div class="label">Derivaciones pendientes</div><div class="value">${m.derivacionesPendientes}</div><div class="sub">${m.sugerenciasPendientes} sugerencia(s) de evidencia</div></div>
    </div>`;

  const alerts = S.alerts.slice().reverse();
  const alertsHtml = alerts.length
    ? alerts.slice(0, 8).map((a) => `<div class="item ${a.ack ? 'ack' : ''}"><span class="sev ${a.nivel}">${a.nivel === 'alta' ? '⚠ ALTA' : a.nivel === 'media' ? '▲ MEDIA' : '• BAJA'}</span><div class="body">${esc(a.motivo)}<div class="meta">${fDT(a.ts)}</div></div>${a.ack ? '<span class="small muted">vista</span>' : `<button class="btn sm" data-ack="${a.id}">Marcar vista</button>`}</div>`).join('')
    : '<div class="empty">Sin alertas</div>';

  const refs = S.referrals.slice().reverse();
  const quick = ['Gracias por avisar, Marta. Lo vemos en la consulta.', 'Pedí un turno para esta semana, por favor.', 'Seguí con el tratamiento actual sin cambios.'];
  const refsHtml = refs.length
    ? refs.slice(0, 10).map((r) => `
      <div class="item">
        ${r.mediaUrl ? `<a href="${r.mediaUrl}" target="_blank"><img class="thumb" src="${r.mediaUrl}" alt="adjunto"></a>` : ''}
        <div class="body">
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="sev ${r.prioridad}">${r.prioridad.toUpperCase()}</span><b>${esc(r.motivo)}</b></div>
          <div style="margin-top:4px">${esc(r.resumen)}</div>
          <div class="meta">${fDT(r.ts)} · ${r.estado === 'pendiente' ? 'pendiente' : `respondida: “${esc(r.respuesta)}”`}</div>
          ${r.estado === 'pendiente' ? `<div class="reply"><input data-draft="rep-${r.id}" placeholder="Responder a Marta…" list="quick-${r.id}"><datalist id="quick-${r.id}">${quick.map((q) => `<option value="${esc(q)}">`).join('')}</datalist><button class="btn sm primary" data-reply="${r.id}">Enviar</button></div>` : ''}
        </div>
      </div>`).join('')
    : '<div class="empty">Sin derivaciones</div>';

  const sugs = S.suggestions.slice().reverse();
  const sugHtml = sugs.length
    ? sugs.map((s) => `
      <div class="item ${s.estado !== 'pendiente' ? 'ack' : ''}">
        <div class="body">
          <b>${esc(s.tema)}</b> <span class="pill">${esc(s.origen)}</span>
          <div class="meta">Disparada por: “${esc(s.pregunta)}” · ${fDT(s.ts)}</div>
          <div style="margin-top:4px">${esc(s.texto)}</div>
          <ol class="cites">${s.citas.map((c) => `<li>${esc(c.ref)} ${c.url ? `<a href="${c.url}" target="_blank">↗</a>` : ''}</li>`).join('')}</ol>
          ${s.estado === 'pendiente' ? `<div class="reply"><button class="btn sm" data-sug="${s.id}" data-est="aceptada">Evaluar en consulta</button><button class="btn sm" data-sug="${s.id}" data-est="descartada">Descartar</button></div>` : `<div class="meta">Estado: ${s.estado}</div>`}
          <div class="small muted" style="margin-top:6px">La paciente no recibe esta sugerencia: sólo la médica decide cambios de tratamiento.</div>
        </div>
      </div>`).join('')
    : '<div class="empty">Sin sugerencias</div>';

  const topics = Object.entries(S.topics).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxT = topics.length ? topics[0][1] : 1;
  const topicsHtml = topics.length ? `<div class="bars">${topics.map(([k, v]) => `<div class="row"><span title="${esc(k)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k)}</span><div class="bar" style="width:${Math.max(4, (100 * v) / maxT)}%"></div><span class="num">${v}</span></div>`).join('')}</div>` : '<div class="empty">Sin consultas aún</div>';

  const pa = S.observations.filter((o) => o.tipo === 'presion').slice(-6).reverse();
  const labs = S.observations.filter((o) => !['glucemia', 'presion', 'peso'].includes(o.tipo)).slice(-10).reverse();
  const apts = S.appointments.slice().reverse();
  const sum = S.summaries[0];

  setHTML('tab-panel', `
    <div class="stack">
      ${kpis}
      <div class="section">
        <h3>Glucemias registradas <span class="hint">banda = meta en ayunas · líneas = umbrales de alerta</span></h3>
        ${glucoseChart(cfg)}
      </div>
      <div class="section">
        <h3>Adherencia por toma <span class="hint">últimos 14 días</span></h3>
        ${adherenceGrid(cfg)}
      </div>
      <div class="grid2">
        <div class="section"><h3>Alertas</h3>${alertsHtml}</div>
        <div class="section"><h3>Derivaciones de la paciente</h3>${refsHtml}</div>
      </div>
      <div class="grid2">
        <div class="section"><h3>Sugerencias basadas en evidencia</h3>${sugHtml}</div>
        <div class="section"><h3>Temas más consultados</h3>${topicsHtml}</div>
      </div>
      <div class="grid3">
        <div class="section"><h3>Presión arterial</h3>${pa.length ? `<table class="t"><tr><th>Fecha</th><th>mmHg</th><th>Fuente</th></tr>${pa.map((o) => `<tr><td>${fDT(o.ts)}</td><td class="num">${o.valor}/${o.valor2}</td><td class="small muted">${esc(o.fuente || '')}</td></tr>`).join('')}</table>` : '<div class="empty">Sin registros</div>'}</div>
        <div class="section"><h3>Laboratorio recibido</h3>${labs.length ? `<table class="t"><tr><th>Analito</th><th>Valor</th><th>Fecha</th></tr>${labs.map((o) => `<tr><td>${esc(o.nombre || o.tipo)}</td><td class="num">${o.valor} ${esc(o.unidad)}</td><td class="small">${fmt(o.ts, { day: '2-digit', month: '2-digit' })}</td></tr>`).join('')}</table>` : '<div class="empty">Sin informes nuevos</div>'}</div>
        <div class="section"><h3>Turnos</h3>${apts.length ? apts.map((a) => `<div class="item"><div class="body"><b>${fDT(a.inicio)}</b><div class="meta">${esc(a.lugar)} · reservado por el asistente</div></div></div>`).join('') : '<div class="empty">Sin turnos</div>'}</div>
      </div>
      <div class="section">
        <h3>Resumen preconsulta <span class="hint">reporte focalizado (CDS) · se exporta como Composition</span></h3>
        <button class="btn primary" id="btnSummary">Generar resumen del período</button>
        ${sum ? `<div class="summary" style="margin-top:10px">${esc(sum.texto)}</div><div class="small muted" style="margin-top:4px">Generado ${fDT(sum.ts)} · ${esc(sum.motor)}</div>` : ''}
      </div>
    </div>`);
  wireChart();
}

function glucoseChart(cfg) {
  const desde = S.clock - 14 * 86400e3;
  const pts = S.observations.filter((o) => o.tipo === 'glucemia' && o.ts > desde).sort((a, b) => a.ts - b.ts);
  if (!pts.length) return '<div class="empty">Todavía no hay glucemias registradas. Marta puede enviarlas por mensaje o con una foto del glucómetro.</div>';
  const W = 760, H = 240, L = 40, R = 12, T = 12, B = 26;
  const yMin = 40, yMax = Math.max(300, ...pts.map((p) => p.valor + 10));
  const x0 = desde, x1 = S.clock;
  const X = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
  const Y = (v) => T + (1 - (Math.min(v, yMax) - yMin) / (yMax - yMin)) * (H - T - B);
  const u = cfg.umbrales, mt = cfg.metas;
  let g = '';
  for (const v of [50, 100, 150, 200, 250, 300].filter((v) => v <= yMax)) g += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e8ebef"/><text x="${L - 6}" y="${Y(v) + 4}" font-size="10" text-anchor="end" fill="#7a8391">${v}</text>`;
  for (let d = 0; d <= 14; d += 2) {
    const t = x1 - (14 - d) * 86400e3;
    g += `<text x="${X(t)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#7a8391">${fmt(t, { day: '2-digit', month: '2-digit' })}</text>`;
  }
  const band = `<rect x="${L}" width="${W - L - R}" y="${Y(mt.ayunasMax)}" height="${Y(mt.ayunasMin) - Y(mt.ayunasMax)}" fill="#0ca30c" opacity="0.09"/>`;
  const thr = [[u.hipo, `hipo < ${u.hipo}`], [u.hiper, `alta > ${u.hiper}`]].map(([v, l]) => `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d03b3b" stroke-dasharray="4 4" stroke-width="1"/><text x="${W - R - 2}" y="${Y(v) - 4}" font-size="10" text-anchor="end" fill="#a12626">${l}</text>`).join('');
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.ts).toFixed(1)},${Y(p.valor).toFixed(1)}`).join(' ');
  const color = (v) => (v < u.hipo ? '#d03b3b' : v > u.hiper ? '#ec835a' : '#2a78d6');
  const dots = pts.map((p) => `<circle cx="${X(p.ts)}" cy="${Y(p.valor)}" r="${p.momento === 'ayunas' ? 4.5 : 4}" fill="${p.momento === 'ayunas' ? color(p.valor) : '#fff'}" stroke="${color(p.valor)}" stroke-width="2"/><circle class="hit" cx="${X(p.ts)}" cy="${Y(p.valor)}" r="10" fill="transparent" data-tip="${esc(`${p.valor} mg/dl · ${p.momento || 'sin momento'} · ${fDT(p.ts)} · ${p.fuente || ''}`)}"/>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Glucemias de los últimos 14 días">${g}${band}${thr}<path d="${path}" fill="none" stroke="#2a78d6" stroke-width="2" opacity="0.55"/>${dots}</svg><div class="tip"></div></div>
  <div class="legend"><span><i style="background:#2a78d6;border-radius:50%"></i>En ayunas</span><span><i style="background:#fff;border:2px solid #2a78d6;border-radius:50%"></i>Otro momento / posprandial</span><span><i style="background:rgba(12,163,12,.18)"></i>Meta en ayunas ${mt.ayunasMin}–${mt.ayunasMax}</span><span><i style="background:#d03b3b"></i>Debajo de umbral</span><span><i style="background:#ec835a"></i>Encima de umbral</span></div>`;
}

function wireChart() {
  const ch = $('#tab-panel .chart');
  if (!ch) return;
  const tip = $('.tip', ch);
  $$('.hit', ch).forEach((c) => {
    c.addEventListener('mouseenter', () => {
      const r = ch.getBoundingClientRect();
      const b = c.getBoundingClientRect();
      tip.textContent = c.dataset.tip;
      tip.style.left = `${b.left - r.left + b.width / 2}px`;
      tip.style.top = `${b.top - r.top}px`;
      tip.style.display = 'block';
    });
    c.addEventListener('mouseleave', () => (tip.style.display = 'none'));
  });
}

function adherenceGrid(cfg) {
  const slots = [];
  for (const m of cfg.medicacion) for (const h of m.horarios) slots.push({ medId: m.id, label: `${m.nombre.split(' ')[0]} ${h}`, hora: h });
  slots.sort((a, b) => a.hora.localeCompare(b.hora));
  const days = [];
  for (let d = 13; d >= 0; d--) days.push(dayKey(S.clock - d * 86400e3));
  const byKey = {};
  for (const d of S.doses) byKey[`${d.medId}|${dayKey(d.programada)}|${fT(d.programada)}`] = d;
  const col = { tomada: '#0ca30c', omitida: '#d03b3b', sin_respuesta: '#fab219', pendiente: '#86b6ef' };
  const lbl = { tomada: 'tomada', omitida: 'omitida', sin_respuesta: 'sin confirmar', pendiente: 'pendiente' };
  let html = `<div class="adh" style="grid-template-columns:max-content repeat(${days.length}, 1fr)"><span></span>${days.map((k) => `<span class="muted" style="text-align:center">${k.slice(8)}/${k.slice(5, 7)}</span>`).join('')}`;
  for (const s of slots) {
    html += `<span class="lbl">${esc(s.label)}</span>`;
    for (const k of days) {
      const d = byKey[`${s.medId}|${k}|${s.hora}`];
      html += `<div class="cell" style="background:${d ? col[d.estado] : '#f0f1f3'}" title="${esc(`${s.label} · ${k} · ${d ? lbl[d.estado] : 'sin dato'}`)}"></div>`;
    }
  }
  html += `</div><div class="legend"><span><i style="background:#0ca30c"></i>✓ Tomada</span><span><i style="background:#d03b3b"></i>✕ Omitida</span><span><i style="background:#fab219"></i>? Sin confirmar</span><span><i style="background:#86b6ef"></i>Pendiente</span><span><i style="background:#f0f1f3"></i>Sin dato</span></div>`;
  return html;
}

// ================= Evidencia =================
function renderEvidence() {
  const qs = S.evidenceQueries;
  setHTML('tab-evidencia', `
    <div class="stack">
      <div class="callout">Integración con <b>OpenEvidence (mock)</b>: en el panel, la médica consulta evidencia actualizada. En el canal de Marta opera en segundo plano: la consulta se <b>anonimiza</b>, la respuesta se reformula en lenguaje llano y, si sugiere un cambio de tratamiento, se envía sólo a la médica.</div>
      <div class="section">
        <h3>Consultar evidencia</h3>
        <div class="reply"><input data-draft="evq" id="evq" placeholder="Ej.: ¿Cuándo agregar un iSGLT2 en DM2 con HbA1c 8,4%?"><button class="btn primary" id="btnEv">Consultar</button></div>
        <div class="small muted" style="margin-top:6px">Probá: “iSGLT2 o arGLP-1”, “tos por enalapril”, “hipoglucemia”, “pie diabético”, “ejercicio”.</div>
      </div>
      <div class="section">
        <h3>Historial de consultas <span class="hint">${qs.length}</span></h3>
        ${qs.length ? qs.map((q) => `
          <div class="item"><div class="body">
            <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"><span class="pill">${esc(q.origen)}</span><b>${esc(q.tema)}</b>${q.sugiere_cambio_tratamiento ? '<span class="sev media">sugiere cambio de tratamiento</span>' : ''}</div>
            <div class="meta">Consulta enviada (anonimizada): “${esc(q.query_anonimizada)}” · ${fDT(q.ts)}</div>
            <div style="margin-top:4px">${esc(q.respuesta)}</div>
            <ol class="cites">${q.citas.map((c) => `<li>${esc(c.ref)} ${c.url ? `<a href="${c.url}" target="_blank">↗</a>` : ''}</li>`).join('')}</ol>
          </div></div>`).join('') : '<div class="empty">Sin consultas</div>'}
      </div>
    </div>`);
}

// ================= HCE / FHIR =================
let fhirCache = null;
let cdsCache = null;
function renderFhir() {
  const counts = {};
  const sig = JSON.stringify([S.messages.length, S.observations.length, S.doses.length, S.media.length, S.referrals.length, S.appointments.length, S.summaries.length, S.assistant && S.assistant.actualizado, S.referrals.filter((r) => r.estado !== 'pendiente').length]);
  if (fhirCache && fhirCache.sig === sig) {
    fhirCache.bundle.entry.forEach((e) => (counts[e.resource.resourceType] = (counts[e.resource.resourceType] || 0) + 1));
  } else {
    fhirCache = { sig, bundle: null };
    api('/api/fhir/bundle').then((b) => {
      fhirCache.bundle = b;
      rendered['tab-fhir'] = null;
      renderFhir();
    });
    return;
  }
  if (!fhirCache.bundle) return;
  const map = [
    ['Plan de cuidado y metas', ['CarePlan', 'Goal']],
    ['Medicación indicada', ['MedicationRequest']],
    ['Tomas confirmadas u omitidas', ['MedicationStatement']],
    ['Valores clínicos registrados', ['Observation']],
    ['Fotografías e informes', ['Media', 'DocumentReference']],
    ['Consultas relevantes y derivaciones', ['Communication']],
    ['Turnos', ['Appointment']],
    ['Resumen del período', ['Composition']],
  ];
  setHTML('tab-fhir', `
    <div class="stack">
      <div class="section">
        <h3>Exportación a la historia clínica (HL7 FHIR R4) <span class="hint">${fhirCache.bundle.entry.length} recursos</span></h3>
        <table class="t"><tr><th>Información generada</th><th>Recurso FHIR</th><th class="num">Cantidad</th></tr>
        ${map.map(([l, rs]) => `<tr><td>${l}</td><td class="mono small">${rs.join(', ')}</td><td class="num">${rs.reduce((s, r) => s + (counts[r] || 0), 0)}</td></tr>`).join('')}</table>
        <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
          <a class="btn primary" href="/api/fhir/bundle?download=1">Descargar Bundle (JSON)</a>
          <button class="btn" id="btnShowBundle">Ver Bundle</button>
          <button class="btn" id="btnShowHce">Ver datos originales de la HCE</button>
        </div>
        <pre class="json" id="bundleView" style="display:none;margin-top:10px"></pre>
      </div>
      <div class="section">
        <h3>CDS Hooks · <span class="mono">patient-view</span> <span class="hint">las alertas aparecen dentro de la HCE al abrir el registro</span></h3>
        <button class="btn" id="btnCds">Simular: la Dra. Lucía abre el registro de Marta en la HCE</button>
        <div id="cdsView" style="margin-top:10px"></div>
      </div>
    </div>`);
  if (cdsCache) renderCds(cdsCache);
}

function renderCds(r) {
  const v = $('#cdsView');
  if (!v) return;
  v.innerHTML = `<div class="ehr"><div class="bar"><b>HCE institucional</b><span>Paciente: González, Marta · 62 a · DM2, HTA</span></div><div class="content">
    ${r.cards.length ? r.cards.map((c) => `<div class="cds-card ${c.indicator}"><b>${c.indicator === 'critical' ? '⚠ ' : c.indicator === 'warning' ? '▲ ' : 'ℹ '}${esc(c.summary)}</b><div style="white-space:pre-wrap;margin-top:4px">${esc(c.detail || '')}</div><div class="src">Fuente: ${esc(c.source.label)}</div></div>`).join('') : '<div class="muted">Sin tarjetas</div>'}
    </div></div><details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">Respuesta JSON del servicio CDS Hooks</summary><pre class="json">${esc(JSON.stringify(r, null, 2))}</pre></details>`;
}

// ================= Trazas =================
function renderTraces() {
  const tr = S.traces;
  setHTML('tab-trazas', `
    <div class="callout" style="margin-bottom:14px">Cada interacción muestra el recorrido por la arquitectura: filtro de seguridad → recuperación en la base especializada (RAG) → clasificación de intención con el modelo de lenguaje → módulos de servicio (registro, evidencia, derivación, turnos) → recursos FHIR.</div>
    ${tr.length ? tr.map((t) => `<div class="trace"><div class="ev">${esc(t.evento)} <span class="small muted">· ${fDT(t.ts)}</span></div><ol>${t.pasos.map((p) => `<li><b>${esc(p.paso)}:</b> ${esc(p.detalle)}</li>`).join('')}</ol></div>`).join('') : '<div class="empty">Sin eventos</div>'}`);
  const last = tr[0];
  setHTML('lastTrace', last ? `<div class="role">Cómo lo procesó el sistema</div><div style="font-size:12.5px;font-weight:600;margin-top:2px">${esc(last.evento)}</div><ol>${last.pasos.map((p) => `<li><b>${esc(p.paso)}:</b> ${esc(p.detalle)}</li>`).join('')}</ol>` : '<div class="role">Cómo lo procesó el sistema</div><div class="small muted">Las trazas aparecen acá con cada interacción.</div>');
}

// ================= Chat de Marta =================
const INTENT_LABEL = { educativa: 'Educativa · RAG', registro: 'Registro', adherencia: 'Adherencia', turno: 'Turno', derivacion: 'Derivación', alarma: 'ALARMA', otro: 'Otro' };
let lastMsgCount = 0;

function renderChat() {
  const has = !!S.assistant;
  $('#phoneOverlay').style.display = has ? 'none' : 'grid';
  const canal = has ? S.assistant.config.canal : 'whatsapp';
  $('#waHead').className = `wa-head ${canal === 'app' ? 'app' : ''}`;
  $('#waStatus').textContent = S.busy ? 'escribiendo…' : canal === 'app' ? 'App del asistente (simulada)' : 'WhatsApp Business (simulado)';
  $('#typing').textContent = S.busy ? 'El asistente está procesando…' : S.nextDose ? `⏰ ${S.nextDose}` : '';

  let html = '';
  let lastDay = null;
  for (const m of S.messages) {
    const dk = dayKey(m.ts);
    if (dk !== lastDay) {
      html += `<div class="daysep"><span>${fD(m.ts)}</span></div>`;
      lastDay = dk;
    }
    html += bubble(m);
  }
  const changed = setHTML('msgs', html || '<div class="daysep"><span>Sin mensajes</span></div>');
  if (changed && S.messages.length !== lastMsgCount) {
    const box = $('#msgs');
    box.scrollTop = box.scrollHeight;
    lastMsgCount = S.messages.length;
  }
}

function bubble(m) {
  const time = `<div class="time">${fT(m.ts)}${m.from === 'marta' ? ' ✓✓' : ''}</div>`;
  if (m.from === 'marta') {
    let body = '';
    if (m.kind === 'image' && m.attachment) body += `<a href="${m.attachment.url}" target="_blank"><img src="${m.attachment.url}" alt="${esc(m.attachment.nombre)}"></a>`;
    if (m.kind === 'file' && m.attachment) body += `<a class="filechip" href="${m.attachment.url}" target="_blank"><span class="ic">PDF</span><span>${esc(m.attachment.nombre)}</span></a>`;
    if (m.kind === 'audio') body += `${m.audioUrl ? `<audio controls src="${m.audioUrl}"></audio>` : '🎤 Audio'}<div class="transcript">“${esc(m.text)}”</div>`;
    else if (m.text) body += esc(m.text);
    const tags = m.intent ? `<div class="tags right"><span class="tag i-${m.intent}">${INTENT_LABEL[m.intent] || m.intent}</span>${m.topic ? `<span class="tag">${esc(m.topic)}</span>` : ''}</div>` : '';
    return `<div class="bubble out">${tags}${body}${time}</div>`;
  }
  if (m.from === 'lucia') return `<div class="bubble doc"><div class="who">Dra. Lucía Fernández</div>${esc(m.text)}${time}</div>`;
  // asistente
  let extra = '';
  if (m.kind === 'reminder') {
    extra = `<div class="actions">${m.answered ? `<button disabled class="chosen">${m.answered === 'tomada' ? 'Sí, la tomé ✅' : 'No la tomé'}</button>` : `<button data-rem="${m.id}" data-ok="1">Sí, la tomé</button><button data-rem="${m.id}" data-ok="0">No la tomé</button>`}</div>`;
  }
  if (m.kind === 'slots') {
    extra = `<div class="actions" style="flex-direction:column">${m.slots.map((s) => `<button ${m.answered ? 'disabled' : ''} data-slot="${s.id}">${fDT(s.inicio)} · ${esc(s.lugar)}</button>`).join('')}</div>`;
  }
  const src = [];
  if (m.sources && m.sources.length) src.push(`📚 ${m.sources.map((s) => `${s.id} · ${esc(s.titulo)}`).join(' | ')}`);
  if (m.evidence) src.push(`🔬 ${esc(m.evidence.servicio)} · ${esc(m.evidence.tema)} (${m.evidence.citas} citas)`);
  if (m.referral) src.push('↪ Consulta derivada a la Dra. Lucía');
  return `<div class="bubble ${m.kind === 'alarm' ? 'alarm' : 'in'}">${esc(m.text)}${extra}${src.length ? `<div class="srcline">${src.join('<br>')}</div>` : ''}${time}</div>`;
}

const CHIPS = [
  'Hola',
  'Anoche me olvidé la pastilla',
  'Me dio 145 en ayunas',
  'Ya tomé la pastilla',
  '¿Cuánto tengo que caminar?',
  '¿Puedo comer pan?',
  'La metformina me da diarrea',
  'Me midió 150/95 la presión',
  'Quiero sacar un turno',
  '¿Me puedo pasar al Ozempic?',
  'Tengo tos seca hace semanas',
  'Me duele el pecho y me falta el aire',
];

// ---------------- Envío de mensajes ----------------
async function sendText(text) {
  text = text.trim();
  if (!text) return;
  $('#txt').value = '';
  updateSendIcon();
  // eco optimista
  S.messages.push({ id: 'tmp', ts: S.clock, from: 'marta', kind: 'text', text });
  S.busy = true;
  renderChat();
  try {
    await api('/api/chat/text', { method: 'POST', body: { text } });
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

let pendingFile = null;
function chooseFile(file) {
  if (!file) return;
  pendingFile = file;
  $('#previewName').textContent = file.name;
  const img = $('#previewImg');
  if (file.type.startsWith('image/')) {
    img.src = URL.createObjectURL(file);
    img.style.display = '';
  } else img.style.display = 'none';
  $('#previewBar').classList.add('open');
  $('#caption').focus();
}
async function sendFile() {
  if (!pendingFile) return;
  const fd = new FormData();
  fd.append('file', pendingFile, pendingFile.name);
  fd.append('caption', $('#caption').value);
  closePreview();
  S.busy = true;
  renderChat();
  try {
    await api('/api/chat/file', { form: fd });
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}
function closePreview() {
  pendingFile = null;
  $('#previewBar').classList.remove('open');
  $('#caption').value = '';
  $('#fileInput').value = '';
}
async function sendSample(archivo) {
  $('#attachMenu').classList.remove('open');
  S.busy = true;
  renderChat();
  try {
    await api('/api/chat/sample', { method: 'POST', body: { archivo } });
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

function renderAttachMenu() {
  $('#attachMenu').innerHTML = `
    <div class="opt" id="optUpload"><div class="pdf" style="background:#7f66ff">⬆</div><div>Subir foto o PDF desde la computadora<small>JPG, PNG, WEBP o PDF (máx. 15 MB)</small></div></div>
    <h5>Archivos de prueba</h5>
    ${MUESTRAS.map((m) => `<div class="opt" data-sample="${esc(m.archivo)}">${m.archivo.endsWith('.pdf') ? '<div class="pdf">PDF</div>' : `<img src="/muestras/${esc(m.archivo)}" alt="">`}<div>${esc(m.titulo)}<small>${esc(m.esperado)}</small></div></div>`).join('')}
    <div class="small muted" style="padding:6px 8px">También están en la carpeta <b>muestras/</b> del proyecto para subirlos a mano; o probá con tus propias fotos.</div>`;
}

// ---------------- Audio (Web Speech API + MediaRecorder) ----------------
let rec = null;
async function toggleRecording() {
  if (rec) return stopRecording();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    const t = prompt('No se pudo acceder al micrófono. Escribí la transcripción simulada del audio:');
    if (t) sendAudio(null, t, 0);
    return;
  }
  const chunks = [];
  const mr = new MediaRecorder(stream);
  mr.ondataavailable = (e) => chunks.push(e.data);
  rec = { mr, stream, chunks, transcript: '', t0: Date.now(), sr: null };
  mr.onstop = () => {
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    stream.getTracks().forEach((t) => t.stop());
    const done = (txt) => {
      if (!txt) txt = prompt('No se obtuvo transcripción automática (Chrome/Edge la soportan). Escribí lo que dijiste:') || '';
      if (txt.trim()) sendAudio(blob, txt.trim(), (Date.now() - rec.t0) / 1000);
      rec = null;
      $('#btnSend').classList.remove('rec');
    };
    setTimeout(() => done(rec.transcript), 400);
  };
  if (SR) {
    const sr = new SR();
    sr.lang = 'es-AR';
    sr.continuous = true;
    sr.interimResults = false;
    sr.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) rec.transcript += `${e.results[i][0].transcript} `;
    };
    sr.onerror = () => {};
    sr.start();
    rec.sr = sr;
  }
  mr.start();
  $('#btnSend').classList.add('rec');
  toast('Grabando… tocá de nuevo para enviar');
}
function stopRecording() {
  if (!rec) return;
  if (rec.sr) rec.sr.stop();
  rec.mr.stop();
}
async function sendAudio(blob, transcript, duration) {
  const fd = new FormData();
  if (blob) fd.append('audio', blob, 'audio.webm');
  fd.append('transcript', transcript);
  fd.append('duration', String(duration));
  S.busy = true;
  renderChat();
  try {
    await api('/api/chat/audio', { form: fd });
  } catch (e) {
    toast(e.message, true);
  }
  await refresh();
}

function updateSendIcon() {
  const has = $('#txt').value.trim().length > 0;
  $('#icoMic').style.display = has ? 'none' : '';
  $('#icoSend').style.display = has ? '' : 'none';
}

// ---------------- Eventos ----------------
function switchTab(t) {
  if (!t) return;
  currentTab = t;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.id === `tab-${t}`));
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, .opt, .step');
  if (!t) return;
  if (t.classList.contains('tab')) return switchTab(t.dataset.tab);
  if (t.classList.contains('step')) return switchTab(t.dataset.goto);
  if (t.id === 'btnImport') {
    await act('/api/hce/import', {}, 'Datos importados desde la HCE (mock FHIR)');
    return;
  }
  if (t.id === 'btnCreate') {
    readForm();
    if (configDraft.medicacion.some((m) => !m.horarios.length)) return toast('Cada medicamento necesita al menos un horario HH:MM', true);
    const { _from, ...config } = configDraft;
    const isNew = !S.assistant;
    await act('/api/assistant', { config }, isNew ? 'Asistente generado: lucia-marta-assistant' : 'Configuración actualizada');
    configDraft = null;
    rendered.configSig = null;
    renderConfig();
    if (isNew) toast('Asistente generado. Marta ya puede escribir; probá “Simular 14 días” o “Próxima toma”.');
    return;
  }
  if (t.id === 'btnNext') return act('/api/sim/next-dose');
  if (t.id === 'btnHour') return act('/api/sim/advance', { minutes: 60 });
  if (t.id === 'btnSeed') {
    await act('/api/sim/seed', {}, 'Se generaron 14 días de seguimiento de ejemplo');
    switchTab('panel');
    return;
  }
  if (t.id === 'btnReset') {
    if (!confirm('¿Reiniciar la demo? Se borran todos los datos simulados.')) return;
    configDraft = null;
    cdsCache = null;
    Object.keys(rendered).forEach((k) => delete rendered[k]);
    await act('/api/sim/reset', {}, 'Demo reiniciada');
    switchTab('config');
    return;
  }
  if (t.id === 'almAdd') {
    alarmEdit = { id: 'nuevo', tipo: 'texto' };
    return renderAlarmas();
  }
  if (t.id === 'almCancel') {
    alarmEdit = null;
    return renderAlarmas();
  }
  if (t.dataset.almEdit) {
    const a = S.assistant.config.alarmas.find((x) => x.id === t.dataset.almEdit);
    alarmEdit = a ? { id: a.id, tipo: a.tipo } : null;
    return renderAlarmas();
  }
  if (t.dataset.almDel) {
    const a = S.assistant.config.alarmas.find((x) => x.id === t.dataset.almDel);
    if (!a || !confirm(`¿Eliminar la alarma “${a.nombre}”?`)) return;
    return alarmOp('DELETE', `/api/alarms/${a.id}`, null, 'Alarma eliminada');
  }
  if (t.id === 'almSave') {
    const id = t.dataset.id;
    const datos = alarmFormData(id, alarmEdit.tipo);
    return id === 'nuevo' ? alarmOp('POST', '/api/alarms', datos, 'Alarma agregada') : alarmOp('PUT', `/api/alarms/${id}`, datos, 'Alarma modificada');
  }
  if (t.dataset.ack) return act(`/api/alert/${t.dataset.ack}/ack`);
  if (t.dataset.reply) {
    const inp = $(`[data-draft="rep-${t.dataset.reply}"]`);
    const v = inp ? inp.value.trim() : '';
    if (!v) return toast('Escribí una respuesta', true);
    inp.value = '';
    return act(`/api/referral/${t.dataset.reply}/reply`, { texto: v }, 'Respuesta enviada a Marta');
  }
  if (t.dataset.sug) return act(`/api/suggestion/${t.dataset.sug}`, { estado: t.dataset.est });
  if (t.id === 'btnSummary') {
    t.disabled = true;
    t.textContent = 'Generando…';
    await act('/api/summary', {}, 'Resumen preconsulta generado');
    return;
  }
  if (t.id === 'btnEv') {
    const v = $('#evq').value.trim();
    if (!v) return;
    $('#evq').value = '';
    return act('/api/evidence', { pregunta: v });
  }
  if (t.id === 'btnShowBundle') window.__exported = true;
  if (t.id === 'btnShowBundle' || t.id === 'btnShowHce') {
    const pre = $('#bundleView');
    const data = t.id === 'btnShowBundle' ? fhirCache.bundle : await api('/api/hce/bundle');
    pre.textContent = JSON.stringify(data, null, 2);
    pre.style.display = 'block';
    return;
  }
  if (t.id === 'btnCds') {
    cdsCache = await api('/cds-services/seguimiento-entre-consultas', { method: 'POST', body: { hook: 'patient-view', hookInstance: crypto.randomUUID ? crypto.randomUUID() : 'demo', context: { userId: 'Practitioner/lucia-001', patientId: 'marta-001' } } });
    renderCds(cdsCache);
    return;
  }
  // chat
  if (t.dataset.rem) return act(`/api/reminder/${t.dataset.rem}`, { tomada: t.dataset.ok === '1' });
  if (t.dataset.slot) return act(`/api/slot/${t.dataset.slot}`);
  if (t.dataset.chip != null) return sendText(t.dataset.chip);
  if (t.id === 'btnAttach') {
    $('#attachMenu').classList.toggle('open');
    return;
  }
  if (t.id === 'optUpload') {
    $('#attachMenu').classList.remove('open');
    $('#fileInput').click();
    return;
  }
  if (t.dataset.sample) return sendSample(t.dataset.sample);
  if (t.id === 'cancelFile') return closePreview();
  if (t.id === 'sendFile') return sendFile();
  if (t.id === 'btnSend') {
    const v = $('#txt').value;
    if (v.trim()) return sendText(v);
    return toggleRecording();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.closest('#cfgForm')) readForm();
  if (e.target.dataset.almToggle) {
    const on = e.target.checked;
    alarmOp('PUT', `/api/alarms/${e.target.dataset.almToggle}`, { activa: on }, on ? 'Alarma reactivada' : 'Alarma pausada');
  }
  if (e.target.dataset.almTipo != null && alarmEdit) {
    alarmEdit.tipo = e.target.value;
    renderAlarmas();
  }
  if (e.target.id === 'fileInput') chooseFile(e.target.files[0]);
});
document.addEventListener('input', (e) => {
  if (e.target.closest('#cfgForm')) readForm();
  if (e.target.id === 'txt') updateSendIcon();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'txt') sendText(e.target.value);
  if (e.target.id === 'caption') sendFile();
  if (e.target.id === 'evq') $('#btnEv').click();
  if (e.target.dataset && e.target.dataset.draft && e.target.dataset.draft.startsWith('rep-')) $(`[data-reply="${e.target.dataset.draft.slice(4)}"]`).click();
});
document.addEventListener('click', (e) => {
  if (e.target.closest('a[href*="fhir/bundle"]')) {
    window.__exported = true;
    setTimeout(refresh, 300);
  }
  if (!e.target.closest('#attachMenu') && !e.target.closest('#btnAttach')) $('#attachMenu').classList.remove('open');
});

// ---------------- Inicio ----------------
(async function init() {
  $('#chips').innerHTML = CHIPS.map((c) => `<button data-chip="${esc(c)}">${esc(c)}</button>`).join('');
  try {
    CAT = await api('/api/catalog');
    MUESTRAS = await api('/api/muestras');
  } catch {}
  renderAttachMenu();
  await refresh();
  setInterval(refresh, 2500);
})();
