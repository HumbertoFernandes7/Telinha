@echo off
setlocal
title PeerLive - instalar build de TESTE
echo.

if not exist "%~dp0peerlive-test.ps1" (
    echo [ERRO] Nao encontrei o arquivo peerlive-test.ps1 ao lado deste arquivo.
    echo Extraia TODO o conteudo do ZIP para uma pasta ^(botao direito no ZIP ^> Extrair tudo^)
    echo e execute o instalar.cmd de dentro da pasta extraida.
    echo.
    pause
    exit /b 1
)

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0peerlive-test.ps1" -Action Install
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo O instalador terminou com ERRO, codigo %RC%. Leia as mensagens acima; se precisar, mande um print desta janela.
echo.
pause
exit /b %RC%
