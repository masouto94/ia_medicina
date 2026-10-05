#!/usr/bin/env bash
# Inicia el simulador desde Git Bash (Windows) o cualquier bash.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instalalo desde https://nodejs.org/ (versión LTS) y reabrí Git Bash."
  exit 1
fi

[ -d node_modules ] || { echo "Instalando dependencias..."; npm install; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creó .env (motor: Claude Code con tu suscripción)."
fi

# Si el token de Claude Code está en .env, se usa también para esta verificación
TOKEN=$(grep -E '^CLAUDE_CODE_OAUTH_TOKEN=' .env | cut -d= -f2- | tr -d '\r"')
[ -n "$TOKEN" ] && export CLAUDE_CODE_OAUTH_TOKEN="$TOKEN"

if command -v claude >/dev/null 2>&1; then
  claude auth status >/dev/null 2>&1 || echo "Aviso: Claude Code no tiene sesión iniciada. Ejecutá 'claude' e iniciá sesión; mientras tanto la app usa el modo simulado."
else
  echo "Aviso: no se encontró Claude Code ('claude'). La app va a usar el modo simulado."
fi

PORT=$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '\r')
URL="http://localhost:${PORT:-3000}"

# Abre el navegador unos segundos después de iniciar el servidor
( sleep 3
  if command -v cmd.exe >/dev/null 2>&1; then cmd.exe //c start "" "$URL" >/dev/null 2>&1
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  elif command -v open >/dev/null 2>&1; then open "$URL"; fi ) &

npm start
