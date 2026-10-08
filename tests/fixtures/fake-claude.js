#!/usr/bin/env node
// "Claude falso" para los tests de lógica: reemplaza al comando `claude` (CLAUDE_CODE_BIN=tests/fixtures/fake-claude.js).
// Devuelve respuestas fijas, algunas tramposas a propósito, según una marca en el mensaje (CASO_...).
// Así se prueba todo el recorrido de la app (servidor, filtro, guardrails, derivación) sin depender de un modelo real.
const fs = require('fs');

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (Claude falso para tests)');
  process.exit(0);
}
if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' }));
  process.exit(0);
}

const i = args.indexOf('--system-prompt-file');
const system = i >= 0 ? fs.readFileSync(args[i + 1], 'utf8') : '';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const salida = (obj) => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: typeof obj === 'string' ? obj : JSON.stringify(obj) }));
  const msg = input.split('NUEVO MENSAJE DE MARTA').pop();

  // Análisis de archivos (módulo de visión)
  if (system.includes('módulo multimodal')) {
    const base = { legible: true, respuesta_para_paciente: 'Registrado (respuesta de prueba).', nota_para_medico: 'nota de prueba' };
    if (/glucometro_48/.test(input)) {
      const alarma = /CASO_VISION_INVENTADA/.test(input) ? { es_alarma: true, regla_id: 'sepsis-grave', fundamento: 'valor muy bajo', fuentes: ['CONFIG'] } : { es_alarma: false };
      return salida({ ...base, tipo: 'glucometro', glucemia_mg_dl: 48, alarma });
    }
    return salida({ ...base, tipo: 'otro', legible: false, alarma: { es_alarma: false } });
  }
  // Reformulación de evidencia
  if (system.includes('comunicar_a_medico')) return salida({ respuesta: 'Reformulado (respuesta de prueba).', comunicar_a_medico: true });
  // Resumen preconsulta (texto libre)
  if (!system.includes('"intencion"')) return salida('Resumen de prueba.');

  // Respuesta al mensaje de la paciente. Incluye un consejo indebido para verificar que no llegue si la alarma se rechaza.
  const base = { intencion: 'educativa', tema: 'prueba', respuesta: 'Respuesta de prueba. Tomá una aspirina.', fuentes_usadas: [], requiere_evidencia: false, registro: { tipo: 'ninguno' }, derivar: { necesario: false }, alarma: { es_alarma: false } };
  const alarma = (a) => salida({ ...base, intencion: 'alarma', alarma: { es_alarma: true, ...a } });
  if (/CASO_VALIDA/.test(msg)) return alarma({ regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['CONFIG'] });
  if (/CASO_INVENTADA/.test(msg)) return alarma({ regla_id: 'sepsis-grave', fundamento: 'fiebre y escalofrios', fuentes: ['CONFIG'] });
  if (/CASO_OE/.test(msg)) return salida({ ...base, intencion: 'alarma', requiere_evidencia: true, alarma: { es_alarma: true, regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene', fuentes: ['OpenEvidence'] } });
  if (/CASO_PAUSADA/.test(msg)) return alarma({ regla_id: 'gen-dolor-toracico', fundamento: 'me molesta el pecho', fuentes: ['CONFIG'] });
  if (/CASO_UMBRAL_FALSO/.test(msg)) return alarma({ regla_id: 'dm2-hipo-grave', fundamento: 'glucemia baja', valor: 40, fuentes: ['CONFIG'] });
  if (/CASO_SIN_FUENTES/.test(msg)) return alarma({ regla_id: 'gen-hemorragia', fundamento: 'la sangre no se detiene' });
  if (/CASO_EVIDENCIA/.test(msg)) return salida({ ...base, intencion: 'derivacion', requiere_evidencia: true });
  return salida(base);
});
