@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Builds the Telinha installer (pure Go, no cgo).
rem
rem   installer\build.cmd [version] [fast]
rem
rem Output (repo root):
rem   dist\installer\TelinhaInstaller.exe      GUI build (-H windowsgui): what users double-click
rem   dist\installer\TelinhaInstaller-cli.exe  console build of the same program, for scripts and testing
rem
rem "fast" skips go vet / go test. Icon, manifest and version resource come from the checked-in
rem rsrc_windows_*.syso; to change them edit winres\winres.json and run (needs network once):
rem   go run github.com/tc-hib/go-winres@v0.3.3 make --in winres/winres.json --arch amd64,arm64 --out rsrc
setlocal
cd /d "%~dp0"

set "VER=%~1"
if "%VER%"=="" set "VER=0.1.0"
if /i "%VER%"=="fast" (set "VER=0.1.0" & set "FAST=1")
if /i "%~2"=="fast" set "FAST=1"

set "GO=go"
where go >nul 2>nul || set "GO=%ProgramFiles%\Go\bin\go.exe"

set "CGO_ENABLED=0"
set "GOOS=windows"
if "%GOARCH%"=="" set "GOARCH=amd64"
set "OUT=%~dp0..\dist\installer"
if not exist "%OUT%" mkdir "%OUT%"

if not defined FAST (
  echo [installer] go vet + go test
  "%GO%" vet ./... || exit /b 1
  "%GO%" test ./... || exit /b 1
)

set "LDF=-s -w -X main.version=%VER%"
echo [installer] building %VER% for %GOARCH%
"%GO%" build -trimpath -ldflags "%LDF% -H windowsgui" -o "%OUT%\TelinhaInstaller.exe" . || exit /b 1
"%GO%" build -trimpath -ldflags "%LDF%" -o "%OUT%\TelinhaInstaller-cli.exe" . || exit /b 1

for %%F in ("%OUT%\TelinhaInstaller.exe" "%OUT%\TelinhaInstaller-cli.exe") do echo [installer] %%~fF  %%~zF bytes
endlocal
