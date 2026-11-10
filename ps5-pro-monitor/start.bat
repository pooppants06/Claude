@echo off
rem PS5 Pro-vakten - oppstart for Windows. Dobbeltklikk for a starte.
rem Ekstra argumenter sendes videre, f.eks.:  start.bat once   eller   start.bat test-notify
setlocal
cd /d "%~dp0"
chcp 65001 >nul

set "PY=python"
where py >nul 2>nul && set "PY=py -3"
%PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto nopython

if exist ".venv\Scripts\python.exe" goto havevenv
echo Setter opp Python-miljo. Dette gjores bare forste gang ...
%PY% -m venv .venv
if errorlevel 1 goto nopython
".venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r requirements.txt
if errorlevel 1 goto pipfailed
:havevenv

if exist "config.toml" goto run
copy /y "config.example.toml" "config.toml" >nul
echo.
echo Opprettet config.toml. Lim inn Discord-webhook eller Telegram-bot i filen som apnes na,
echo lagre, og start start.bat pa nytt.
start "" notepad "config.toml"
goto end

:run
".venv\Scripts\python.exe" -m ps5monitor %*
set "CODE=%errorlevel%"
if not "%~1"=="" goto end
if "%CODE%"=="0" goto end
if "%CODE%"=="2" goto end
echo.
echo Programmet stoppet uventet, kode %CODE%. Starter pa nytt om 15 sekunder. Ctrl+C avbryter.
timeout /t 15 /nobreak >nul
goto run

:nopython
echo.
echo Fant ikke Python 3.11 eller nyere. Installer fra https://www.python.org/downloads/
echo og huk av for "Add python.exe to PATH" i installasjonen.
goto end

:pipfailed
echo.
echo Klarte ikke a installere avhengighetene. Sjekk internettforbindelsen og prov igjen.
rmdir /s /q .venv

:end
echo.
pause
