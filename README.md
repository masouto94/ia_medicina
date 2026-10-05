# Asistente IA de seguimiento entre consultas: simulador

Esta app simula el flujo propuesto en el trabajo *“Propuesta de un asistente conversacional basado en IA para la adherencia terapéutica y el seguimiento de pacientes”*. Usa el caso ilustrativo del trabajo: **Marta** (DM2 + HTA) y la **Dra. Lucía**, su médica de cabecera.

- **Izquierda: panel médico (web).** Desde acá se importa la HCE, se configura el asistente, se sigue a la paciente (panel), se consulta evidencia, se exporta a FHIR / CDS Hooks y se ven las trazas.
- **Derecha: canal de la paciente** (estilo WhatsApp). Admite texto, audio y subida de fotos o informes.

## Requisitos

- [Node.js](https://nodejs.org/) 18 o superior (LTS recomendado).
- Para usar **IA real**: [Claude Code](https://code.claude.com/docs/en/setup) instalado y con sesión iniciada con **tu suscripción de Claude** (Pro/Max). La app no usa ni guarda tokens: ejecuta el comando oficial `claude -p` en tu computadora y lee la respuesta, así que el consumo va a tu plan.
  ```bash
  claude          # la primera vez: iniciá sesión con tu cuenta de Claude y salí con /exit
  claude auth status   # debe decir "loggedIn": true
  ```
- Si el login de `claude` no persiste (pasa a veces en Git Bash), usá un token: ejecutá `claude setup-token`, copiá el token y pegalo en `.env` como `CLAUDE_CODE_OAUTH_TOKEN=...`. Ese token lo usa sólo el comando `claude`. **No compartas el `.env`** (ya está en `.gitignore`; si mandás el proyecto comprimido, excluilo).
- Sin Claude Code (o con `LLM_PROVIDER=mock`), la app funciona en **modo simulado** (reglas y respuestas predefinidas). También se puede usar una API key (`LLM_PROVIDER=api`).

## Cómo correrla

**Git Bash (Windows) o cualquier bash:**

```bash
cd /c/Users/masou/Dev/ia_medicina/asistente-dm2
./iniciar.sh
```

El script instala las dependencias la primera vez, crea `.env` y abre el navegador. Para frenar la app: `Ctrl+C`.

**Manual (bash):**

```bash
npm install
cp .env.example .env
# (opcional) editar .env: LLM_PROVIDER, CLAUDE_CODE_MODEL   (p. ej.: notepad .env)
npm start
```

**Alternativa sin bash:** doble clic en `iniciar.bat`.

Después abrí <http://localhost:3000>.

## Guion sugerido para la demo

1. **Importar datos de Marta** (HCE → mock FHIR `Patient/$everything`).
2. Revisar el formulario (horarios de toma, metas, umbrales, módulos DM2 + HTA, temas, nivel de lenguaje, canal) y **generar `lucia-marta-assistant`**.
3. En el chat de Marta, usar los chips o escribir. Cada mensaje muestra su **intención** (educativa / registro / adherencia / turno / derivación / alarma) y las **fuentes** usadas (RAG o OpenEvidence).
4. 📎 **Adjuntar** → *Archivos de prueba*: glucómetro, tensiómetro, blísteres, foto de lesión e informe de laboratorio en PDF. También se pueden subir fotos propias.
5. Con **⏭ Próxima toma** se envía el recordatorio, y Marta confirma u omite la toma.
6. Con **Simular 14 días** se generan datos de ejemplo para ver el panel completo: PDC, gráfico de glucemias, adherencia, alertas, derivaciones y sugerencias.
7. En **Panel → Generar resumen preconsulta** se crea el resumen, y desde ahí se responden las derivaciones.
8. En **HCE · FHIR · CDS Hooks** se descarga el Bundle y se simula la apertura del registro en la HCE (tarjetas CDS Hooks).
9. **Trazas del sistema** muestra el recorrido de cada interacción: seguridad → RAG → LLM → módulos → FHIR.

> Conviene usar “Simular 14 días” justo después de generar el asistente. **Reiniciar** borra todo.

## Qué es real y qué es mock

| Componente | Estado |
|---|---|
| Asistente especializado (intención, respuesta, lectura de fotos/PDF, resumen) | **Real**: Claude a través de Claude Code (`claude -p`, con tu suscripción) y salida JSON validada. Cada respuesta tarda ~5–8 s. Si falla, se usa el respaldo simulado. |
| Filtro de seguridad clínica | Real: reglas determinísticas que se ejecutan *antes* del LLM, más un doble control del modelo. |
| Base especializada por patología + RAG | Real (local): fragmentos DM2 y HTA en `knowledge/`, con recuperación tipo BM25. |
| Transcripción de audio | Real en el navegador (Web Speech API; Chrome o Edge). |
| HCE / servidor FHIR | **Mock** (`src/mocks/hce.js`) |
| OpenEvidence API | **Mock** (`src/mocks/openevidence.js`): respuestas predefinidas con citas reales; la consulta se anonimiza antes de enviarse. |
| WhatsApp Business | **Mock**: la interfaz simula el canal. |
| Agenda de turnos | **Mock** (`src/mocks/agenda.js`) |
| Exportación FHIR R4 y servicio CDS Hooks | Real (local): `GET /api/fhir/bundle`, `GET /cds-services`, `POST /cds-services/seguimiento-entre-consultas`. |

El motor activo se ve arriba, junto al título (“Motor IA: Claude Code · sonnet”). Si dice “Modo simulado”, pasá el mouse por encima para ver el motivo.

En **modo simulado**, el tipo de foto se deduce del **nombre del archivo** (por ejemplo, `glucometro_120.jpg` o `tensiometro_150_90.jpg`). Con IA real, se analiza la imagen.

## Estructura

```
server.js              API + archivos estáticos
src/assistant.js       pipeline: seguridad → RAG → LLM → registro/evidencia/derivación/turnos
src/vision.js          fotos e informes (registro, no diagnóstico)
src/safety.js          señales de alarma y umbrales
src/rag.js             recuperación sobre knowledge/*.json
src/clinic.js          observaciones, tomas, alertas, métricas (PDC)
src/fhir.js            Bundle FHIR R4 + CDS Hooks
src/seed.js            14 días de datos de ejemplo
src/mocks/             HCE, OpenEvidence, agenda
knowledge/             bases especializadas DM2 y HTA
muestras/              archivos de prueba (ficticios)
public/                interfaz
data/                  estado de la simulación (se crea solo)
```

*Prototipo académico. El contenido clínico es una adaptación simplificada para demostración, y todos los datos son ficticios.*
