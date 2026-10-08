// Acceso al modelo de lenguaje (Claude). Dos formas de conectarse:
//
//  1) "claude-code": usa el CLI oficial de Claude Code instalado en la computadora, con la sesión
//     de TU suscripción de Claude (Pro/Max). La app nunca ve ni guarda credenciales: sólo ejecuta
//     `claude -p` y lee la respuesta. Requiere haber iniciado sesión antes con `claude`.
//  2) "api": usa la API de Anthropic con ANTHROPIC_API_KEY (facturación por uso).
//
// Si ninguna está disponible, la app funciona en "modo simulado".
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const CLI_MODEL = process.env.CLAUDE_CODE_MODEL || 'sonnet';
const CLI_BIN = process.env.CLAUDE_CODE_BIN || 'claude';
const CLI_TIMEOUT = Number(process.env.CLAUDE_CODE_TIMEOUT_MS) || 150000;
const IS_WIN = process.platform === 'win32';

let provider = null; // 'claude-code' | 'api' | null
let detail = '';
let lastError = null;
let client = null;

// ---------------- Detección ----------------
async function init() {
  const pref = (process.env.LLM_PROVIDER || 'auto').toLowerCase();
  if (pref === 'mock' || pref === 'simulado') {
    detail = 'Modo simulado forzado por LLM_PROVIDER';
    return status();
  }
  if (pref === 'claude-code' || pref === 'auto') {
    const st = await cliAuthStatus();
    if (st.ok) {
      provider = 'claude-code';
      detail = `Claude Code ${st.version || ''} · sesión: ${st.authMethod || 'suscripción'}`;
      return status();
    }
    detail = st.reason;
    if (pref === 'claude-code') return status();
  }
  if ((pref === 'api' || pref === 'auto') && process.env.ANTHROPIC_API_KEY) {
    const Anthropic = require('@anthropic-ai/sdk');
    client = new Anthropic();
    provider = 'api';
    detail = 'API de Anthropic (ANTHROPIC_API_KEY)';
  }
  return status();
}

function run(args, { input = '', cwd, timeout = CLI_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const q = (a) => (a === '' ? '""' : /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    let child;
    try {
      // un CLAUDE_CODE_BIN terminado en .js (p. ej. el Claude falso de los tests) se ejecuta con Node
      child = CLI_BIN.endsWith('.js')
        ? spawn(process.execPath, [CLI_BIN, ...args], { cwd, env: process.env, windowsHide: true })
        : spawn(CLI_BIN, IS_WIN ? args.map(q) : args, { cwd, shell: IS_WIN, env: process.env, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e.message || e) });
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      err += `\nTiempo de espera agotado (${timeout / 1000} s)`;
    }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function cliAuthStatus() {
  const v = await run(['--version'], { timeout: 20000 });
  if (v.code !== 0) return { ok: false, reason: `No se encontró el CLI "claude" (${(v.err || '').trim().slice(0, 120) || 'no instalado'}). Instalalo y ejecutá "claude" para iniciar sesión.` };
  const s = await run(['auth', 'status'], { timeout: 20000 });
  let info = {};
  try {
    info = JSON.parse(s.out);
  } catch {}
  if (s.code !== 0 || info.loggedIn === false) return { ok: false, reason: 'Claude Code está instalado pero sin sesión iniciada. Ejecutá "claude" en la terminal e iniciá sesión con tu cuenta.' };
  return { ok: true, version: v.out.trim().split(' ')[0], authMethod: info.authMethod };
}

// ---------------- Claude Code CLI ----------------

// Convierte mensajes estilo Messages API en texto + archivos temporales (imágenes/PDF)
function materialize(messages, dir) {
  const parts = [];
  let n = 0;
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text') parts.push(b.text);
      else if (b.type === 'image' || b.type === 'document') {
        const ext = b.source.media_type === 'application/pdf' ? 'pdf' : b.source.media_type.split('/')[1].replace('jpeg', 'jpg');
        const name = `adjunto_${++n}.${ext}`;
        fs.writeFileSync(path.join(dir, name), Buffer.from(b.source.data, 'base64'));
        parts.push(`[Archivo adjunto: ${path.join(dir, name)}. Leelo con la herramienta Read antes de responder.]`);
      }
    }
  }
  return { prompt: parts.join('\n\n'), hasFiles: n > 0 };
}

async function cliCall({ system, messages, schema }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistente-dm2-'));
  try {
    const { prompt, hasFiles } = materialize(messages, dir);
    let sys = system;
    if (schema) {
      sys += `\n\nFORMATO DE SALIDA OBLIGATORIO: respondé ÚNICAMENTE con un objeto JSON válido (sin texto antes ni después, sin bloques \`\`\`) que cumpla este JSON Schema:\n${JSON.stringify(schema)}`;
    }
    fs.writeFileSync(path.join(dir, 'system.txt'), sys, 'utf8');
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', CLI_MODEL,
      '--system-prompt-file', path.join(dir, 'system.txt'),
      '--no-session-persistence',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--max-turns', hasFiles ? '4' : '2',
    ];
    if (hasFiles) args.push('--tools', 'Read', '--allowedTools', 'Read');
    else args.push('--tools', '');
    const r = await run(args, { input: prompt, cwd: dir });
    let res;
    try {
      res = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop());
    } catch {
      throw new Error(`Claude Code no respondió correctamente (código ${r.code}): ${(r.err || r.out).trim().slice(0, 200)}`);
    }
    if (res.is_error) throw new Error(`Claude Code: ${String(res.result || res.subtype).slice(0, 200)}`);
    return { text: String(res.result || ''), usage: res.usage };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseJson(text) {
  const t = text.replace(/```(?:json)?/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('La respuesta no contenía JSON');
  return JSON.parse(t.slice(a, b + 1));
}

// ---------------- API pública ----------------

/**
 * Salida estructurada (JSON) que respeta el esquema de la "herramienta".
 * @param {{system:string, messages:Array, tool:{name, description, input_schema}}} p
 */
async function structured({ system, messages, tool, maxTokens = 1500 }) {
  const t0 = Date.now();
  if (provider === 'claude-code') {
    const r = await cliCall({ system, messages, schema: tool.input_schema });
    return { data: parseJson(r.text), ms: Date.now() - t0, usage: r.usage };
  }
  const res = await client.messages.create({
    model: API_MODEL,
    max_tokens: maxTokens,
    system,
    messages,
    tools: [tool],
    tool_choice: { type: 'tool', name: tool.name },
  });
  const block = res.content.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('El modelo no devolvió una salida estructurada');
  return { data: block.input, ms: Date.now() - t0, usage: res.usage };
}

async function text({ system, messages, maxTokens = 1200 }) {
  const t0 = Date.now();
  if (provider === 'claude-code') {
    const r = await cliCall({ system, messages });
    return { data: r.text.trim(), ms: Date.now() - t0, usage: r.usage };
  }
  const res = await client.messages.create({ model: API_MODEL, max_tokens: maxTokens, system, messages });
  const out = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return { data: out, ms: Date.now() - t0, usage: res.usage };
}

function label() {
  if (provider === 'claude-code') return `Claude Code · ${CLI_MODEL}`;
  if (provider === 'api') return API_MODEL;
  return null;
}

function status() {
  return { enabled: !!provider, provider, model: label(), detail, lastError };
}

function setError(e) {
  lastError = e ? String(e.message || e).slice(0, 300) : null;
}

module.exports = {
  init,
  structured,
  text,
  status,
  setError,
  get enabled() {
    return !!provider;
  },
  get MODEL() {
    return label();
  },
};
