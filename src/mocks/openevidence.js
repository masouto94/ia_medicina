// MOCK de la API de OpenEvidence.
// Devuelve respuestas predefinidas con citas bibliográficas, elegidas por palabras clave.
// La API real responde con síntesis de literatura médica y sus fuentes; aquí se simula ese contrato.
const { normalize, uid } = require('../util');

const ADA = {
  ref: 'American Diabetes Association Professional Practice Committee. Standards of Care in Diabetes—2025. Diabetes Care. 2025;48(Suppl 1).',
  url: 'https://diabetesjournals.org/care/issue/48/Supplement_1',
};

const RESPUESTAS = [
  {
    claves: ['sglt2', 'empagliflozina', 'dapagliflozina', 'glp', 'semaglutida', 'ozempic', 'liraglutida', 'otro remedio', 'otra medicacion', 'cambiar medicacion', 'cambiar la medicacion', 'cambiar el remedio', 'inyeccion', 'bajar de peso', 'agregar'],
    tema: 'Intensificación del tratamiento con iSGLT2 / arGLP-1',
    respuesta:
      'En adultos con DM2 que no alcanzan la meta de HbA1c con metformina, las guías recomiendan individualizar la intensificación. En presencia de enfermedad cardiovascular aterosclerótica, alto riesgo cardiovascular, insuficiencia cardíaca o enfermedad renal crónica, se prefiere agregar un inhibidor de SGLT2 o un agonista del receptor de GLP-1 con beneficio cardiovascular demostrado, con independencia de la HbA1c basal. Los arGLP-1 además favorecen el descenso de peso.',
    citas: [
      ADA,
      { ref: 'Zinman B, et al. Empagliflozin, cardiovascular outcomes, and mortality in type 2 diabetes. N Engl J Med. 2015;373:2117-2128.', url: 'https://doi.org/10.1056/NEJMoa1504720' },
      { ref: 'Marso SP, et al. Liraglutide and cardiovascular outcomes in type 2 diabetes. N Engl J Med. 2016;375:311-322.', url: 'https://doi.org/10.1056/NEJMoa1603827' },
    ],
    sugiere_cambio_tratamiento: true,
    resumen_para_paciente:
      'Existen otros medicamentos para la diabetes que, en algunas personas, se agregan a la metformina. Si te conviene o no lo decide tu médica según tu caso: ya le pasé tu consulta para que lo evalúe. Mientras tanto, seguí con tu tratamiento actual sin cambios.',
  },
  {
    claves: ['hba1c alta', 'hemoglobina glicosilada alta', 'no bajo', 'no baja', 'sigue alta', 'intensificar', 'aumentar dosis', 'subir la dosis', 'mas dosis'],
    tema: 'HbA1c por encima de la meta',
    respuesta:
      'Con HbA1c persistentemente por encima de la meta individual tras 3 meses de tratamiento, se recomienda evaluar adherencia, efectos adversos y barreras, y considerar la titulación de metformina hasta la dosis máxima tolerada o la combinación con un segundo fármaco según comorbilidades, riesgo de hipoglucemia, peso y acceso.',
    citas: [ADA, { ref: 'UK Prospective Diabetes Study (UKPDS) Group. Effect of intensive blood-glucose control with metformin on complications in overweight patients with type 2 diabetes (UKPDS 34). Lancet. 1998;352:854-865.', url: 'https://doi.org/10.1016/S0140-6736(98)07037-8' }],
    sugiere_cambio_tratamiento: true,
    resumen_para_paciente:
      'Que la hemoglobina glicosilada esté por encima de la meta es algo que tu médica revisa para decidir si hace falta ajustar el tratamiento. Le pasé tu consulta. No cambies las dosis por tu cuenta.',
  },
  {
    claves: ['tos', 'tos seca'],
    tema: 'Tos asociada a IECA',
    respuesta:
      'La tos seca es un efecto adverso frecuente de los inhibidores de la enzima convertidora (5-35%). Suele aparecer en las primeras semanas y resolver de 1 a 4 semanas tras la suspensión. Si es molesta, se recomienda reemplazar el IECA por un antagonista del receptor de angiotensina II.',
    citas: [{ ref: 'Dicpinigaitis PV. Angiotensin-converting enzyme inhibitor-induced cough: ACCP evidence-based clinical practice guidelines. Chest. 2006;129(1 Suppl):169S-173S.', url: 'https://doi.org/10.1378/chest.129.1_suppl.169S' }],
    sugiere_cambio_tratamiento: true,
    resumen_para_paciente:
      'La tos seca puede ser un efecto del enalapril. No lo suspendas por tu cuenta: le avisé a tu médica para que evalúe si conviene un cambio.',
  },
  {
    claves: ['olvide', 'olvido', 'dosis olvidada', 'me olvide', 'metformina', 'diarrea', 'nausea'],
    tema: 'Metformina: dosis olvidada y tolerancia digestiva',
    respuesta:
      'Ante una dosis olvidada de metformina se recomienda tomarla al recordarla con alimentos, salvo proximidad con la siguiente, sin duplicar. Los efectos gastrointestinales son dosis-dependientes y transitorios; la toma con comidas, la titulación lenta y las formulaciones de liberación prolongada mejoran la tolerancia.',
    citas: [ADA],
    sugiere_cambio_tratamiento: false,
    resumen_para_paciente:
      'Si olvidás una dosis, tomala cuando te acuerdes con algo de comida, salvo que falte poco para la siguiente. Nunca tomes doble dosis. Las molestias de estómago suelen mejorar tomándola con las comidas.',
  },
  {
    claves: ['hipoglucemia', 'baja', 'bajo', 'temblor', 'sudor', 'transpir', 'mareada', 'mareado'],
    tema: 'Manejo de la hipoglucemia',
    respuesta:
      'Para hipoglucemia nivel 1-2 en un paciente consciente, se recomiendan 15-20 g de glucosa (o hidratos de absorción rápida) y control a los 15 minutos, repitiendo si persiste. Con metformina en monoterapia el riesgo es bajo; ante episodios, revisar ayunos prolongados, alcohol y actividad física.',
    citas: [ADA],
    sugiere_cambio_tratamiento: false,
    resumen_para_paciente:
      'Si tu glucemia baja de 70 y estás consciente, tomá 15 g de azúcar rápida (3 cucharaditas en agua o medio vaso de jugo común), esperá 15 minutos y volvé a medir.',
  },
  {
    claves: ['pie', 'pies', 'herida', 'ulcera', 'hormigueo', 'neuropatia', 'ampolla'],
    tema: 'Prevención del pie diabético',
    respuesta:
      'Se recomienda la inspección diaria de los pies, la educación en autocuidado, el calzado adecuado y el examen anual con monofilamento. Toda lesión nueva en una persona con diabetes requiere evaluación profesional temprana.',
    citas: [{ ref: 'Bus SA, et al. Guidelines on the prevention of foot ulcers in persons with diabetes (IWGDF 2023 update). Diabetes Metab Res Rev. 2024;40(3):e3651.', url: 'https://iwgdfguidelines.org/' }, ADA],
    sugiere_cambio_tratamiento: false,
    resumen_para_paciente:
      'Revisá tus pies todos los días y avisá a tu médica ante cualquier herida, ampolla o cambio de color. Si tenés una lesión, podés mandarme una foto y se la hago llegar.',
  },
  {
    claves: ['ejercicio', 'caminar', 'actividad', 'gimnasio', 'deporte'],
    tema: 'Actividad física en DM2',
    respuesta:
      'Se recomiendan al menos 150 minutos semanales de actividad aeróbica de intensidad moderada, distribuidos en al menos 3 días, más 2-3 sesiones de ejercicio de fuerza, y reducir el sedentarismo.',
    citas: [{ ref: 'Colberg SR, et al. Physical activity/exercise and diabetes: a position statement of the American Diabetes Association. Diabetes Care. 2016;39:2065-2079.', url: 'https://doi.org/10.2337/dc16-1728' }],
    sugiere_cambio_tratamiento: false,
    resumen_para_paciente: 'Lo recomendado es sumar al menos 150 minutos de actividad por semana, por ejemplo caminar 30 minutos 5 días.',
  },
];

// Anonimiza la consulta antes de enviarla a un servicio externo
function anonimizar(texto) {
  return String(texto)
    .replace(/\b(marta|gonzalez|gonzález|lucia|lucía|fernandez|fernández)\b/gi, '[PERSONA]')
    .replace(/\+?\d[\d\s-]{7,}\d/g, '[NÚMERO]')
    .replace(/\b\d{1,2}\.?\d{3}\.?\d{3}\b/g, '[DNI]');
}

function consultar(pregunta, contexto = '') {
  const q = normalize(`${pregunta} ${contexto}`);
  let best = null;
  let bestScore = 0;
  for (const r of RESPUESTAS) {
    const score = r.claves.reduce((s, k) => s + (q.includes(normalize(k)) ? k.length : 0), 0);
    if (score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  const query = anonimizar(pregunta);
  if (!best) {
    return {
      id: uid('oe'),
      servicio: 'OpenEvidence API (MOCK)',
      query_anonimizada: query,
      encontrado: false,
      tema: 'Sin coincidencias en el mock',
      respuesta: 'El mock de OpenEvidence no tiene una respuesta predefinida para esta consulta. En la integración real, la API devolvería una síntesis de la literatura con sus citas.',
      citas: [ADA],
      sugiere_cambio_tratamiento: false,
      resumen_para_paciente: null,
    };
  }
  return {
    id: uid('oe'),
    servicio: 'OpenEvidence API (MOCK)',
    query_anonimizada: query,
    encontrado: true,
    tema: best.tema,
    respuesta: best.respuesta,
    citas: best.citas,
    sugiere_cambio_tratamiento: best.sugiere_cambio_tratamiento,
    resumen_para_paciente: best.resumen_para_paciente,
  };
}

module.exports = { consultar, anonimizar };
