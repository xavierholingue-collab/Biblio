@echo off
setlocal
title Ma bibliotheque - sauvegarde
cd /d "%~dp0"

for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set HORODATAGE=%%d
set FICHIER=sauvegardes\biblio_%HORODATAGE%.sql

echo.
echo   Sauvegarde vers %FICHIER%
docker compose exec -T db pg_dump -U biblio -d biblio > "%FICHIER%"
if errorlevel 1 (
  echo   Echec. Les conteneurs sont-ils demarres ?
  pause
  exit /b 1
)

for %%A in ("%FICHIER%") do echo   Termine : %%~zA octets.

rem On ne garde que les trente sauvegardes les plus recentes.
powershell -NoProfile -Command ^
  "Get-ChildItem 'sauvegardes\biblio_*.sql' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 30 | Remove-Item -Force"

echo.
timeout /t 4 /nobreak >nul
