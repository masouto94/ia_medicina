// Levanta una instancia aislada de la app para los tests (estado en una carpeta temporal, puerto propio).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');

async function iniciar({ env = {}, timeoutMs = 60000 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asistente-test-'));
  const port = 4100 + Math.floor(Math.random() * 800);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: RAIZ,
    env: { ...process.env, DATA_DIR: dataDir, LOGS_DIR: path.join(dataDir, 'logs'), PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`El servidor terminó al iniciar:\n${log}`);
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) break;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`El servidor no respondió a tiempo:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  async function api(ruta, { method, body, timeout = 300000 } = {}) {
    const r = await fetch(`${base}${ruta}`, {
      method: method || (body !== undefined ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const txt = await r.text();
    let data;
    try {
      data = JSON.parse(txt);
    } catch {
      data = txt;
    }
    if (!r.ok) {
      const e = new Error((data && data.error) || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  }

  async function detener() {
    child.kill();
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return { base, api, detener, log: () => log, dataDir, logsDir: path.join(dataDir, 'logs') };
}

module.exports = { iniciar, RAIZ };
