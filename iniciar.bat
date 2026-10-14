@echo off
rem Inicia el simulador ATIA en Windows: doble clic sobre este archivo (o "iniciar.bat" desde CMD/PowerShell).
rem Equivale a iniciar.sh: instala dependencias la primera vez, crea .env, verifica Claude Code y abre el navegador.
setlocal EnableExtensions
cd /d "%~dp0"
title ATIA - simulador

where node >nul 2>nul
if errorlevel 1 goto sin_node

if not exist "node_modules\" (
  echo Instalando dependencias, puede tardar un minuto...
  call npm install
  if errorlevel 1 goto fallo_npm
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Se creo .env a partir de .env.example. Pone tu CLAUDE_CODE_OAUTH_TOKEN ahi para usar IA real.
)

rem Lee el token de Claude Code y el puerto de .env
set "PUERTO=3000"
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="CLAUDE_CODE_OAUTH_TOKEN" if not "%%~B"=="" set "CLAUDE_CODE_OAUTH_TOKEN=%%~B"
  if /i "%%A"=="PORT" if not "%%~B"=="" set "PUERTO=%%~B"
)

where claude >nul 2>nul
if errorlevel 1 goto sin_claude
call claude auth status >nul 2>nul
if errorlevel 1 echo Aviso: Claude Code no tiene sesion iniciada ni token valido. La app va a usar el modo simulado.
goto arrancar

:sin_claude
echo Aviso: no se encontro Claude Code ^(comando claude^). La app va a usar el modo simulado.

:arrancar
echo.
echo   ATIA en http://localhost:%PUERTO%   ^(para frenarla: Ctrl+C o cerrar esta ventana^)
echo.
rem Abre el navegador unos segundos despues de iniciar el servidor
start "" /b cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:%PUERTO%"
call npm start
if errorlevel 1 (
  echo.
  echo La app se cerro con un error. Revisa los mensajes de arriba.
  pause
)
exit /b

:sin_node
echo No se encontro Node.js. Instalalo desde https://nodejs.org/ ^(version LTS^) y volve a abrir este archivo.
pause
exit /b 1

:fallo_npm
echo No se pudieron instalar las dependencias. Revisa la conexion a internet y volve a intentar.
pause
exit /b 1
