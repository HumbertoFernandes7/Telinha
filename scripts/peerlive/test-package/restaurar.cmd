@echo off
setlocal
title PeerLive - restaurar Vencord oficial
echo.

if not exist "%~dp0peerlive-test.ps1" (
    echo [ERRO] Nao encontrei o arquivo peerlive-test.ps1 ao lado deste arquivo.
    echo Extraia TODO o conteudo do ZIP para uma pasta ^(botao direito no ZIP ^> Extrair tudo^)
    echo e execute o restaurar.cmd de dentro da pasta extraida.
    echo.
    pause
    exit /b 1
)

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0peerlive-test.ps1" -Action Restore
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" echo A restauracao terminou com ERRO, codigo %RC%. Leia as mensagens acima; se precisar, mande um print desta janela.
echo.
pause
exit /b %RC%
