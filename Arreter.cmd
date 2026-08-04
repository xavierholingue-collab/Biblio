@echo off
title Ma bibliotheque - arret
cd /d "%~dp0"
echo.
echo   Arret des conteneurs. Vos donnees sont conservees.
docker compose down
echo.
echo   Termine.
timeout /t 4 /nobreak >nul
