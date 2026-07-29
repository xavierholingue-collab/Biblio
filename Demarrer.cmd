@echo off
setlocal
title Ma bibliotheque - demarrage
cd /d "%~dp0"

if not exist ".env" (
  echo.
  echo   Le fichier .env est absent.
  echo   Copiez .env.exemple en .env, remplissez-le, puis relancez ce script.
  echo.
  pause
  exit /b 1
)

docker version >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Docker ne repond pas. Lancez Docker Desktop et attendez qu'il soit pret.
  echo.
  pause
  exit /b 1
)

echo.
echo   Demarrage des conteneurs...
docker compose up -d --build
if errorlevel 1 (
  echo.
  echo   Le demarrage a echoue. Le detail est ci-dessus.
  pause
  exit /b 1
)

echo.
echo   Attente de l'API...
set /a n=0
:attente
set /a n+=1
curl -s -o nul http://localhost:8080/api/sante && goto pret
if %n% geq 60 goto trop_long
timeout /t 1 /nobreak >nul
goto attente

:trop_long
echo   L'API ne repond toujours pas. Regardez les journaux :
echo     docker compose logs api
pause
exit /b 1

:pret
echo   Pret.
start http://localhost:8080/
echo.
echo   L'application tourne en arriere-plan, meme si vous fermez cette fenetre.
echo   Pour l'arreter : Arreter.cmd
echo.
timeout /t 5 /nobreak >nul
