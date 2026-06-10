param(
    [switch]$Quiet,
    [switch]$InstallScheduledTask
)

$ErrorActionPreference = "Stop"

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE ".codex" }
$codexBinRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
$logPath = Join-Path $codexHome "sandbox-setup-repair.log"
$setupName = "codex-windows-sandbox-setup.exe"

function Write-RepairLog {
    param([string]$Message)

    $Message = $Message -replace "\r?\n", " "
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
    $line = "[$stamp] $Message"
    if (-not $Quiet) {
        Write-Host $line
    }
    try {
        if (-not (Test-Path -LiteralPath $codexHome)) {
            New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
        }
        Add-Content -LiteralPath $logPath -Value $line
    } catch {
        if (-not $Quiet) {
            Write-Warning "Could not write repair log: $($_.Exception.Message)"
        }
    }
}

function Get-HashOrNull {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }
    try {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    } catch {
        return $null
    }
}

function Get-CodexVersionInfo {
    param([string]$CodexExe)

    $baseVersion = [version]"0.0.0"
    $isPrerelease = $true
    $text = ""

    if (Test-Path -LiteralPath $CodexExe) {
        try {
            $text = (& $CodexExe --version 2>$null | Select-Object -First 1)
            if ($text -match "(\d+)\.(\d+)\.(\d+)(?:-([^\s]+))?") {
                $baseVersion = [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])"
                $isPrerelease = [bool]$Matches[4]
            }
        } catch {
            $text = ""
        }
    }

    [pscustomobject]@{
        Text = $text
        BaseVersion = $baseVersion
        IsPrerelease = $isPrerelease
    }
}

function New-Candidate {
    param(
        [string]$Dir,
        [string]$Source
    )

    if ([string]::IsNullOrWhiteSpace($Dir)) {
        return $null
    }

    $fullDir = [IO.Path]::GetFullPath($Dir)
    $setupPath = Join-Path $fullDir $setupName
    if (-not (Test-Path -LiteralPath $setupPath)) {
        return $null
    }

    $codexExe = Join-Path $fullDir "codex.exe"
    $version = Get-CodexVersionInfo -CodexExe $codexExe
    $setupItem = Get-Item -LiteralPath $setupPath

    [pscustomobject]@{
        Dir = $fullDir
        SetupPath = $setupPath
        Source = $Source
        VersionText = $version.Text
        BaseVersion = $version.BaseVersion
        IsPrerelease = $version.IsPrerelease
        SetupLastWriteTime = $setupItem.LastWriteTime
    }
}

function Get-ConfiguredCodexDir {
    $configPath = Join-Path $codexHome "config.toml"
    if (-not (Test-Path -LiteralPath $configPath)) {
        return $null
    }

    $config = Get-Content -LiteralPath $configPath -Raw
    if ($config -match "CODEX_CLI_PATH\s*=\s*['""]([^'""]+codex\.exe)['""]") {
        return Split-Path -Parent $Matches[1]
    }

    return $null
}

function Get-ActiveSetupCandidate {
    if (-not (Test-Path -LiteralPath $codexBinRoot)) {
        throw "Codex bin root not found: $codexBinRoot"
    }

    $candidates = New-Object System.Collections.Generic.List[object]

    $configuredDir = Get-ConfiguredCodexDir
    $configuredCandidate = New-Candidate -Dir $configuredDir -Source "config CODEX_CLI_PATH"
    if ($configuredCandidate) {
        $candidates.Add($configuredCandidate)
    }

    $rootCandidate = New-Candidate -Dir $codexBinRoot -Source "bin root"
    if ($rootCandidate) {
        $candidates.Add($rootCandidate)
    }

    Get-ChildItem -LiteralPath $codexBinRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $candidate = New-Candidate -Dir $_.FullName -Source "bin scan"
        if ($candidate) {
            $candidates.Add($candidate)
        }
    }

    if ($candidates.Count -eq 0) {
        throw "No $setupName candidates found under $codexBinRoot"
    }

    if ($configuredCandidate) {
        return $configuredCandidate
    }

    return $candidates |
        Sort-Object `
            @{Expression = "BaseVersion"; Descending = $true}, `
            @{Expression = { -not $_.IsPrerelease }; Descending = $true}, `
            @{Expression = "SetupLastWriteTime"; Descending = $true} |
        Select-Object -First 1
}

function Get-RepairTargetDirs {
    param([string]$ActiveDir)

    $targets = New-Object System.Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
    [void]$targets.Add($ActiveDir)

    $pathValues = @(
        $env:Path,
        [Environment]::GetEnvironmentVariable("Path", "User"),
        [Environment]::GetEnvironmentVariable("Path", "Machine")
    )

    foreach ($pathValue in $pathValues) {
        if ([string]::IsNullOrWhiteSpace($pathValue)) {
            continue
        }

        foreach ($entry in ($pathValue -split ";")) {
            if ([string]::IsNullOrWhiteSpace($entry)) {
                continue
            }

            try {
                $fullEntry = [IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($entry.Trim()))
                if ($fullEntry.StartsWith($codexBinRoot, [StringComparison]::OrdinalIgnoreCase)) {
                    [void]$targets.Add($fullEntry)
                }
            } catch {
            }
        }
    }

    Get-ChildItem -LiteralPath $codexBinRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $containsCodexTool = (Test-Path -LiteralPath (Join-Path $_.FullName "codex.exe")) -or
            (Test-Path -LiteralPath (Join-Path $_.FullName "rg.exe"))
        if ($_.Name -match "^[0-9a-f]{16}$" -and $containsCodexTool) {
            [void]$targets.Add($_.FullName)
        }
    }

    return $targets.GetEnumerator() | Sort-Object
}

function Sync-SetupHelper {
    param(
        [string]$SourceSetup,
        [string]$TargetDir,
        [string]$SourceHash
    )

    if (-not (Test-Path -LiteralPath $TargetDir)) {
        New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    }

    $targetSetup = Join-Path $TargetDir $setupName
    $targetHash = Get-HashOrNull -Path $targetSetup

    if ($targetHash -eq $SourceHash) {
        Write-RepairLog "ok: $targetSetup already matches active setup"
        return $false
    }

    Copy-Item -LiteralPath $SourceSetup -Destination $targetSetup -Force
    Write-RepairLog "repaired: copied active setup to $targetSetup"
    return $true
}

function Install-RepairScheduledTask {
    $scriptPath = $PSCommandPath
    if ([string]::IsNullOrWhiteSpace($scriptPath)) {
        throw "Cannot install scheduled task because script path is unknown"
    }

    $taskName = "Codex Repair Sandbox Setup Helper"
    $argument = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`" -Quiet"
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argument
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    $description = "Keeps Codex's Windows sandbox setup helper available from stale versioned bin folders at user logon."

    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $logonTrigger -Description $description -Force | Out-Null
        Write-RepairLog "installed scheduled task: $taskName"
    } catch {
        Write-RepairLog "scheduled task module install failed: $($_.Exception.Message); trying schtasks.exe fallback"
        try {
            Install-SchtasksFallback -ScriptPath $scriptPath
        } catch {
            Write-RepairLog "schtasks.exe install failed: $($_.Exception.Message); installing HKCU Run fallback"
            Install-RunKeyFallback -ScriptPath $scriptPath
        }
    }
}

function Install-SchtasksFallback {
    param([string]$ScriptPath)

    $taskName = "CodexRepairSandboxSetupHelper"
    $taskRun = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" -Quiet"

    $output = & schtasks.exe /Create /SC ONLOGON /TN $taskName /TR $taskRun /F 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ($output -join " ")
    }

    Write-RepairLog "installed logon repair task: $taskName"
}

function Install-RunKeyFallback {
    param([string]$ScriptPath)

    $runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $valueName = "CodexRepairSandboxSetupHelper"
    $value = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`" -Quiet"

    if (-not (Test-Path -LiteralPath $runKey)) {
        New-Item -Path $runKey -Force | Out-Null
    }

    New-ItemProperty -Path $runKey -Name $valueName -Value $value -PropertyType String -Force | Out-Null
    Write-RepairLog "installed login repair fallback: HKCU Run\$valueName"
}

try {
    $active = Get-ActiveSetupCandidate
    $activeHash = Get-HashOrNull -Path $active.SetupPath
    if (-not $activeHash) {
        throw "Could not hash active setup helper: $($active.SetupPath)"
    }

    Write-RepairLog "active setup: $($active.SetupPath) [$($active.VersionText)] via $($active.Source)"

    $changed = 0
    foreach ($targetDir in (Get-RepairTargetDirs -ActiveDir $active.Dir)) {
        if (Sync-SetupHelper -SourceSetup $active.SetupPath -TargetDir $targetDir -SourceHash $activeHash) {
            $changed++
        }
    }

    if ($InstallScheduledTask) {
        Install-RepairScheduledTask
    }

    Write-RepairLog "complete: $changed target(s) repaired"
    exit 0
} catch {
    Write-RepairLog "error: $($_.Exception.Message)"
    exit 1
}
