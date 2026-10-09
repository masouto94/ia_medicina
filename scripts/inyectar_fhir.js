#!/usr/bin/env node
// Inyecta los logs de trazabilidad (logs/fhir/*.ndjson) en un servidor FHIR R4, o arma el Bundle para hacerlo después.
//
//   npm run logs:fhir                                   → escribe logs/fhir/bundle-batch.json
//   npm run logs:fhir -- --servidor http://localhost:8080/fhir     → lo envía (POST del Bundle "batch")
//   npm run logs:fhir -- --servidor URL --token XXX     → con "Authorization: Bearer XXX"
//   npm run logs:fhir -- --sesion ses-...               → sólo una sesión de la demo
//   npm run logs:fhir -- --tipos AuditEvent             → sólo AuditEvent (o Provenance)
//
// Cada recurso va como PUT <Tipo>/<id>: si se ejecuta dos veces, no se duplica nada.
// Antes de enviar se verifica la cadena de hashes de logs/; si está rota, no se envía (salvo --forzar).
// Las referencias son lógicas (por identificador), así que no hace falta que el servidor tenga a la paciente o la médica.
const fs = require('fs');
const path = require('path');
const LOGS = require('../src/logs');

function args(argv) {
  const o = { tipos: ['AuditEvent', 'Provenance'] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const sig = () => argv[++i];
    if (a === '--servidor') o.servidor = sig();
    else if (a === '--token') o.token = sig();
    else if (a === '--sesion') o.sesion = sig();
    else if (a === '--tipos') o.tipos = sig().split(',').map((x) => x.trim());
    else if (a === '--salida') o.salida = sig();
    else if (a === '--forzar') o.forzar = true;
    else if (a === '--ayuda' || a === '-h') o.ayuda = true;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.ayuda) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const TIPO_LOG = { AuditEvent: 'auditoria', Provenance: 'procedencia' };
  for (const t of o.tipos) if (!TIPO_LOG[t]) throw new Error(`Tipo no válido: ${t} (usá AuditEvent y/o Provenance)`);

  // 1) integridad
  for (const t of o.tipos) {
    const v = LOGS.verificar(TIPO_LOG[t]);
    console.log(`  ${v.ok ? '✓' : '✗'} ${LOGS.TIPOS[TIPO_LOG[t]].archivo}: ${v.registros} registros${v.ok ? '' : ` · línea ${v.linea}: ${v.error}`}`);
    if (!v.ok && !o.forzar) throw new Error('La cadena de hashes está rota: no se inyecta. Revisá el archivo o usá --forzar.');
  }

  // 2) Bundle batch con PUT (idempotente)
  const recursos = o.tipos.flatMap((t) => LOGS.leerFhir(TIPO_LOG[t], { sesion: o.sesion || null }));
  const bundle = {
    resourceType: 'Bundle',
    type: 'batch',
    timestamp: new Date().toISOString(),
    entry: recursos.map((r) => ({ fullUrl: `urn:uuid:${r.resourceType.toLowerCase()}-${r.id}`, resource: r, request: { method: 'PUT', url: `${r.resourceType}/${r.id}` } })),
  };
  console.log(`  ${recursos.length} recursos (${o.tipos.map((t) => `${recursos.filter((r) => r.resourceType === t).length} ${t}`).join(', ')})${o.sesion ? ` de la sesión ${o.sesion}` : ''}`);
  if (!recursos.length) return;

  // 3) a un archivo o a un servidor
  if (!o.servidor) {
    const salida = path.resolve(o.salida || path.join(LOGS.DIR, 'fhir', 'bundle-batch.json'));
    fs.writeFileSync(salida, JSON.stringify(bundle, null, 2));
    console.log(`  Bundle escrito en ${path.relative(process.cwd(), salida)}`);
    console.log('  Para enviarlo: npm run logs:fhir -- --servidor <URL base del servidor FHIR>');
    return;
  }
  const url = o.servidor.replace(/\/+$/, '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json', ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}) },
    body: JSON.stringify(bundle),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}: ${txt.slice(0, 400)}`);
  let resp = null;
  try {
    resp = JSON.parse(txt);
  } catch {}
  const estados = resp && resp.entry ? resp.entry.map((e) => (e.response && e.response.status) || '?') : [];
  const fallidos = estados.filter((s) => !/^2/.test(s));
  console.log(`  Enviado a ${url}: ${estados.length - fallidos.length}/${estados.length} aceptados${fallidos.length ? ` · rechazados: ${[...new Set(fallidos)].join(', ')}` : ''}`);
  if (fallidos.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`  Error: ${e.message}`);
  process.exit(1);
});
