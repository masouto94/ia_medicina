# Asistente IA de seguimiento entre consultas: simulador

Esta app simula el flujo propuesto en el trabajo *“Propuesta de un asistente conversacional basado en IA para la adherencia terapéutica y el seguimiento de pacientes”*. Usa el caso ilustrativo del trabajo: Marta (DM2 + HTA) y la Dra. Lucía, su médica de cabecera.

En una misma pantalla se ven los dos lados del sistema:

- **Izquierda: panel de la médica (web).** Desde acá se configura el asistente y se sigue a la paciente.
- **Derecha: el teléfono de la paciente** (WhatsApp simulado). Ahí Marta conversa con el asistente.

## Cómo funciona

La médica configura, durante la consulta, un asistente para cada paciente. Entre consultas, la paciente le escribe al asistente por WhatsApp. Cada mensaje pasa por estas etapas:

1. **Filtro de seguridad.** Antes de cualquier otra cosa, el mensaje se compara con las alarmas que configuró la médica: dolor de pecho, hemorragia, hipoglucemia grave y otras. Si alguna se dispara, el asistente no intenta resolver nada. Indica llamar a emergencias y avisa a la médica.
2. **Búsqueda de información validada.** Si no hay alarma, se buscan las indicaciones propias de la médica y los fragmentos de las guías de cada patología activa (DM2, HTA). Es lo que se llama RAG.
3. **Modelo de lenguaje.** Claude interpreta qué quiere la paciente (una duda, registrar un valor, pedir un turno, algo que tiene que ver la médica) y redacta la respuesta usando sólo esa información. Si detecta una urgencia que el filtro no vio, puede proponer una alarma, pero el sistema la acepta sólo si cumple todas estas condiciones:
   - corresponde a una alarma activa configurada por la médica;
   - está fundamentada en lo que dijo la paciente;
   - no usó fuentes externas ni conocimiento general.

   Si no las cumple, la consulta igual le llega a la médica con prioridad alta.
4. **Acciones.** Según el caso, el asistente responde, registra el valor o la toma de medicación, reserva un turno, consulta evidencia científica o deriva la consulta a la médica.

Todo lo que pasa queda disponible para la médica en su panel y se puede exportar a la historia clínica en formato estándar (HL7 FHIR).

```mermaid
flowchart TB
    HCE[("Historia clínica (HCE)")] -->|importa diagnósticos,<br/>medicación y laboratorio| CFG["<b>La médica configura el asistente</b><br/>horarios, metas, módulos,<br/>alarmas e indicaciones"]

    P(["<b>Paciente</b><br/>WhatsApp: texto, audio, fotos"]) -->|mensaje| F{"<b>1. Filtro de seguridad</b><br/>¿dispara alguna alarma?"}
    F -->|sí| U["<b>Protocolo de urgencia</b><br/>indica 107 / guardia<br/>y avisa a la médica"]
    F -->|no| R["<b>2. Búsqueda de información validada</b><br/>indicaciones de la médica +<br/>guías de cada patología"]
    R --> L["<b>3. Modelo de lenguaje (Claude)</b><br/>entiende el pedido y redacta<br/>con esa información"]
    L -->|urgencia que el filtro no vio| U
    L --> A["<b>4. Acciones</b><br/>responder · registrar valores y tomas<br/>turnos · evidencia · derivar"]
    A -->|respuesta| P
    U -->|indicación de urgencia| P

    CFG -. alarmas .-> F
    CFG -. indicaciones y módulos .-> R
    CFG -. temas y nivel de lenguaje .-> L

    U --> PM["<b>Panel de la médica</b><br/>alertas · derivaciones · adherencia<br/>resumen preconsulta"]
    A -->|registros y derivaciones| PM
    PM -->|responde derivaciones| P
    PM -->|exporta en HL7 FHIR| HCE
```

El asistente **no diagnostica, no cambia medicación y no reemplaza la consulta**. Lo que excede lo que la médica habilitó se deriva a ella.

## Guía de uso

### Para la médica (panel izquierdo)

1. **Importar los datos de la paciente.** En *1 · Configuración*, el botón **Importar datos de Marta** trae de la historia clínica los diagnósticos, la medicación y el último laboratorio.
2. **Configurar el asistente.** El formulario viene precargado y se puede ajustar:
   - **Medicación y horarios:** a esas horas el asistente le recuerda cada toma a la paciente.
   - **Metas y umbrales:** los valores objetivo y los que generan un aviso para la médica. Cada patología trae los suyos por defecto.
   - **Módulos:** las patologías que el asistente conoce (DM2, HTA). Se activan solos según los diagnósticos de la HCE.
   - **Temas habilitados:** lo que el asistente puede responder. Lo demás lo deriva a la médica.
   - **Comunicación:** el nivel de lenguaje (simple, intermedio o técnico) y el canal (WhatsApp o app).
   - **Indicaciones propias:** por ejemplo, "Caminar 30 minutos al menos 5 días por semana". Tienen prioridad sobre las guías generales.

   Al terminar, **Generar asistente**. Si se cambia algo después, **Guardar cambios**. Si cambian las indicaciones o los horarios, la paciente recibe un aviso.
3. **Alarmas.** Debajo del formulario está la lista de alarmas, con efecto inmediato:
   - **Pausar o reactivar** cualquier alarma con la tilde.
   - **Modificar:** cambiar las frases que la disparan, el valor límite o la indicación inmediata para la paciente.
   - **Agregar:** por frases ("fiebre alta", "escalofríos") o por umbral de una medición ("glucemia > 400").
   - **Eliminar:** sólo las que no son genéricas. Las genéricas (dolor torácico, hemorragia, ACV…) se pueden pausar, pero no eliminar.
4. **Seguir a la paciente.** En *2 · Panel de seguimiento*:
   - Indicadores de adherencia (proporción de días cubiertos, tomas confirmadas) y de control (glucemias en meta).
   - Gráfico de glucemias y grilla de tomas por día.
   - **Alertas** (valores fuera de rango, tomas omitidas): se marcan como vistas.
   - **Derivaciones:** las consultas que el asistente le pasó, con un resumen y, si corresponde, la foto. Se responden desde ahí y la respuesta le llega a la paciente.
   - **Sugerencias basadas en evidencia:** cuando una consulta implica un posible cambio de tratamiento, la evidencia llega sólo a la médica, nunca a la paciente.
   - **Resumen preconsulta:** un resumen del período para leer antes de la próxima visita.
5. **Evidencia.** Consultar literatura médica sobre el caso (OpenEvidence, simulado).
6. **HCE · FHIR · CDS Hooks.** Descargar todo lo registrado en formato FHIR y ver cómo aparecerían las alertas dentro de la historia clínica al abrir el registro de la paciente.
7. **Trazas del sistema.** Para cada mensaje, el recorrido que hizo: qué alarmas se evaluaron, qué información se usó, qué decidió el modelo y qué se registró.

### Para la paciente (teléfono)

- **Escribir** como en WhatsApp. Los botones de abajo traen mensajes de ejemplo.
- **Mandar un audio** con el micrófono. Se transcribe automáticamente en Chrome o Edge.
- **Mandar una foto o un PDF** con el clip:
  - del glucómetro o del tensiómetro: el valor queda registrado;
  - de un remedio: el asistente confirma si es el que tiene indicado;
  - de una lesión: no la analiza, se la envía a la médica;
  - de un análisis: guarda los valores para la médica.

  En *Archivos de prueba* hay ejemplos listos para usar.
- **Recordatorios:** a la hora de cada toma llega un aviso con los botones *Sí, la tomé* / *No la tomé*.
- **Turnos:** al pedir un turno, el asistente ofrece horarios y se elige uno con un toque.
- **Qué esperar:**
  - Las dudas sobre el tratamiento se responden con la información que validó la médica.
  - Lo que tiene que ver la médica se le deriva, y su respuesta llega por el mismo chat.
  - Ante una urgencia, el asistente indica llamar al 107 o ir a la guardia.

### Controles de la simulación (barra superior)

La barra superior permite manejar el tiempo de la simulación:

- **Reloj simulado:** la fecha y hora de la simulación.
- **⏭ Próxima toma:** adelanta el reloj hasta el próximo horario de medicación y envía el recordatorio.
- **+1 h:** adelanta una hora.
- **Simular 14 días:** genera dos semanas de seguimiento de ejemplo para ver el panel completo. Conviene usarlo justo después de generar el asistente.
- **Reiniciar:** borra todo y vuelve al inicio.

Arriba, junto al título, se ve qué motor de IA está activo ("Motor IA: Claude Code · sonnet" o "Modo simulado").

### Recorrido sugerido para una demo

1. Importar los datos de Marta y generar el asistente.
2. Desde el teléfono, probar algunos chips: una dosis olvidada, un valor de glucemia, un pedido de turno o la pregunta por Ozempic.
3. Adjuntar archivos de prueba, por ejemplo el glucómetro con 48 (dispara la alarma) o el informe de laboratorio.
4. Pausar una alarma y repetir el mensaje para ver la diferencia.
5. Usar **Simular 14 días** y recorrer el panel: responder una derivación y generar el resumen preconsulta.
6. Exportar el Bundle FHIR y simular la apertura en la HCE.
7. Mirar las **Trazas del sistema** para explicar cómo se procesó cada mensaje.

---

# Instalación y detalles técnicos

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior (LTS recomendado).
- Token de claude code que se guarda en el `.env` bajo `CLAUDE_CODE_OAUTH_TOKEN=...`. Si no se provee, se corre una versión simulada pero sin interacción con ningún llm 

## Cómo correrla

### Vía script de inicialización de bash

```bash
./iniciar.sh
```

El script instala las dependencias la primera vez, crea `.env` y abre el navegador. Para frenar la app: `Ctrl+C`.

### Manualmente

Desde la terminal de windows se puede correr

```bash
cp .env.example .env
npm install 
node server.js
```


## Tests

```bash
npm test logic        # sin LLM: rápido (~2 s), determinístico
npm test generative   # con el LLM real configurado (Claude Code o API key): ~2-4 min
```

| Suite | Qué prueba |
|---|---|
| `logic` | Los tests están en `tests/logic/`: alarmas (frases, negación, umbrales, pausar, modificar, agregar, eliminar), guardrails (12 propuestas del modelo, 2 válidas y 10 tramposas), módulos (incluye una patología nueva agregada sólo con un JSON) y el recorrido completo de la app por la API. El recorrido corre en modo simulado y con un "Claude falso" (`tests/fixtures/fake-claude.js`) que devuelve respuestas tramposas a propósito. |
| `generative` | `tests/generative/casos.json`: 14 casos clínicos contra el asistente con Claude real. Para cada paso se indica lo esperado: alarma sí/no y su origen, intención, derivación y prioridad, registro, fuente citada y consulta de evidencia. Al final informa la sensibilidad y los falsos positivos de las alarmas, y guarda el detalle en `tests/resultados/`. |

Los tests usan una carpeta de estado temporal y un puerto propio, así que no tocan la demo en `data/`. La suite `generative` no es determinística; para ver la variabilidad se puede repetir cada caso: `GENERATIVE_REPEAT=3 npm test generative`. La guía completa para correr, crear, modificar y validar tests está en [`tests/README.md`](tests/README.md).

## Qué es real y qué es mock

| Componente | Estado |
|---|---|
| Asistente especializado (intención, respuesta, lectura de fotos/PDF, resumen) | **Real**: Claude a través de Claude Code (`claude -p`, con tu suscripción) y salida JSON validada. Cada respuesta tarda ~5–8 s. Si falla, se usa el respaldo simulado. |
| Filtro de seguridad clínica | **Real**: alarmas configurables que se evalúan *antes* del LLM (primera capa, determinística), más un doble control del modelo (segunda capa) con guardrails en `src/guardrails.js`: el modelo sólo puede proponer alarmas activas, fundamentadas en el mensaje, con fuentes de la configuración o del RAG, con umbrales verificados y sin consultar OpenEvidence. Aplica a mensajes y a fotos. Las genéricas están en `knowledge/alarmas_genericas.json`. Desde *Configuración → Alarmas* la médica puede pausarlas, modificarlas, agregar nuevas o eliminar las que no son genéricas. |
| Base especializada por patología + RAG | **Real**: fragmentos DM2 y HTA en `knowledge/`, con recuperación tipo BM25. |
| Transcripción de audio | **Real** en el navegador (Web Speech API; Chrome o Edge). |
| HCE / servidor FHIR | **Mock** (`src/mocks/hce.js`) |
| OpenEvidence API | **Mock** (`src/mocks/openevidence.js`): respuestas predefinidas con citas reales; la consulta se anonimiza antes de enviarse. |
| WhatsApp Business | **Mock**: la interfaz simula el canal. |
| Agenda de turnos | **Mock** (`src/mocks/agenda.js`) |
| Exportación FHIR R4 y servicio CDS Hooks | **Real**: `GET /api/fhir/bundle`, `GET /cds-services`, `POST /cds-services/seguimiento-entre-consultas`. Terminologías: SNOMED CT en diagnósticos, medicación (también en `MedicationStatement`) y motivos de derivación (`Communication.reasonCode`); LOINC en observaciones; UCUM en todas las unidades. Los códigos están en `knowledge/terminologia.json` y en cada alarma; ver [Origen de los códigos](#origen-de-los-códigos-de-terminología). |

Si el indicador del motor dice "Modo simulado", al pasar el mouse por encima se ve el motivo.

En modo simulado, el tipo de foto se deduce del nombre del archivo (por ejemplo, `glucometro_120.jpg` o `tensiometro_150_90.jpg`). Con IA real, se analiza la imagen.

## Origen de los códigos de terminología

Los códigos SNOMED CT del export FHIR **no salen de un servidor de terminología oficial**. Durante el desarrollo no hubo acceso a uno, así que cada código se confirmó a mano el 08/10/2026, buscándolo en estas páginas públicas:

| Código SNOMED CT | Concepto | Página consultada |
|---|---|---|
| 29857009 | Chest pain | [tx.fhir.org](https://tx.fhir.org) (servidor de terminología público de HL7) |
| 267036007 | Dyspnea | [FindACode](https://www.findacode.com/snomed/267036007--dyspnea.html) |
| 131148009 | Bleeding | [FindACode](https://www.findacode.com/snomed/131148009--bleeding.html) |
| 386661006 | Fever | [FindACode](https://www.findacode.com/snomed/386661006--fever.html) |
| 11429006 | Consultation | [FindACode](https://www.findacode.com/snomed/11429006--consultation.html) |
| 419045004 | Loss of consciousness | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=419045004) |
| 91175000 | Seizure | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=91175000) |
| 230690007 | Cerebrovascular accident | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=230690007) |
| 41291007 | Angioedema | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=41291007) |
| 286933003 | Confusional state | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=286933003) |
| 302866003 | Hypoglycemia | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=302866003) |
| 80394007 | Hyperglycemia | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=80394007) |
| 24184005 | Finding of increased blood pressure | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=24184005) |
| 91019004 | Paresthesia | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=91019004) |
| 416462003 | Wound | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=416462003) |
| 49727002 | Cough | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=49727002) |
| 281647001 | Adverse reaction | [BioPortal](https://bioportal.bioontology.org/ontologies/SNOMEDCT?p=classes&conceptid=281647001) |
| 182836005 | Review of medication | [OpenCodelists](https://www.opencodelists.org/codelist/opensafely/medication-reviews-all-types/69f99fda/) |
| 372567009 | Metformin (substance) | [CH EMED, ValueSet ActivePharmaceuticalIngredient](https://fhir.ch/ig/ch-emed/ValueSet-ActivePharmaceuticalIngredient.html) y [FindACode](https://www.findacode.com/snomed/372567009--metformin.html) |
| 372658000 | Enalapril (substance) | [CH EMED, ValueSet ActivePharmaceuticalIngredient](https://fhir.ch/ig/ch-emed/ValueSet-ActivePharmaceuticalIngredient.html) |

Algunos códigos **no se verificaron en esta etapa**:

- **SNOMED CT de los diagnósticos del mock de la HCE:** 44054006 (diabetes tipo 2) y 38341003 (hipertensión).
- **LOINC de las observaciones:** por ejemplo 4548-4 HbA1c, 2339-0 glucemia y 85354-9 presión arterial.
- **Unidades UCUM:** mg/dL, mm[Hg] y %.

Son códigos de uso muy difundido, pero se cargaron sin consultar una fuente durante el desarrollo.

> Antes de cualquier uso real, todos los códigos tienen que validarse contra la **edición nacional vigente** de SNOMED CT (y LOINC/UCUM) con un servidor de terminología oficial, por ejemplo con la operación `$validate-code`. Las páginas consultadas son secundarias, y la edición internacional o la de EE. UU. que muestran puede diferir de la nacional.

## Cómo agregar una patología (sin tocar código)

Cada módulo es un archivo `knowledge/<id>.json` con dos partes:

- `fragmentos`: el conocimiento validado que usa el RAG.
- `configuracion`: los valores por defecto de la patología, que la médica después ajusta por paciente.
  - `variables`: las mediciones, con unidad, UCUM y LOINC.
  - `metas`, `umbrales` y `alertas`: los avisos no urgentes a la médica.
  - `alarmas`: el protocolo de urgencia.
  - `instruccionesModelo`: pautas para el modelo, que pueden usar `{umbrales.x}` y `{metas.x}`.

El campo `snomed` indica para qué diagnósticos de la HCE se activa el módulo por defecto. Al copiar `dm2.json` o `hta.json` como plantilla y reiniciar la app, el módulo nuevo aparece en el panel con sus campos y sus alarmas.

## Estructura

```
server.js              API + archivos estáticos
src/assistant.js       pipeline: seguridad → RAG → LLM → registro/evidencia/derivación/turnos
src/vision.js          fotos e informes (registro, no diagnóstico)
src/safety.js          señales de alarma y umbrales
src/modulos.js         carga los módulos (conocimiento + configuración por patología)
src/alarmas.js         alarmas configurables (genéricas + módulos + médica)
src/guardrails.js      validación de las alarmas que propone el modelo (segunda capa)
src/rag.js             recuperación sobre los fragmentos de los módulos
src/clinic.js          observaciones, tomas, alertas, métricas (PDC)
src/fhir.js            Bundle FHIR R4 + CDS Hooks
src/terminologia.js    SNOMED CT y UCUM para el export
src/seed.js            14 días de datos de ejemplo
src/mocks/             HCE, OpenEvidence, agenda
knowledge/             módulos DM2 y HTA + alarmas genéricas + terminologías (SNOMED CT, UCUM)
muestras/              archivos de prueba (ficticios)
public/                interfaz
tests/                 tests (npm test logic | generative)
data/                  estado de la simulación (se crea solo)
```

*Prototipo académico. El contenido clínico es una adaptación simplificada para demostración, y todos los datos son ficticios.*
