// MOCK de la historia clínica electrónica (servidor HL7 FHIR R4).
// Simula la respuesta de GET [base]/Patient/marta-001/$everything
const PATIENT_ID = 'marta-001';
const PRACTITIONER_ID = 'lucia-001';

function everything() {
  return {
    resourceType: 'Bundle',
    type: 'searchset',
    meta: { source: 'HCE institucional (MOCK)', lastUpdated: '2026-10-01T12:00:00-03:00' },
    entry: [
      {
        resource: {
          resourceType: 'Patient',
          id: PATIENT_ID,
          identifier: [{ system: 'http://www.renaper.gob.ar/dni', value: '14.XXX.XXX' }],
          name: [{ given: ['Marta'], family: 'González' }],
          gender: 'female',
          birthDate: '1964-03-12',
          telecom: [{ system: 'phone', value: '+54 9 11 5555-0000', use: 'mobile' }],
          communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'es-AR' }] } }],
          generalPractitioner: [{ reference: `Practitioner/${PRACTITIONER_ID}`, display: 'Dra. Lucía Fernández' }],
        },
      },
      {
        resource: {
          resourceType: 'Practitioner',
          id: PRACTITIONER_ID,
          name: [{ prefix: ['Dra.'], given: ['Lucía'], family: 'Fernández' }],
          qualification: [{ code: { text: 'Medicina general y familiar' } }],
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: 'cond-dm2',
          subject: { reference: `Patient/${PATIENT_ID}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006', display: 'Diabetes mellitus tipo 2' }], text: 'Diabetes mellitus tipo 2' },
          onsetDateTime: '2019-05-20',
        },
      },
      {
        resource: {
          resourceType: 'Condition',
          id: 'cond-hta',
          subject: { reference: `Patient/${PATIENT_ID}` },
          clinicalStatus: { coding: [{ code: 'active' }] },
          code: { coding: [{ system: 'http://snomed.info/sct', code: '38341003', display: 'Hipertensión arterial' }], text: 'Hipertensión arterial' },
          onsetDateTime: '2021-08-02',
        },
      },
      {
        resource: {
          resourceType: 'MedicationRequest',
          id: 'medreq-metformina',
          status: 'active',
          intent: 'order',
          subject: { reference: `Patient/${PATIENT_ID}` },
          medicationCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '372567009', display: 'Metformin' }], text: 'Metformina 850 mg comprimidos' },
          dosageInstruction: [{ text: '1 comprimido cada 12 horas, con desayuno y cena', timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } } }],
        },
      },
      {
        resource: {
          resourceType: 'MedicationRequest',
          id: 'medreq-enalapril',
          status: 'active',
          intent: 'order',
          subject: { reference: `Patient/${PATIENT_ID}` },
          medicationCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '372658000', display: 'Enalapril' }], text: 'Enalapril 10 mg comprimidos' },
          dosageInstruction: [{ text: '1 comprimido por la mañana', timing: { repeat: { frequency: 1, period: 1, periodUnit: 'd' } } }],
        },
      },
      obs('lab-hba1c', '4548-4', 'Hemoglobina A1c', 7.9, '%', '2026-07-10'),
      obs('lab-glu', '1558-6', 'Glucemia en ayunas', 156, 'mg/dL', '2026-07-10'),
      obs('lab-crea', '2160-0', 'Creatinina', 0.9, 'mg/dL', '2026-07-10'),
      obs('lab-ldl', '13457-7', 'Colesterol LDL', 128, 'mg/dL', '2026-07-10'),
      {
        resource: {
          resourceType: 'Observation',
          id: 'vs-pa',
          status: 'final',
          code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Presión arterial' }] },
          subject: { reference: `Patient/${PATIENT_ID}` },
          effectiveDateTime: '2026-09-15',
          component: [
            { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Sistólica' }] }, valueQuantity: { value: 138, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
            { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastólica' }] }, valueQuantity: { value: 86, unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } },
          ],
        },
      },
    ],
  };
}

function obs(id, loinc, display, value, unit, date) {
  return {
    resource: {
      resourceType: 'Observation',
      id,
      status: 'final',
      category: [{ coding: [{ code: 'laboratory' }] }],
      code: { coding: [{ system: 'http://loinc.org', code: loinc, display }], text: display },
      subject: { reference: `Patient/${PATIENT_ID}` },
      effectiveDateTime: date,
      valueQuantity: { value, unit, system: 'http://unitsofmeasure.org', code: unit },
    },
  };
}

// Convierte el Bundle FHIR en un resumen legible para precargar el formulario
function toSummary(bundle) {
  const res = bundle.entry.map((e) => e.resource);
  const p = res.find((r) => r.resourceType === 'Patient');
  const pr = res.find((r) => r.resourceType === 'Practitioner');
  const edad = 2026 - Number(p.birthDate.slice(0, 4)) - (p.birthDate.slice(5) > '10-05' ? 1 : 0);
  return {
    paciente: { id: p.id, nombre: `${p.name[0].given[0]} ${p.name[0].family}`, edad, sexo: 'F', telefono: p.telecom[0].value },
    medico: { id: pr.id, nombre: 'Dra. Lucía Fernández' },
    diagnosticos: res.filter((r) => r.resourceType === 'Condition').map((c) => ({ codigo: c.code.coding[0].code, texto: c.code.text, desde: c.onsetDateTime })),
    medicacion: res
      .filter((r) => r.resourceType === 'MedicationRequest')
      .map((m) => ({ id: m.id, nombre: m.medicationCodeableConcept.text, indicacion: m.dosageInstruction[0].text })),
    laboratorio: res
      .filter((r) => r.resourceType === 'Observation' && r.valueQuantity)
      .map((o) => ({ codigo: o.code.coding[0].code, nombre: o.code.text, valor: o.valueQuantity.value, unidad: o.valueQuantity.unit, fecha: o.effectiveDateTime })),
    presion: { sistolica: 138, diastolica: 86, fecha: '2026-09-15' },
  };
}

module.exports = { everything, toSummary, PATIENT_ID, PRACTITIONER_ID };
