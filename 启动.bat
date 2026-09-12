@echo off
rem ===========================================================================
rem  Steam Free Radar - one-click launcher
rem
rem  What it does:
rem    1. locate Node.js (>= 22.21)
rem    2. detect the accelerator proxy (e.g. Watt Toolkit) and save it to
rem       .env.proxy -- .env itself is never modified
rem    3. pick a free port if the default is taken
rem    4. start the service and open the browser
rem
rem  Why a separate proxy file: Node's built-in fetch ignores the Windows system
rem  proxy, and the proxy env vars must exist BEFORE the Node process starts
rem  (setting them at runtime does not work -- it just times out).
rem
rem  Options:
rem    --check   run the environment checks only, do not start
rem    --once    scrape one round and exit
rem
rem  NOTE: this file is ASCII-only on purpose. cmd.exe parses .bat using the
rem  ANSI codepage, so non-ASCII text makes the parser mis-read the script.
rem ===========================================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"
title Steam Free Radar

echo.
echo  ==========================================================
echo    Steam Free Radar - launcher
echo  ==========================================================
echo    dir: %CD%
echo.

rem ---------------------------------------------------------------------------
rem  1. find Node.js
rem ---------------------------------------------------------------------------
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files (x86)\nodejs\node.exe" set "NODE_EXE=C:\Program Files (x86)\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\nvm\node.exe" set "NODE_EXE=%APPDATA%\nvm\node.exe"
if not defined NODE_EXE goto NO_NODE

set "NODE_VER="
for /f "delims=" %%v in ('"%NODE_EXE%" -v 2^>nul') do set "NODE_VER=%%v"
set "NODE_NUMS=!NODE_VER:~1!"
for /f "delims=. tokens=1" %%v in ("!NODE_NUMS!") do set "NODE_MAJOR=%%v"
for /f "delims=. tokens=2" %%v in ("!NODE_NUMS!") do set "NODE_MINOR=%%v"
if not defined NODE_MINOR set "NODE_MINOR=0"
echo  [1/4] Node.js .................. !NODE_VER!  (!NODE_EXE!)
rem needs Node ^>= 22.21: --use-env-proxy landed in v22.21.0, --use-system-ca in v22.15.0
if !NODE_MAJOR! LSS 22 goto OLD_NODE
if !NODE_MAJOR! EQU 22 if !NODE_MINOR! LSS 21 goto OLD_NODE

rem ---------------------------------------------------------------------------
rem  2. proxy detection -> .env.proxy
rem ---------------------------------------------------------------------------
if not exist ".env" if exist ".env.example" copy /y ".env.example" ".env" >nul 2>&1

rem an explicit value in .env wins; an empty value means "auto detect"
call :ENV_GET PROXY_URL ENV_PROXY
call :ENV_GET PORT ENV_PORT

set "REG_PROXY="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer 2^>nul ^| findstr /i "ProxyServer"') do set "REG_PROXY=%%b"

set "REG_ON="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable 2^>nul ^| findstr /i "ProxyEnable"') do set "REG_ON=%%b"
set "REG_ON=!REG_ON: =!"
rem reg query returns DWORD values as 0x1 / 0x0
if /i "!REG_ON!"=="0x1" set "REG_ON=1"

if not "!ENV_PROXY!"=="" goto PROXY_READY
if not "!REG_ON!"=="1" goto PROXY_NONE
if "!REG_PROXY!"=="" goto PROXY_NONE

>".env.proxy" echo # auto-detected by the launcher - do not edit by hand
>>".env.proxy" echo PROXY_URL=http://!REG_PROXY!
echo  [2/4] proxy ................... detected !REG_PROXY!
echo         written to .env.proxy
goto PROXY_DONE

:PROXY_READY
echo  [2/4] proxy ................... using PROXY_URL from .env: !ENV_PROXY!
goto PROXY_DONE

:PROXY_NONE
echo  [2/4] proxy ................... not detected, will connect directly
echo         if Steam is unreachable, start your accelerator first, then re-run

:PROXY_DONE

rem ---------------------------------------------------------------------------
rem  3. port check
rem ---------------------------------------------------------------------------
set "PORT=!ENV_PORT!"
if "!PORT!"=="" set "PORT=8787"

set /a PORT_TRY=0
:PORT_LOOP
call :PORT_FREE !PORT!
if "!PORT_OK!"=="1" goto PORT_DONE
set /a PORT_TRY+=1
if !PORT_TRY! GEQ 20 goto PORT_FAIL
set /a PORT+=1
goto PORT_LOOP

:PORT_DONE
if not "!PORT!"=="8787" echo  [3/4] port .................... 8787 busy, using !PORT!
if "!PORT!"=="8787" echo  [3/4] port .................... !PORT!

if /i "%~1"=="--check" goto CHECK_ONLY

rem ---------------------------------------------------------------------------
rem  4. start
rem ---------------------------------------------------------------------------
set "URL=http://127.0.0.1:!PORT!/"
echo  [4/4] starting service ...
echo.
echo  ----------------------------------------------------------
echo    URL:   !URL!
echo    stop:  Ctrl+C in this window, or just close it
echo  ----------------------------------------------------------
echo.

start "" /b cmd /c "timeout /t 2 >nul & start "" "!URL!""

set "PORT=!PORT!"
"%NODE_EXE%" --use-system-ca "scripts\run.js" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" echo  service exited normally.
if not "%EXIT_CODE%"=="0" echo  service exited with code %EXIT_CODE%.
if not "%EXIT_CODE%"=="0" echo.
if not "%EXIT_CODE%"=="0" echo  common causes:
if not "%EXIT_CODE%"=="0" echo    - Steam unreachable: check the accelerator, see the "proxy" line
if not "%EXIT_CODE%"=="0" echo    - port in use: close the other program or set PORT in .env
echo.
pause
endlocal
exit /b %EXIT_CODE%

:CHECK_ONLY
echo.
echo  all checks passed. double-click this file to start the service.
echo.
pause
endlocal
exit /b 0

rem ===========================================================================
rem  subroutines
rem ===========================================================================

rem is the port free? -> PORT_OK=1 means free
:PORT_FREE
set "PORT_OK=0"
netstat -ano -p tcp 2>nul | findstr /i /c:"LISTENING" | findstr /c:":%~1 " >nul 2>&1
if errorlevel 1 set "PORT_OK=1"
goto :eof

rem read a key from .env:  call :ENV_GET KEY VARNAME
rem comment lines and blank lines are ignored
:ENV_GET
set "%~2="
if not exist ".env" goto :eof
for /f "usebackq tokens=1,* delims==" %%a in (".env") do call :ENV_GET_LINE "%%a" "%%b" "%~1" "%~2"
goto :eof

:ENV_GET_LINE
set "K=%~1"
if "!K:~0,1!"=="#" goto :eof
if "!K!"=="" goto :eof
if /i "!K!"=="%~3" set "%~4=%~2"
goto :eof

rem ===========================================================================
rem  error branches
rem ===========================================================================

:NO_NODE
echo.
echo  [ERROR] Node.js not found.
echo.
echo  This project needs Node.js 22.21 or newer.
echo  Get the LTS build from https://nodejs.org/ and tick "Add to PATH".
echo.
pause
endlocal
exit /b 1

:OLD_NODE
echo.
echo  [ERROR] Node.js too old: !NODE_VER!
echo  Version 22.21 or newer is required: https://nodejs.org/
echo.
pause
endlocal
exit /b 1

:PORT_FAIL
echo.
echo  [ERROR] 20 consecutive ports starting at %PORT% are all in use.
echo  Close the program holding them, or set PORT in .env.
echo.
pause
endlocal
exit /b 1
