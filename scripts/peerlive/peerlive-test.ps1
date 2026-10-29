<#
    PeerLive - instalador / restaurador do build de TESTE (fase de viabilidade).
    Ferramenta temporária: NÃO é o instalador final do PeerLive.

    Uso (feito pelos arquivos instalar.cmd / restaurar.cmd, a partir da pasta extraída do ZIP):
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File peerlive-test.ps1 -Action Install
        powershell.exe -NoProfile -ExecutionPolicy Bypass -File peerlive-test.ps1 -Action Restore

    O que faz:
      Install : troca os arquivos de %APPDATA%\Vencord\dist (o Vencord oficial) pelos do build de teste,
                guardando antes uma cópia em %APPDATA%\Vencord\dist.backup-oficial-<hash>.
      Restore : copia de volta o backup oficial mais novo por cima de dist.

    O que NUNCA faz: fechar o Discord, mexer em settings/temas/plugins do Vencord, baixar qualquer coisa.

    Parâmetros de teste (padrões: %APPDATA%\Vencord, %LOCALAPPDATA%\Discord, <pasta do script>\dist):
        -VencordDir, -DiscordDir, -PackageDir
    -Force (só no Restore): restaura mesmo que o build de teste não pareça estar instalado.

    Códigos de saída: 0 ok | 1 erro inesperado | 2 Discord/Vencord oficial ausente | 3 pacote inválido
                      4 falha ao copiar/verificar | 5 não há backup oficial para restaurar

    Este arquivo precisa ficar salvo como UTF-8 COM BOM (senão o Windows PowerShell 5.1 estraga os acentos).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Install', 'Restore')]
    [string]$Action,

    [string]$VencordDir,
    [string]$DiscordDir,
    [string]$PackageDir,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

if ([string]::IsNullOrWhiteSpace($VencordDir)) { $VencordDir = Join-Path $env:APPDATA 'Vencord' }
if ([string]::IsNullOrWhiteSpace($DiscordDir)) { $DiscordDir = Join-Path $env:LOCALAPPDATA 'Discord' }
if ([string]::IsNullOrWhiteSpace($PackageDir)) { $PackageDir = Join-Path $PSScriptRoot 'dist' }

# Arquivos que o build de teste substitui em dist (manter em sincronia com package-test-build.mjs).
$ManagedFiles = @(
    'patcher.js', 'patcher.js.map', 'patcher.js.LEGAL.txt',
    'preload.js', 'preload.js.map',
    'renderer.js', 'renderer.js.map', 'renderer.js.LEGAL.txt',
    'renderer.css', 'renderer.css.map'
)
$RequiredFiles = @('patcher.js', 'preload.js', 'renderer.js', 'renderer.css')
$MarkerName = 'peerlive-test-build.txt'      # gravado em dist; guarda o hash do build de teste instalado
$BackupPrefix = 'dist.backup-oficial-'
$VencordDownload = 'https://vencord.dev/download/'

# ---------------------------------------------------------------- saída

function Write-Title([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-Info([string]$Text) { Write-Host "  $Text" }
function Write-Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "  [AVISO] $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host "  [ERRO] $Text" -ForegroundColor Red }

function Stop-Script([int]$Code, [string[]]$Lines) {
    foreach ($line in $Lines) { Write-Bad $line }
    exit $Code
}

function Show-VencordFirstHelp {
    Write-Host ''
    Write-Host '  O build de teste do PeerLive é instalado POR CIMA do Vencord oficial.' -ForegroundColor Yellow
    Write-Host '  Por isso o Vencord precisa estar instalado antes:' -ForegroundColor Yellow
    Write-Host ''
    Write-Info "1. Baixe o instalador do Vencord em: $VencordDownload"
    Write-Info '2. Feche o Discord, abra o instalador, escolha "Discord" (estável) e clique em Instalar.'
    Write-Info '3. Abra o Discord uma vez e confira que existe a seção "Vencord" nas Configurações.'
    Write-Info '4. Feche o Discord por completo e rode instalar.cmd de novo.'
    Write-Host ''
}

function Show-QuitDiscordSteps {
    Write-Info '1. FECHE O DISCORD POR COMPLETO. Fechar a janela (X) não basta: ele continua rodando'
    Write-Info '   na bandeja do sistema. Clique na seta "^" perto do relógio, clique com o botão'
    Write-Info '   direito no ícone do Discord e escolha "Sair do Discord" (Quit Discord).'
    Write-Info '   (Alternativa: Ctrl+Shift+Esc > Gerenciador de Tarefas > finalize todos os "Discord".)'
    Write-Info '2. Abra o Discord de novo.'
}

# ---------------------------------------------------------------- utilitários

function Get-FirstLine([string]$Path) {
    $reader = New-Object System.IO.StreamReader($Path, [System.Text.Encoding]::UTF8, $true)
    try { $line = $reader.ReadLine() } finally { $reader.Dispose() }
    if ($null -eq $line) { return '' }
    return $line.Trim()
}

# Primeira linha de patcher.js: "// Vencord <hash>". Retorna o hash (sanitizado p/ nome de pasta) ou $null.
function Get-BuildHash([string]$PatcherPath) {
    if (-not (Test-Path -LiteralPath $PatcherPath -PathType Leaf)) { return $null }
    $line = Get-FirstLine $PatcherPath
    if ($line -match '^//\s*Vencord\s+(\S+)') { return ($Matches[1] -replace '[^A-Za-z0-9._-]', '_') }
    return $null
}

function Get-Sha256([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash }

# Hash do build de teste instalado em dist, ou $null se dist não contém (mais) um build de teste.
function Get-InstalledTestHash([string]$DistDir) {
    $marker = Join-Path $DistDir $MarkerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $null }
    $markerHash = ([string](Get-Content -LiteralPath $marker -TotalCount 1 -ErrorAction SilentlyContinue)).Trim()
    $current = Get-BuildHash (Join-Path $DistDir 'patcher.js')
    if ($markerHash -and $current -and ($markerHash -eq $current)) { return $current }
    return $null
}

# Backups oficiais válidos (têm patcher.js), do mais novo para o mais antigo.
function Get-OfficialBackups([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
    Get-ChildItem -LiteralPath $Root -Directory -Filter "$BackupPrefix*" |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'patcher.js') -PathType Leaf } |
        Sort-Object -Property @{ Expression = 'CreationTimeUtc'; Descending = $true }, @{ Expression = 'Name'; Descending = $true }
}

# Compara (SHA-256) tudo que existe em $Ref com o mesmo caminho em $Copy. Emite uma linha por problema.
function Compare-FileTree([string]$Ref, [string]$Copy) {
    $refRoot = (Get-Item -LiteralPath $Ref).FullName.TrimEnd('\')
    foreach ($file in (Get-ChildItem -LiteralPath $Ref -Recurse -File -Force)) {
        $rel = $file.FullName.Substring($refRoot.Length).TrimStart('\')
        $other = Join-Path $Copy $rel
        if (-not (Test-Path -LiteralPath $other -PathType Leaf)) { "faltando: $rel"; continue }
        if ((Get-Sha256 $file.FullName) -ne (Get-Sha256 $other)) { "diferente: $rel" }
    }
}

# Copia $Src para $Dst só se $Dst não existir ou for diferente. Retorna $true se copiou.
function Copy-IfDifferent([string]$Src, [string]$Dst) {
    if ((Test-Path -LiteralPath $Dst -PathType Leaf) -and ((Get-Sha256 $Src) -eq (Get-Sha256 $Dst))) { return $false }
    Copy-Item -LiteralPath $Src -Destination $Dst -Force
    return $true
}

# Copia o conteúdo de $BackupDir por cima de $DistDir (só o que difere) e remove o que só existe no build de teste.
function Restore-FromBackup([string]$BackupDir, [string]$DistDir) {
    if (-not (Test-Path -LiteralPath $DistDir -PathType Container)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }
    $backupRoot = (Get-Item -LiteralPath $BackupDir).FullName.TrimEnd('\')
    foreach ($file in (Get-ChildItem -LiteralPath $BackupDir -Recurse -File -Force)) {
        $dest = Join-Path $DistDir $file.FullName.Substring($backupRoot.Length).TrimStart('\')
        $destFolder = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $destFolder -PathType Container)) { New-Item -ItemType Directory -Force -Path $destFolder | Out-Null }
        Copy-IfDifferent $file.FullName $dest | Out-Null
    }
    foreach ($name in ($ManagedFiles + $MarkerName)) {
        if (-not (Test-Path -LiteralPath (Join-Path $BackupDir $name))) {
            $extra = Join-Path $DistDir $name
            if (Test-Path -LiteralPath $extra) { Remove-Item -LiteralPath $extra -Force }
        }
    }
}

function Undo-PartialInstall([string]$BackupDir, [string]$DistDir) {
    if ($BackupDir -and (Test-Path -LiteralPath $BackupDir -PathType Container)) {
        try {
            Restore-FromBackup $BackupDir $DistDir
            Write-Warn 'A instalação foi desfeita automaticamente: os arquivos oficiais voltaram do backup.'
        } catch {
            Write-Bad "Não consegui desfazer automaticamente: $($_.Exception.Message)"
            Write-Info "Rode restaurar.cmd, ou reinstale o Vencord oficial: $VencordDownload"
        }
    } else {
        Write-Warn "Não há backup oficial para desfazer sozinho. Reinstale o Vencord oficial: $VencordDownload"
    }
}

# Procura os app-*\resources\app.asar do Discord que carregam Vencord\dist\patcher.js.
function Find-PatchedAsars([string]$DiscordRoot) {
    $appDirs = @()
    if (Test-Path -LiteralPath $DiscordRoot -PathType Container) {
        $appDirs = @(Get-ChildItem -LiteralPath $DiscordRoot -Directory -Filter 'app-*')
    }
    $patched = @()
    $referenced = @()
    $latin1 = [System.Text.Encoding]::GetEncoding(28591)
    foreach ($dir in $appDirs) {
        $asar = Join-Path $dir.FullName 'resources\app.asar'
        if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $asar).Length -gt 8MB) { continue }   # o stub do Vencord é minúsculo
        $text = $latin1.GetString([System.IO.File]::ReadAllBytes($asar))
        if ($text -match 'Vencord[\\/]+dist[\\/]+patcher\.js') {
            $patched += $asar
            $found = [regex]::Match($text, '[A-Za-z]:[\\/][^"''`\r\n]*?Vencord[\\/]+dist[\\/]+patcher\.js', 'IgnoreCase')
            if ($found.Success) { $referenced += ($found.Value -replace '[\\/]+', '\') }
        }
    }
    return [pscustomobject]@{ AppDirs = $appDirs.Count; Patched = $patched; Referenced = $referenced }
}

# ---------------------------------------------------------------- Install

function Invoke-Install {
    $distDir = Join-Path $VencordDir 'dist'
    $distPatcher = Join-Path $distDir 'patcher.js'

    Write-Title '[1/5] Conferindo o pacote de teste'
    $missing = @($RequiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $PackageDir $_) -PathType Leaf) })
    if ($missing.Count -gt 0) {
        Stop-Script 3 @(
            "Faltam arquivos do build de teste na pasta: $PackageDir",
            "Arquivos ausentes: $($missing -join ', ')",
            'Extraia TODO o conteúdo do ZIP (botão direito > Extrair tudo) e rode instalar.cmd de dentro da pasta extraída.'
        )
    }
    $newHash = Get-BuildHash (Join-Path $PackageDir 'patcher.js')
    if (-not $newHash) {
        Stop-Script 3 @('O patcher.js do pacote não começa com "// Vencord <hash>". O ZIP parece corrompido; baixe de novo.')
    }
    Write-Ok "Pacote de teste válido (build $newHash)."

    Write-Title '[2/5] Conferindo Discord e Vencord oficial'
    $problems = @()
    if (-not (Test-Path -LiteralPath $distDir -PathType Container)) {
        $problems += "Não encontrei a pasta do Vencord: $distDir"
    } elseif (-not (Test-Path -LiteralPath $distPatcher -PathType Leaf)) {
        $problems += "A pasta do Vencord existe, mas está incompleta (sem patcher.js): $distDir"
    }
    $discord = Find-PatchedAsars $DiscordDir
    if ($discord.AppDirs -eq 0) {
        $problems += "Não encontrei o Discord instalado em: $DiscordDir"
    } elseif ($discord.Patched.Count -eq 0) {
        $problems += 'Encontrei o Discord, mas nenhum app-*\resources\app.asar carrega o Vencord (Vencord\dist\patcher.js).'
    }
    if ($problems.Count -gt 0) {
        foreach ($p in $problems) { Write-Bad $p }
        Show-VencordFirstHelp
        exit 2
    }
    Write-Ok "Discord com Vencord encontrado ($($discord.Patched.Count) pasta(s) app-*)."
    $expectedPatcher = Join-Path $VencordDir 'dist\patcher.js'
    foreach ($ref in ($discord.Referenced | Select-Object -Unique)) {
        if ($ref -ne $expectedPatcher) {
            Write-Warn "O Discord carrega o Vencord de OUTRO caminho: $ref"
            Write-Warn "Este instalador troca os arquivos em: $expectedPatcher - o teste pode não fazer efeito."
        }
    }
    if (@(Get-Process -Name 'Discord' -ErrorAction SilentlyContinue).Count -gt 0) {
        Write-Warn 'O Discord está aberto agora. Vou trocar os arquivos mesmo assim, mas depois você PRECISA'
        Write-Warn 'fechar o Discord por completo (inclusive o ícone da bandeja) e abrir de novo.'
    }

    Write-Title '[3/5] Backup do Vencord oficial'
    $backupDir = $null
    $installedTest = Get-InstalledTestHash $distDir
    if ($installedTest) {
        $existing = @(Get-OfficialBackups $VencordDir)
        if ($installedTest -eq $newHash) {
            Write-Info "Este mesmo build de teste ($newHash) já está instalado. Vou conferir/reinstalar os arquivos."
        } else {
            Write-Info "Já existe um build de teste instalado ($installedTest). Vou atualizá-lo para $newHash."
        }
        if ($existing.Count -gt 0) {
            $backupDir = $existing[0].FullName
            Write-Ok "Backup oficial existente mantido: $backupDir"
        } else {
            Write-Warn 'Não existe backup oficial! O restaurar.cmd não vai conseguir voltar ao oficial;'
            Write-Warn "nesse caso reinstale o Vencord pelo instalador oficial: $VencordDownload"
        }
    } else {
        $staleMarker = Join-Path $distDir $MarkerName
        if (Test-Path -LiteralPath $staleMarker) { Remove-Item -LiteralPath $staleMarker -Force }
        $officialHash = Get-BuildHash $distPatcher
        if (-not $officialHash) { $officialHash = 'desconhecido' }
        $backupDir = Join-Path $VencordDir ($BackupPrefix + $officialHash)
        if (Test-Path -LiteralPath $backupDir) {
            Write-Ok "Já existia o backup oficial, mantido sem alteração: $backupDir"
        } else {
            $tmpDir = Join-Path $VencordDir 'dist.backup-tmp'
            if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force }
            try {
                New-Item -ItemType Directory -Path $tmpDir | Out-Null
                Get-ChildItem -LiteralPath $distDir -Force | Copy-Item -Destination $tmpDir -Recurse -Force
                $diff = @(Compare-FileTree $distDir $tmpDir)
                if ($diff.Count -gt 0) { throw "a cópia de segurança não confere ($($diff -join '; '))" }
                Rename-Item -LiteralPath $tmpDir -NewName (Split-Path -Leaf $backupDir)
            } catch {
                if (Test-Path -LiteralPath $tmpDir) { Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
                Stop-Script 4 @("Não consegui criar o backup do Vencord oficial: $($_.Exception.Message)", 'Nada foi alterado. Feche o Discord por completo e tente de novo.')
            }
            Write-Ok "Backup criado (Vencord oficial $officialHash): $backupDir"
        }
    }

    Write-Title '[4/5] Copiando o build de teste'
    try {
        foreach ($name in $ManagedFiles) {
            $src = Join-Path $PackageDir $name
            if (Test-Path -LiteralPath $src -PathType Leaf) {
                if (Copy-IfDifferent $src (Join-Path $distDir $name)) { Write-Info "copiado: $name" } else { Write-Info "já estava igual: $name" }
            }
        }
    } catch {
        Write-Bad "Falha ao copiar os arquivos: $($_.Exception.Message)"
        Write-Info 'Provável causa: o Discord ainda está usando os arquivos. Feche-o por completo e tente de novo.'
        Undo-PartialInstall $backupDir $distDir
        exit 4
    }

    Write-Title '[5/5] Verificando'
    $bad = @()
    foreach ($name in $ManagedFiles) {
        $src = Join-Path $PackageDir $name
        if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { continue }
        $dst = Join-Path $distDir $name
        if (-not (Test-Path -LiteralPath $dst -PathType Leaf)) { $bad += "faltando: $name" }
        elseif ((Get-Sha256 $src) -ne (Get-Sha256 $dst)) { $bad += "diferente: $name" }
    }
    $installedLine = Get-FirstLine $distPatcher
    $packageLine = Get-FirstLine (Join-Path $PackageDir 'patcher.js')
    if ($installedLine -ne $packageLine) { $bad += "primeira linha do patcher.js: '$installedLine' (esperado '$packageLine')" }
    if ($bad.Count -gt 0) {
        Write-Bad "A verificação falhou: $($bad -join '; ')"
        Undo-PartialInstall $backupDir $distDir
        exit 4
    }
    [System.IO.File]::WriteAllText((Join-Path $distDir $MarkerName), "$newHash`r`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "Arquivos conferidos. patcher.js: $installedLine"

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host "  Instalação concluída! Build de teste: $newHash" -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'PRÓXIMOS PASSOS:' -ForegroundColor Cyan
    Show-QuitDiscordSteps
    Write-Info '3. Vá em Configurações do usuário > Vencord > Plugins, pesquise "PeerLive" e ATIVE os dois'
    Write-Info '   plugins: PeerLiveTest e PeerLiveP2PTest (se o Discord pedir para reiniciar, aceite).'
    Write-Info '4. Siga o LEIA-ME.txt para fazer o teste P2P.'
    Write-Host ''
    Write-Info 'Para voltar ao Vencord oficial depois: feche o Discord por completo e rode restaurar.cmd.'
    Write-Info 'Suas configurações, temas e plugins do Vencord não foram tocados.'
}

# ---------------------------------------------------------------- Restore

function Invoke-Restore {
    $distDir = Join-Path $VencordDir 'dist'
    $distPatcher = Join-Path $distDir 'patcher.js'

    Write-Title '[1/3] Procurando o backup do Vencord oficial'
    $backups = @(Get-OfficialBackups $VencordDir)
    if ($backups.Count -eq 0) {
        Write-Bad "Não encontrei nenhum backup (pasta $BackupPrefix*) em: $VencordDir"
        Write-Host ''
        Write-Info 'Sem o backup não dá para voltar sozinho. Reinstale o Vencord oficial:'
        Write-Info "1. Baixe o instalador em $VencordDownload"
        Write-Info '2. Feche o Discord, abra o instalador, escolha "Discord" e clique em "Reinstalar" / "Reparar"'
        Write-Info '   (ou em Desinstalar, se quiser tirar o Vencord de vez). Isso reescreve a pasta dist oficial.'
        Write-Info '3. Abra o Discord de novo.'
        exit 5
    }
    $backup = $backups[0]
    $backupHash = Get-BuildHash (Join-Path $backup.FullName 'patcher.js')
    Write-Ok "Backup mais novo: $($backup.FullName)"
    Write-Info "Vencord oficial guardado nele: $(if ($backupHash) { $backupHash } else { 'versão desconhecida' })"

    $installedTest = Get-InstalledTestHash $distDir
    if (-not $installedTest -and -not $Force -and (Test-Path -LiteralPath $distPatcher -PathType Leaf)) {
        $currentHash = Get-BuildHash $distPatcher
        Write-Host ''
        Write-Ok "O build de teste não está instalado: a pasta dist já é o Vencord oficial ($(if ($currentHash) { $currentHash } else { 'versão desconhecida' }))."
        Write-Info 'Nada a restaurar. (Se mesmo assim quiser sobrescrever com o backup, use o parâmetro -Force.)'
        return
    }

    Write-Title '[2/3] Restaurando'
    try {
        Restore-FromBackup $backup.FullName $distDir
    } catch {
        Stop-Script 4 @("Falha ao restaurar os arquivos: $($_.Exception.Message)",
            'Provável causa: o Discord ainda está usando os arquivos. Feche-o por completo e tente de novo.')
    }
    Write-Ok "Arquivos copiados de volta para: $distDir"

    Write-Title '[3/3] Verificando'
    $bad = @(Compare-FileTree $backup.FullName $distDir)
    foreach ($name in ($ManagedFiles + $MarkerName)) {
        if (-not (Test-Path -LiteralPath (Join-Path $backup.FullName $name)) -and (Test-Path -LiteralPath (Join-Path $distDir $name))) {
            $bad += "sobrando: $name"
        }
    }
    if ((Get-FirstLine $distPatcher) -ne (Get-FirstLine (Join-Path $backup.FullName 'patcher.js'))) {
        $bad += 'a primeira linha do patcher.js não confere com a do backup'
    }
    if ($bad.Count -gt 0) {
        Stop-Script 4 @("A verificação falhou: $($bad -join '; ')", 'Feche o Discord por completo e rode restaurar.cmd de novo.')
    }
    Write-Ok "Arquivos conferidos. patcher.js: $(Get-FirstLine $distPatcher)"

    Write-Host ''
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host '  Restauração concluída! Vencord oficial de volta.' -ForegroundColor Green
    Write-Host '============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'PRÓXIMOS PASSOS:' -ForegroundColor Cyan
    Show-QuitDiscordSteps
    Write-Info '3. Os plugins PeerLiveTest / PeerLiveP2PTest deixam de aparecer. Suas configurações,'
    Write-Info '   temas e plugins do Vencord não foram tocados.'
    Write-Host ''
    Write-Info "O backup foi mantido em: $($backup.FullName)"
    Write-Info '(você pode apagar essa pasta quando o teste terminar de vez).'
}

# ---------------------------------------------------------------- main

Write-Host ''
Write-Host '== PeerLive - build de TESTE (fase de viabilidade) ==' -ForegroundColor Cyan
Write-Host "   Ação:    $Action" -ForegroundColor DarkGray
Write-Host "   Vencord: $VencordDir" -ForegroundColor DarkGray
Write-Host "   Discord: $DiscordDir" -ForegroundColor DarkGray

try {
    switch ($Action) {
        'Install' { Invoke-Install }
        'Restore' { Invoke-Restore }
    }
} catch {
    Write-Host ''
    Write-Bad "Falha inesperada: $($_.Exception.Message)"
    Write-Info "Detalhe técnico: $($_.InvocationInfo.PositionMessage)"
    Write-Info 'Feche o Discord por completo e tente de novo. Se persistir, envie um print desta janela.'
    exit 1
}
exit 0
