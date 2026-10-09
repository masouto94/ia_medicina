// Envío de los datos a la HCE institucional (servidor HL7 FHIR R4).
//
// .env:
//   HCE_FHIR_URL     URL base del servidor FHIR de la HCE (por defecto https://hce.institucion.ar/fhir, ficticia)
//   HCE_ENVIO        "simulado" (por defecto: no sale ningún pedido) o "real" (POST del Bundle a HCE_FHIR_URL)
//   HCE_FHIR_TOKEN   opcional: token Bearer para el servidor (en producción, SMART Backend Services / OAuth2)
//
// El envío es un Bundle `transaction` con PUT <Tipo>/<id>: el servidor lo aplica entero o no aplica nada, y si se
// envía dos veces actualiza los mismos recursos en lugar de duplicarlos.
const URL_HCE = String(process.env.HCE_FHIR_URL || 'https://hce.institucion.ar/fhir').trim().replace(/\/+$/, '');
const MODO = String(process.env.HCE_ENVIO || 'simulado').trim().toLowerCase() === 'real' ? 'real' : 'simulado';
const TOKEN = process.env.HCE_FHIR_TOKEN ? String(process.env.HCE_FHIR_TOKEN).trim() : '';
const TIMEOUT_MS = Number(process.env.HCE_TIMEOUT_MS) || 30000;

function info() {
  return { url: URL_HCE, modo: MODO, autenticacion: TOKEN ? 'token Bearer' : 'ninguna' };
}

/** Envía un Bundle transaction. Devuelve { modo, estado, aceptados, rechazados, http }. Lanza un error si el servidor lo rechaza. */
async function enviar(bundle) {
  const n = bundle.entry.length;
  if (MODO === 'simulado') return { modo: MODO, estado: 'simulado', aceptados: n, rechazados: 0, http: null };
  let res;
  try {
    res = await fetch(URL_HCE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify(bundle),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`no se pudo conectar con ${URL_HCE} (${e.cause ? e.cause.code || e.cause.message : e.message})`);
  }
  const txt = await res.text();
  let cuerpo = null;
  try {
    cuerpo = JSON.parse(txt);
  } catch {}
  if (!res.ok) {
    const issue = cuerpo && cuerpo.resourceType === 'OperationOutcome' && cuerpo.issue && cuerpo.issue[0];
    throw new Error(`el servidor respondió ${res.status}${issue ? `: ${issue.diagnostics || (issue.details && issue.details.text) || issue.code}` : ''}`);
  }
  const estados = cuerpo && Array.isArray(cuerpo.entry) ? cuerpo.entry.map((e) => String((e.response && e.response.status) || '')) : [];
  const aceptados = estados.filter((s) => /^2/.test(s)).length;
  return { modo: MODO, estado: 'enviado', aceptados: estados.length ? aceptados : n, rechazados: estados.length ? estados.length - aceptados : 0, http: res.status };
}

module.exports = { info, enviar, URL_HCE };
