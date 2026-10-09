// Envío a la HCE: Bundle transaction (PUT idempotente) a la URL de .env, simulado o real, siempre auditado.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { iniciar } = require('../lib/servidor');
const { prepararAsistente } = require('../lib/plan');

const ID_FHIR = /^[A-Za-z0-9.-]{1,64}$/;
const DE_LA_HCE = ['Patient', 'Practitioner', 'Condition', 'MedicationRequest'];

// Servidor FHIR de prueba: guarda lo que recibe y responde como una HCE (o falla, si se le pide)
async function servidorFhir(t, { falla = false } = {}) {
  const recibidos = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      recibidos.push({ url: req.url, metodo: req.method, headers: req.headers, bundle: JSON.parse(body) });
      res.writeHead(falla ? 422 : 200, { 'Content-Type': 'application/fhir+json' });
      const b = recibidos.at(-1).bundle;
      res.end(JSON.stringify(falla ? { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: 'Patient/marta-001 no existe en esta HCE' }] } : { resourceType: 'Bundle', type: 'transaction-response', entry: b.entry.map(() => ({ response: { status: '201 Created' } })) }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { url: `http://127.0.0.1:${srv.address().port}/fhir`, recibidos };
}

async function conDatos(api) {
  await prepararAsistente(api);
  await api('/api/chat/text', { body: { text: 'Me dio 145 en ayunas' } });
  await api('/api/chat/text', { body: { text: '¿Me puedo pasar al Ozempic?' } });
}

test('envío simulado: la URL sale de .env, no sale ningún pedido', async (t) => {
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock', HCE_FHIR_URL: 'https://hce.ejemplo.org/fhir/', HCE_ENVIO: 'simulado' } });
  t.after(() => srv.detener());
  const { api } = srv;
  await conDatos(api);
  assert.deepEqual((await api('/api/catalog')).hce, { url: 'https://hce.ejemplo.org/fhir', modo: 'simulado', autenticacion: 'ninguna' });
  const exp = await api('/api/hce/export', { body: {} });
  assert.equal(exp.estado, 'simulado');
  assert.equal(exp.destino, 'https://hce.ejemplo.org/fhir');
  const [a] = (await api('/api/auditoria')).auditoria;
  assert.equal(a.evento, 'Bundle enviado a la HCE');
  assert.match(a.detalle, /POST https:\/\/hce\.ejemplo\.org\/fhir \(envío simulado\): Bundle transaction/);

  const b = await api('/api/fhir/bundle');
  for (const e of b.entry) {
    assert.match(e.resource.id, ID_FHIR, `${e.resource.resourceType}/${e.resource.id}: id FHIR inválido`);
    assert.equal(e.fullUrl, `https://hce.ejemplo.org/fhir/${e.resource.resourceType}/${e.resource.id}`);
  }
});

test('envío real: Bundle transaction con PUT a la URL de .env, con token', async (t) => {
  const fhir = await servidorFhir(t);
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock', HCE_FHIR_URL: fhir.url, HCE_ENVIO: 'real', HCE_FHIR_TOKEN: 'token-de-prueba' } });
  t.after(() => srv.detener());
  const { api } = srv;
  await conDatos(api);
  const exp = await api('/api/hce/export', { body: {} });
  assert.equal(exp.estado, 'enviado');
  assert.equal(exp.aceptados, exp.total);

  const [r] = fhir.recibidos;
  assert.equal(r.metodo, 'POST');
  assert.equal(r.url, '/fhir');
  assert.match(r.headers['content-type'], /application\/fhir\+json/);
  assert.equal(r.headers.authorization, 'Bearer token-de-prueba');
  assert.equal(r.bundle.resourceType, 'Bundle');
  assert.equal(r.bundle.type, 'transaction');
  assert.ok(r.bundle.entry.length > 0);
  for (const e of r.bundle.entry) {
    assert.deepEqual(e.request, { method: 'PUT', url: `${e.resource.resourceType}/${e.resource.id}` });
    assert.ok(!DE_LA_HCE.includes(e.resource.resourceType), `no se reenvía ${e.resource.resourceType}: ya está en la HCE`);
  }
  const tipos = new Set(r.bundle.entry.map((e) => e.resource.resourceType));
  for (const tipo of ['CarePlan', 'Goal', 'Observation', 'Communication', 'GuidanceResponse', 'Task']) assert.ok(tipos.has(tipo), tipo);

  // dos envíos actualizan los mismos recursos (mismas URLs de PUT), no los duplican
  await api('/api/hce/export', { body: {} });
  const urls = (i) => fhir.recibidos[i].bundle.entry.map((e) => e.request.url).filter((u) => !/^(Provenance|AuditEvent)\//.test(u));
  assert.deepEqual(urls(1), urls(0));
  const [a] = (await api('/api/auditoria')).auditoria;
  assert.match(a.detalle, /envío real.*HTTP 200/);
});

test('envío real fallido: se informa el error y el intento queda auditado como falla', async (t) => {
  const fhir = await servidorFhir(t, { falla: true });
  const srv = await iniciar({ env: { LLM_PROVIDER: 'mock', HCE_FHIR_URL: fhir.url, HCE_ENVIO: 'real' } });
  t.after(() => srv.detener());
  const { api, logsDir } = srv;
  await conDatos(api);
  await assert.rejects(api('/api/hce/export', { body: {} }), (e) => e.status === 400 && /422: Patient\/marta-001 no existe/.test(e.message));
  assert.equal(fhir.recibidos[0].headers.authorization, undefined, 'sin token configurado no se manda Authorization');
  const exp = (await api('/api/state')).exportaciones.at(-1);
  assert.equal(exp.estado, 'error');
  const [a] = (await api('/api/auditoria')).auditoria;
  assert.equal(a.evento, 'Envío a la HCE fallido');
  assert.equal(a.resultado, 'error');
  const ae = require('fs').readFileSync(require('path').join(logsDir, 'fhir', 'AuditEvent.ndjson'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(ae.outcome, '8');
  assert.doesNotMatch(JSON.stringify(ae), /marta-001/, 'el log sigue sin datos personales aunque el error los mencione');
});
