@echo off
rem Compila native-audio\bin\telinha-audio.exe (x64, CRT estatico, sem dependencias alem do Windows).
rem Requer Visual Studio 2019+ ou Build Tools com "Desenvolvimento para desktop com C++" (MSVC x64 + Windows SDK).
rem Uso: native-audio\build.cmd [--copy-to-dist]   (--copy-to-dist copia o exe para dist\ ao lado do patcher.js)
setlocal EnableExtensions
set "ROOT=%~dp0"
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [native-audio] vswhere.exe nao encontrado: instale o Visual Studio Build Tools
    exit /b 1
)
set "VSDIR="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (
    echo [native-audio] MSVC x64 nao encontrado: instale "Desenvolvimento para desktop com C++"
    exit /b 1
)
rem o vcvars procura o vswhere no PATH (sem isso imprime um aviso inofensivo)
set "PATH=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer;%PATH%"
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

if not exist "%ROOT%bin" mkdir "%ROOT%bin"
if not exist "%ROOT%obj" mkdir "%ROOT%obj"

rc /nologo /fo "%ROOT%obj\telinha-audio.res" "%ROOT%src\telinha-audio.rc"
if errorlevel 1 exit /b 1

rem /Brepro: build reproduzivel (sem timestamp no PE). /guard:cf /CETCOMPAT /DYNAMICBASE /NXCOMPAT: mitigacoes padrao.
cl /nologo /std:c++17 /O2 /MT /W4 /WX /EHsc /permissive- /GS /guard:cf /sdl /DUNICODE /D_UNICODE /Brepro ^
   /Fo"%ROOT%obj\\" "%ROOT%src\telinha-audio.cpp" "%ROOT%obj\telinha-audio.res" ^
   /Fe"%ROOT%bin\telinha-audio.exe" ^
   /link /SUBSYSTEM:CONSOLE /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /GUARD:CF /CETCOMPAT /Brepro /OPT:REF /OPT:ICF /INCREMENTAL:NO
if errorlevel 1 exit /b 1

echo [native-audio] OK: %ROOT%bin\telinha-audio.exe
certutil -hashfile "%ROOT%bin\telinha-audio.exe" SHA256 | findstr /v /c:"CertUtil"

if /i "%~1"=="--copy-to-dist" (
    if not exist "%ROOT%..\dist" mkdir "%ROOT%..\dist"
    copy /y "%ROOT%bin\telinha-audio.exe" "%ROOT%..\dist\telinha-audio.exe" >nul
    if errorlevel 1 exit /b 1
    echo [native-audio] copiado para dist\telinha-audio.exe
)
exit /b 0
