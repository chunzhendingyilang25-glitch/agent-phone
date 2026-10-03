param(
    [Parameter(Position = 0)]
    [ValidateSet('open', 'doctor', 'install', 'setup-desktop', 'configure-hooks', 'setup-cli', 'start', 'start-hub', 'status', 'stop', 'test', 'start-local', 'start-router', 'start-cli', 'status-local', 'stop-local', 'enable-autostart', 'disable-autostart')]
    [string]$Action = 'open',

    [ValidateSet('claude', 'codex')]
    [string]$Agent = 'claude'
)

$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.5') {
    $modernShell = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe'
    if (-not (Test-Path -LiteralPath $modernShell)) { throw '需要 PowerShell 7.5 或更新版本。请在 PowerShell 7 中运行。' }
    & $modernShell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath $Action -Agent $Agent
    exit $LASTEXITCODE
}
$routerVersion = '0.12.1'
$bridgeVersion = '0.7.1'
$pathHelper = Join-Path $PSScriptRoot 'hub\paths.cjs'
$pathNode = (Get-Command node.exe -ErrorAction Stop).Source
$hubLocationsJson = & $pathNode $pathHelper --prepare
if ($LASTEXITCODE -ne 0) { throw '无法初始化统一配置目录。' }
$hubLocations = $hubLocationsJson | ConvertFrom-Json
$routerConfig = $hubLocations.routerConfig
$cursorConfig = Join-Path $env:USERPROFILE '.cursor\hooks.json'
$notifier = Join-Path $PSScriptRoot 'feishu-notify.js'
$codexConfig = Join-Path $env:USERPROFILE '.codex\config.toml'
$claudeConfig = Join-Path $env:USERPROFILE '.claude\settings.json'
$bridgeConfig = Join-Path $env:USERPROFILE '.lark-channel\config.json'
$runtimeDir = $hubLocations.dataDir
$runtimeState = Join-Path $runtimeDir 'runtime.json'
$hubRuntime = Join-Path $runtimeDir 'hub-runtime.json'
$hubServer = Join-Path $PSScriptRoot 'hub\server.mjs'
$autostartKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Read-RuntimeState {
    if (Test-Path -LiteralPath $runtimeState) {
        return Get-Content -LiteralPath $runtimeState -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    }
    return @{}
}

function Save-RuntimeState($state) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runtimeState -Encoding utf8
}

function Test-ManagedProcess($entry) {
    if (-not $entry) { return $false }
    $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    return $process.StartTime.ToUniversalTime().ToString('o') -eq $entry.startedAt
}

function Clear-StaleRouterLock {
    $lockPath = Join-Path $env:LOCALAPPDATA 'agents-router\watch-owner.lock'
    if (-not (Test-Path -LiteralPath $lockPath)) { return }
    $owner = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if (-not $owner.pid -or $owner.pid -notmatch '^\d+$') { throw 'Agents Router 锁文件无法确认所属进程，未自动清理。' }
    if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) { return }
    [System.IO.File]::Delete([System.IO.Path]::GetFullPath($lockPath))
    Write-Host "已清理上次异常退出留下的 Agents Router 锁文件（PID $($owner.pid) 已不存在）。"
}

function Clear-StaleBridgeLock([string]$profile) {
    $registryDir = Join-Path $env:USERPROFILE '.lark-channel\registry'
    $locksDir = Join-Path $registryDir 'locks'
    $profileMeta = Join-Path $locksDir "profile\$profile.lock.meta.json"
    $metas = @()
    if (Test-Path -LiteralPath $profileMeta) { $metas += Get-Item -LiteralPath $profileMeta }
    $appDir = Join-Path $locksDir 'app'
    if (Test-Path -LiteralPath $appDir) {
        $metas += @(Get-ChildItem -LiteralPath $appDir -Filter '*.lock.meta.json' -File | Where-Object {
            (Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json).profile -eq $profile
        })
    }
    $stale = @()
    foreach ($file in $metas) {
        $owner = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        if ($owner.profile -ne $profile -or "$($owner.pid)" -notmatch '^\d+$') { throw 'CLI Bridge 锁文件归属不明确，未自动清理。' }
        if (Get-Process -Id ([int]$owner.pid) -ErrorAction SilentlyContinue) { continue }
        $lockPath = $file.FullName.Substring(0, $file.FullName.Length - '.meta.json'.Length)
        $resolved = [System.IO.Path]::GetFullPath($lockPath)
        if (-not $resolved.StartsWith([System.IO.Path]::GetFullPath($locksDir) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'CLI Bridge 锁路径超出注册目录。' }
        $stale += @{ lock = $resolved; meta = $file.FullName }
    }
    foreach ($item in $stale) {
        [System.IO.File]::Delete($item.lock)
        [System.IO.File]::Delete($item.meta)
    }
    $registryPath = Join-Path $registryDir 'processes.json'
    if (Test-Path -LiteralPath $registryPath) {
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
        $entries = @($registry.entries | Where-Object {
            $_.profileName -ne $profile -or [bool](Get-Process -Id $_.pid -ErrorAction SilentlyContinue)
        })
        if ($entries.Count -ne @($registry.entries).Count) {
            $registry.entries = $entries
            $registry | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $registryPath -Encoding utf8
        }
    }
    if ($stale.Count) { Write-Host "已清理 $profile 退出后留下的锁文件。" }
}

function Start-LocalService([string]$name, [string]$file, [string[]]$arguments) {
    $state = Read-RuntimeState
    if (Test-ManagedProcess $state[$name]) {
        Write-Host "$name 已运行，PID $($state[$name].pid)"
        return
    }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    $out = Join-Path $runtimeDir "$name.stdout.log"
    $err = Join-Path $runtimeDir "$name.stderr.log"
    $process = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    Start-Sleep -Seconds 2
    $process.Refresh()
    if ($process.HasExited) {
        $details = if (Test-Path -LiteralPath $err) { (Get-Content -LiteralPath $err -Tail 15) -join "`n" } else { '' }
        throw "$name 启动失败（退出码 $($process.ExitCode)）。$details"
    }
    $state[$name] = @{ pid = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
    Save-RuntimeState $state
    Write-Host "$name 已启动，PID $($process.Id)；日志：$err"
}

function Stop-LocalService([string]$name) {
    $state = Read-RuntimeState
    if (Test-ManagedProcess $state[$name]) {
        Stop-Process -Id $state[$name].pid
        Write-Host "$name 已停止。"
    } else {
        Write-Host "$name 未运行。"
    }
    if ($state.ContainsKey($name)) {
        $state.Remove($name)
        Save-RuntimeState $state
    }
}

function Read-HubRuntime {
    if (-not (Test-Path -LiteralPath $hubRuntime)) { return $null }
    try {
        return Get-Content -LiteralPath $hubRuntime -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    } catch {
        return $null
    }
}

function Get-HubProcess {
    $state = Read-RuntimeState
    if (Test-ManagedProcess $state['hub']) { return Get-Process -Id $state['hub'].pid }
    # A process may launch the same Hub outside this script. Adopt only the Node
    # process whose command line identifies this exact workspace server.
    $runtime = Read-HubRuntime
    if (-not $runtime -or "$($runtime.pid)" -notmatch '^\d+$') { return $null }
    $process = Get-Process -Id ([int]$runtime.pid) -ErrorAction SilentlyContinue
    if (-not $process -or $process.ProcessName -ne 'node') { return $null }
    $details = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)" -ErrorAction SilentlyContinue
    $normalized = ($details.CommandLine -replace '/', '\')
    if (-not $normalized -or $normalized.IndexOf($hubServer, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    $state['hub'] = @{ pid = $process.Id; startedAt = $process.StartTime.ToUniversalTime().ToString('o') }
    Save-RuntimeState $state
    return $process
}

function Get-HubUrl {
    $runtime = Read-HubRuntime
    if ($runtime -and $runtime.url -match '^http://127\.0\.0\.1:\d+$') { return $runtime.url }
    return 'http://127.0.0.1:4318'
}

function Start-Hub {
    $process = Get-HubProcess
    if ($process) {
        Write-Host "统一服务已运行，PID $($process.Id)；管理界面：$(Get-HubUrl)"
        return
    }
    if (-not (Test-Path -LiteralPath $hubServer)) { throw '缺少 hub/server.mjs。' }
    if (-not (Test-Path -LiteralPath $routerConfig)) { throw "未找到已绑定飞书机器人配置：$routerConfig。先运行 setup-desktop。" }
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $nodeVersion = & $nodeExe --version
    if ([version]($nodeVersion.TrimStart('v')) -lt [version]'24.0') { throw '统一服务需要 Node.js 24 或更新版本。' }
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\@larksuite\channel\package.json'))) {
        throw '缺少本地依赖。先运行 .\agent-phone.ps1 install。'
    }
    # One Feishu client owns the unified bot. Retire only processes recorded by
    # this management script before starting it.
    foreach ($name in @('phone-claude', 'phone-codex', 'router')) { Stop-LocalService $name }
    Start-LocalService 'hub' $nodeExe @(('"' + $hubServer + '"'))
    $process = Get-HubProcess
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $runtime = Read-HubRuntime
        if ($runtime -and $runtime.pid -eq $process.Id) {
            Write-Host "管理界面：$(Get-HubUrl)"
            return
        }
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { throw '统一服务已退出，请检查 hub.stderr.log。' }
    }
    throw '统一服务没有生成运行状态，请检查 hub.stderr.log。'
}

function Stop-Hub {
    $process = Get-HubProcess
    if (-not $process) { Write-Host '统一服务未运行。'; return }
    $runtime = Read-HubRuntime
    if ($runtime -and $runtime.pid -eq $process.Id -and $runtime.token) {
        try {
            Invoke-RestMethod -Uri "$(Get-HubUrl)/api/shutdown" -Method Post -Headers @{ 'x-agent-phone-token' = $runtime.token } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
            for ($attempt = 0; $attempt -lt 10; $attempt++) {
                Start-Sleep -Milliseconds 500
                $process.Refresh()
                if ($process.HasExited) { break }
            }
        } catch { Write-Host '服务没有完成正常退出，正在停止已确认的管理进程。' }
    }
    $process.Refresh()
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    $state = Read-RuntimeState
    if ($state.ContainsKey('hub')) { $state.Remove('hub'); Save-RuntimeState $state }
    Write-Host '统一服务已停止。'
}

function Show-HubStatus {
    $process = Get-HubProcess
    if ($process) {
        Write-Host "统一服务：运行中，PID $($process.Id)"
        Write-Host "电脑管理界面：$(Get-HubUrl)"
        $runtime = Read-HubRuntime
        if ($runtime -and $runtime.pid -eq $process.Id -and $runtime.token) {
            try {
                $state = Invoke-RestMethod -Uri "$(Get-HubUrl)/api/state" -Headers @{ 'x-agent-phone-token' = $runtime.token } -TimeoutSec 5
                $connectionText = if ($state.connection.connected) { '已连接' } else { '未连接' }
                Write-Host "飞书连接：$connectionText；项目：$(@($state.projects).Count)；会话：$(@($state.sessions).Count)"
            } catch { Write-Host '管理接口暂时不可访问，请检查后台日志。' }
        }
    } else { Write-Host '统一服务：未运行。运行 .\agent-phone.ps1 open 打开管理界面。' }
    $run = Get-ItemProperty -Path $autostartKey -Name 'AgentPhone' -ErrorAction SilentlyContinue
    Write-Host "登录后自动启动：$([bool]$run)"
}

function Start-Router {
    if (Get-HubProcess) { throw '统一服务已使用「Agent助手」。先运行 stop，才能单独运行旧版 Router。' }
    $routerExe = Join-Path $env:APPDATA 'npm\node_modules\agents-router\node_modules\agents-router-win32-x64-msvc\bin\agents-router.exe'
    if (-not (Test-Path -LiteralPath $routerExe)) { throw 'Agents Router Windows 程序不存在。先运行 install。' }
    if (-not (Test-Path -LiteralPath $routerConfig)) { throw '先完成 setup-desktop。' }
    Clear-StaleRouterLock
    Start-LocalService 'router' $routerExe @('watch', '--config', $routerConfig)
}

function Start-CliBridge([string]$kind) {
    $nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    $bridgeCli = Join-Path $env:APPDATA 'npm\node_modules\lark-channel-bridge\dist\cli.js'
    if (-not (Test-Path -LiteralPath $bridgeCli)) { throw 'CLI Bridge 未安装。先运行 install。' }
    $profile = "phone-$kind"
    if ($kind -eq 'codex') { Update-CodexBinary }
    Clear-StaleBridgeLock $profile
    Start-LocalService $profile $nodeExe @($bridgeCli, 'run', '--profile', $profile, '--agent', $kind, '--skip-check-lark-cli')
}

function Update-CodexBinary {
    $binary = (Get-Command codex.exe -ErrorAction SilentlyContinue).Source
    if (-not $binary) {
        $binRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        if (Test-Path -LiteralPath $binRoot) {
            $candidate = Get-ChildItem -LiteralPath $binRoot -Directory | ForEach-Object {
                $file = Join-Path $_.FullName 'codex.exe'
                if (Test-Path -LiteralPath $file) { Get-Item -LiteralPath $file }
            } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            $binary = $candidate.FullName
        }
    }
    if (-not $binary) { throw '未找到 Codex CLI 可执行文件。' }
    $config = Get-Content -LiteralPath $bridgeConfig -Raw | ConvertFrom-Json -AsHashtable -DateKind String
    $profile = $config.profiles['phone-codex']
    if (-not $profile) { throw '先完成 Codex CLI 机器人绑定。' }
    if (-not $profile.ContainsKey('codex')) { $profile.codex = @{} }
    if ($profile.codex.binaryPath -ne $binary) {
        $profile.codex.binaryPath = $binary
        $config | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $bridgeConfig -Encoding utf8
        Write-Host '已更新 Codex CLI 路径，适配桌面应用更新后的安装目录。'
    }
}

function Test-CliProfile([string]$kind) {
    if (-not (Test-Path -LiteralPath $bridgeConfig)) { return $false }
    $config = Get-Content -LiteralPath $bridgeConfig -Raw | ConvertFrom-Json
    return $null -ne $config.profiles.PSObject.Properties["phone-$kind"]
}

function Start-ConfiguredServices {
    Start-Router
    foreach ($kind in @('claude', 'codex')) {
        if (Test-CliProfile $kind) { Start-CliBridge $kind }
    }
}

function Get-Cli([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Assert-Cli([string]$name) {
    $path = Get-Cli $name
    if (-not $path) { throw "未找到 $name。先运行 .\agent-phone.ps1 install" }
    return $path
}

function Show-Doctor {
    Write-Host "Node: $(& node --version 2>$null)"
    foreach ($name in @('agents-router', 'lark-channel-bridge', 'codex', 'claude', 'cursor')) {
        $path = Get-Cli $name
        if ($path) { Write-Host "$name : $path" } else { Write-Host "$name : 未安装" }
    }
    Write-Host "Agents Router 配置: $(Test-Path -LiteralPath $routerConfig)"
    Write-Host "Cursor 全局 Hook: $(Test-Path -LiteralPath $cursorConfig)"
    if (Test-Path -LiteralPath $routerConfig) {
        $config = Get-Content -LiteralPath $routerConfig -Raw
        foreach ($id in @('codex_desktop')) {
            Write-Host "通知源 $id : $($config -match ('(?m)^id\s*=\s*"' + $id + '"'))"
        }
    }
    Write-Host "Codex Hook 配置: $(Test-Path -LiteralPath $codexConfig)"
    Write-Host "Claude Hook 配置: $(Test-Path -LiteralPath $claudeConfig)"
    Write-Host '飞书凭据只从本机配置读取，状态检查不会显示 App Secret。'
}

function Add-CodexHook {
    if (-not (Test-Path -LiteralPath $codexConfig)) { throw '未找到 Codex 配置文件。' }
    $content = Get-Content -LiteralPath $codexConfig -Raw
    $backup = "$codexConfig.agent-phone.bak"
    if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $codexConfig -Destination $backup }
    $command = 'node "' + ($notifier -replace '\\', '/') + '" codex'
    $tomlCommand = $command | ConvertTo-Json -Compress
    $old = 'command = "agents-router ingest --source codex_cli --format codex_cli_stop"'
    if ($content.Contains($old)) { $content = $content.Replace($old, 'command = ' + $tomlCommand) }
    if (-not $content.Contains('command = ' + $tomlCommand)) {
        $content += "`r`n[[hooks.Stop]]`r`n[[hooks.Stop.hooks]]`r`ntype = `"command`"`r`ncommand = $tomlCommand`r`ntimeout = 10`r`n"
    }
    if ($content -notmatch '(?m)^hooks\s*=\s*true\s*$') {
        if ($content -match '(?m)^\[features\]\s*$') {
            $content = [regex]::Replace($content, '(?m)^\[features\]\s*$', "[features]`r`nhooks = true", 1)
        } else {
            $content = "[features]`r`nhooks = true`r`n" + $content
        }
    }
    Set-Content -LiteralPath $codexConfig -Value $content -Encoding utf8
    Write-Host '已接入 Codex Stop Hook，并保留原有 notify 命令。'
}

function Add-ClaudeHook {
    $directory = Split-Path -Parent $claudeConfig
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if (Test-Path -LiteralPath $claudeConfig) {
        $config = Get-Content -LiteralPath $claudeConfig -Raw | ConvertFrom-Json -AsHashtable
        $backup = "$claudeConfig.agent-phone.bak"
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $claudeConfig -Destination $backup }
    } else { $config = @{} }
    if (-not $config.ContainsKey('hooks')) { $config.hooks = @{} }
    foreach ($eventName in @($config.hooks.Keys)) {
        $groups = @()
        foreach ($group in @($config.hooks[$eventName])) {
            $kept = @($group.hooks | Where-Object { $_.command -notlike 'agents-router ingest --source claude_code*' })
            if ($kept.Count) { $group.hooks = $kept; $groups += $group }
        }
        if ($groups.Count) { $config.hooks[$eventName] = $groups } else { $config.hooks.Remove($eventName) }
    }
    $command = 'node "' + $notifier + '" claude'
    if (-not $config.hooks.ContainsKey('Stop')) { $config.hooks.Stop = @() }
    if (-not @($config.hooks.Stop | Where-Object { @($_.hooks | Where-Object command -eq $command).Count }).Count) {
        $config.hooks.Stop = @($config.hooks.Stop) + @(@{ hooks = @(@{ type = 'command'; command = $command; timeout = 10 }) })
    }
    $config | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $claudeConfig -Encoding utf8
    Write-Host '已接入 Claude Code Stop Hook。'
}

function Add-CursorHook {
    $directory = Split-Path -Parent $cursorConfig
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if (Test-Path -LiteralPath $cursorConfig) {
        $config = Get-Content -LiteralPath $cursorConfig -Raw | ConvertFrom-Json -AsHashtable
        $backup = "$cursorConfig.agent-phone.bak"
        if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $cursorConfig -Destination $backup }
    } else {
        $config = @{ version = 1; hooks = @{} }
    }
    if (-not $config.ContainsKey('version')) { $config.version = 1 }
    if (-not $config.ContainsKey('hooks')) { $config.hooks = @{} }
    if (-not $config.hooks.ContainsKey('stop')) { $config.hooks.stop = @() }
    $command = 'node "' + $notifier + '" cursor'
    $current = @($config.hooks.stop | Where-Object { $_.command -notlike '*cursor-stop.js*' })
    if (-not (@($current | Where-Object { $_.command -eq $command }).Count)) {
        $config.hooks.stop = @($current) + @(@{ command = $command; timeout = 10 })
        $config | ConvertTo-Json -Depth 40 | Set-Content -LiteralPath $cursorConfig -Encoding utf8
        Write-Host "已安装 Cursor IDE 全局 stop Hook：$cursorConfig"
    } else {
        Write-Host 'Cursor IDE Hook 已存在。'
    }
}

switch ($Action) {
    'open' {
        Start-Hub
        Start-Process -FilePath (Get-HubUrl) | Out-Null
    }
    'doctor' { Show-Doctor }
    'install' {
        if (-not (Get-Cli npm)) { throw '需要 Node.js 和 npm。' }
        & npm install -g "agents-router@$routerVersion" "lark-channel-bridge@$bridgeVersion"
        if ($LASTEXITCODE -ne 0) { throw 'npm 安装失败。' }
        & npm install --prefix $PSScriptRoot
        if ($LASTEXITCODE -ne 0) { throw '统一服务本地依赖安装失败。' }
        Show-Doctor
    }
    'setup-desktop' {
        $cli = Assert-Cli 'agents-router'
        Write-Host '向导中选择 Codex Desktop → Feishu/Lark → Personal Agent App；扫码绑定第一个机器人。'
        & $cli setup
        $setupExitCode = $LASTEXITCODE
        & $pathNode $pathHelper --import-binding | Out-Null
        if ($LASTEXITCODE -ne 0 -or ($setupExitCode -ne 0 -and -not (Test-Path -LiteralPath $routerConfig))) { throw 'Agents Router 设置未完成。' }
    }
    'configure-hooks' {
        if (-not (Test-Path -LiteralPath $routerConfig)) { throw '先运行 setup-desktop。' }
        Add-CodexHook
        Add-ClaudeHook
        Add-CursorHook
        Show-Doctor
    }
    'setup-cli' {
        $cli = Assert-Cli 'lark-channel-bridge'
        $profile = "phone-$Agent"
        Write-Host "扫码绑定 CLI 机器人：$profile。这个机器人与桌面通知机器人应使用不同的飞书应用。"
        & $cli run --profile $profile --agent $Agent
    }
    'start' { Start-Hub }
    'start-hub' { Start-Hub }
    'status' { Show-HubStatus }
    'stop' { Stop-Hub }
    'test' {
        $oldStrict = $env:AGENT_PHONE_STRICT
        try {
            $env:AGENT_PHONE_STRICT = '1'
            '{}' | & node $notifier test
            if ($LASTEXITCODE -ne 0) { throw '测试通知提交失败。' }
        } finally {
            $env:AGENT_PHONE_STRICT = $oldStrict
        }
    }
    'start-local' { Start-Hub }
    'start-router' { Start-Router }
    'start-cli' { Start-CliBridge $Agent }
    'status-local' {
        Show-HubStatus
        $state = Read-RuntimeState
        foreach ($name in @('router', 'phone-claude', 'phone-codex')) {
            if (Test-ManagedProcess $state[$name]) {
                Write-Host "$name : 运行中，PID $($state[$name].pid)"
            } else {
                Write-Host "$name : 未运行"
            }
        }
    }
    'stop-local' {
        Stop-Hub
        Stop-LocalService 'phone-claude'
        Stop-LocalService 'phone-codex'
        Stop-LocalService 'router'
    }
    'enable-autostart' {
        $scriptPath = $PSCommandPath.Replace('"', '""')
        $shellPath = (Get-Process -Id $PID).Path
        if (-not [System.IO.Path]::IsPathRooted($shellPath)) { throw '无法确认现代 PowerShell 的绝对路径。' }
        $command = '"' + $shellPath + '" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $scriptPath + '" start-hub'
        New-Item -Path $autostartKey -Force | Out-Null
        New-ItemProperty -Path $autostartKey -Name 'AgentPhone' -Value $command -PropertyType String -Force | Out-Null
        Write-Host '已启用 Windows 登录后自动启动统一服务。'
    }
    'disable-autostart' {
        Remove-ItemProperty -Path $autostartKey -Name 'AgentPhone' -ErrorAction SilentlyContinue
        Write-Host '已关闭登录后自动启动。'
    }
}
