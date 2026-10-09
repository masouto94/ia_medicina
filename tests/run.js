#!/usr/bin/env node
// Corre los tests:  npm test logic       → sin LLM (reglas, guardrails, módulos y flujo con un Claude falso)
//                   npm test generative  → con el LLM real configurado (Claude Code o API key)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = {
  logic: 'Sin LLM: determinísticos y reproducibles',
  generative: 'Con el LLM real: casos clínicos contra el asistente (lento, no determinístico)',
};
const suite = (process.argv[2] || 'logic').toLowerCase();
if (!SUITES[suite]) {
  console.error(`Suite desconocida: "${suite}". Opciones:\n${Object.entries(SUITES).map(([k, v]) => `  npm test ${k.padEnd(11)} ${v}`).join('\n')}`);
  process.exit(2);
}
const dir = path.join(__dirname, suite);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join(dir, f));
console.log(`\n▶ Tests ${suite}: ${SUITES[suite]}\n`);
const major = Number(process.versions.node.split('.')[0]);
const flags = ['--test', ...(major >= 20 ? ['--test-reporter=spec'] : []), ...(major >= 21 ? ['--test-concurrency=1'] : [])];
const r = spawnSync(process.execPath, [...flags, ...files], { stdio: 'inherit', env: { ...process.env, TEST_SUITE: suite } });
process.exit(r.status ?? 1);
