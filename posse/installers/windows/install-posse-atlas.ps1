<#
.SYNOPSIS
  Posse + ATLAS Windows installer.

.DESCRIPTION
  Idempotent installer for posse on Windows. ATLAS is built into Posse — there
  is no separate ATLAS checkout or build step. Parity with the Linux bash
  installer: same flags, same checks, same post-install validation, same
  account-settings seeding. A missing posse checkout is cloned automatically.

.PARAMETER InstallRoot
  Base directory for installs. Default: $env:USERPROFILE\claude-tools

.PARAMETER PosseDir
  Posse checkout directory. Default: <InstallRoot>\posse

.PARAMETER PosseRepoUrl
  Git URL used when posse must be cloned on first run.

.PARAMETER RepoId
  ATLAS repo id for smoke tests.

.PARAMETER RepoPath
  ATLAS repo path for smoke tests.

.PARAMETER SmokeQuery
  Query used for atlas-smoke. Default: auth

.PARAMETER SmokeProvider
  Provider for atlas-smoke. Default: openai

.PARAMETER NoSmoke
  Skip the smoke test.

.PARAMETER NoPersistEnv
  Don't write the ATLAS env vars to the user PowerShell profile.

.PARAMETER SkipSettings
  Don't seed ~/.posse/account.db.

.PARAMETER SkipHostTools
  Don't install/check host CLI tools used by Posse helpers (rg, tesseract,
  ImageMagick, ffmpeg).

.PARAMETER Force
  Re-run npm install / build even when node_modules looks fresh.

.PARAMETER DryRun
  Print what would happen; make no changes.

.EXAMPLE
  .\install-posse-atlas.ps1 -PosseDir C:\development\claude\tools\posse

.EXAMPLE
  .\install-posse-atlas.ps1 -DryRun
#>

[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:USERPROFILE "claude-tools"),
  [string]$PosseDir = "",
  [string]$PosseRepoUrl = "https://github.com/mtstedman/posse.git",
  [string]$RepoId = "",
  [string]$RepoPath = "",
  [string]$SmokeQuery = "auth",
  [string]$SmokeProvider = "openai",
  [switch]$NoSmoke,
  [switch]$NoPersistEnv,
  [switch]$SkipSettings,
  [switch]$SkipHostTools,
  [switch]$ConfigureKeys,
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Config defaults -- mirror the Linux script.
$PosseMode        = "preferred"
$PossePhases      = "research,planning,assessment,dev"
$PosseLiveFunnel  = "true"
$PosseScipMode    = "on"
$PosseScipLanguages = "typescript,python,php,go,rust"
$NodeMinMajor     = 24

# Step results, populated through the run and printed in the summary.
$script:Steps = [ordered]@{
  "posse clone"           = "pending"
  "host tool deps"        = "pending"
  "posse npm install"     = "pending"
  "posse python deps"     = "pending"
  "posse SCIP deps"       = "pending"
  "env file"              = "pending"
  "posse alias"           = "pending"
  "account settings seed" = "pending"
  "posse validate"        = "pending"
  "provider keys"         = "skipped"
  "smoke test"            = "pending"
}
$script:Warnings = @()
$script:ConfiguredKeys = @()

function Write-Log {
  param([string]$Message)
  Write-Host "[install-posse-atlas] $Message"
}

function Write-Warn {
  param([string]$Message)
  Write-Warning "[install-posse-atlas] $Message"
  $script:Warnings += $Message
}

function Fail {
  param([string]$Message)
  Write-Error "[install-posse-atlas] ERROR: $Message"
  exit 1
}

function ConvertTo-PowerShellLiteral {
  param([AllowNull()][string]$Value)
  if ($null -eq $Value) { $Value = "" }
  return "'" + ($Value -replace "'", "''") + "'"
}

function Require-Cmd {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    Fail "Missing required command: $Name (install it and re-run)"
  }
}

function Invoke-Cmd {
  param([scriptblock]$Script, [string]$Description)
  if ($DryRun) {
    Write-Log "(dry-run) $Description"
    return $true
  }
  try {
    & $Script
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
      throw "command exited with code $LASTEXITCODE"
    }
    return $true
  }
  catch {
    Write-Warn "$Description failed: $_"
    return $false
  }
}

function Get-NodeMajor {
  $v = (& node -p "Number(process.versions.node.split('.')[0])" 2>$null)
  return [int]$v
}

function Resolve-FullPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $PathValue }
  try {
    return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue)
  }
  catch {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
}

function Test-DepsFresh {
  param([string]$Dir)
  $nm = Join-Path $Dir "node_modules"
  $lock = Join-Path $nm ".package-lock.json"
  $pkg = Join-Path $Dir "package.json"
  if (-not (Test-Path $nm)) { return $false }
  if (-not (Test-Path $lock)) { return $false }
  if (-not (Test-Path $pkg)) { return $false }
  $lockTime = (Get-Item $lock).LastWriteTime
  $pkgTime  = (Get-Item $pkg).LastWriteTime
  return ($pkgTime -le $lockTime)
}

function Ensure-GitCheckout {
  param(
    [string]$Dir,
    [string]$RepoUrl,
    [string]$StepKey,
    [string]$Label,
    [string]$SentinelPath,
    [string]$SentinelLabel
  )

  if (Test-Path $Dir) {
    $script:Steps[$StepKey] = "skipped"
  }
  else {
    Write-Log "$Label directory missing -- cloning $RepoUrl into $Dir"
    $cloned = Invoke-Cmd -Script {
      $parent = Split-Path $Dir -Parent
      if ([string]::IsNullOrWhiteSpace($parent)) { $parent = "." }
      if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      & git clone $RepoUrl $Dir
    } -Description "git clone $RepoUrl $Dir"
    if ($cloned) {
      $script:Steps[$StepKey] = if ($DryRun) { "dry-run" } else { "done" }
    }
    else {
      $script:Steps[$StepKey] = "failed"
      Fail "failed to clone $Label from $RepoUrl into $Dir"
    }
  }

  if (-not (Test-Path $SentinelPath)) {
    if ($DryRun -and -not (Test-Path $Dir)) {
      return
    }
    Fail "$SentinelLabel not found in: $Dir (is this the $Label repo root?)"
  }
}

function Get-PythonRunner {
  $candidates = @(
    [PSCustomObject]@{ Name = "python"; Args = @() },
    [PSCustomObject]@{ Name = "python3"; Args = @() },
    [PSCustomObject]@{ Name = "py"; Args = @("-3") }
  )
  foreach ($candidate in $candidates) {
    $cmd = Get-Command $candidate.Name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    & $cmd.Source @($candidate.Args + @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)")) *> $null
    if ($LASTEXITCODE -eq 0) {
      return [PSCustomObject]@{ Command = $cmd.Source; Args = $candidate.Args }
    }
  }
  return $null
}

function Install-PythonDeps {
  $requirements = Join-Path $PosseDir "requirements.txt"
  if ($DryRun) {
    Write-Log "(dry-run) would install posse Python dependencies from $requirements"
    $script:Steps["posse python deps"] = "dry-run"
    return
  }
  if (-not (Test-Path $requirements)) {
    $script:Steps["posse python deps"] = "skipped"
    Write-Warn "requirements.txt not found in $PosseDir; Python helper dependencies were not installed."
    return
  }
  $runner = Get-PythonRunner
  if (-not $runner) {
    $script:Steps["posse python deps"] = "skipped"
    Write-Warn "Python 3.9+ not found; Python helper tools (file/image parsing and conversion) may be unavailable."
    return
  }
  Write-Log "Installing posse Python dependencies"
  if (Invoke-Cmd -Script { & $runner.Command @($runner.Args + @("-m", "pip", "install", "--user", "-r", $requirements)) } -Description "pip install --user -r requirements.txt (posse)") {
    $script:Steps["posse python deps"] = "done"
  }
  else {
    $script:Steps["posse python deps"] = "failed"
  }
}

function Install-ScipDeps {
  if ($DryRun) {
    Write-Log "(dry-run) would install Posse-managed SCIP dependencies for $PosseScipLanguages"
    $script:Steps["posse SCIP deps"] = "dry-run"
    return
  }

  Write-Log "Installing Posse-managed SCIP dependencies for $PosseScipLanguages"
  $scipJs = @'
import { installScipLanguageDependenciesSync } from "./lib/domains/atlas/functions/v2/scip/dependencies.js";

const result = installScipLanguageDependenciesSync({
  languages: process.env.POSSE_INSTALL_SCIP_LANGUAGES || "typescript,python,php,go,rust",
  force: process.env.POSSE_INSTALL_SCIP_FORCE === "true",
  onProgress: (message) => console.log(`[scip-deps] ${message}`),
});

for (const row of result.results || []) {
  const marker = row.ok ? "ok" : "warn";
  console.log(`[scip-deps] ${marker} ${row.language}: ${row.status} - ${row.message}`);
}

if (!result.ok) process.exitCode = 2;
'@
  $env:POSSE_INSTALL_SCIP_LANGUAGES = $PosseScipLanguages
  $env:POSSE_INSTALL_SCIP_FORCE = if ($Force) { "true" } else { "false" }
  try {
    Push-Location $PosseDir
    $ok = Invoke-Cmd -Script { $scipJs | & node --input-type=module - } -Description "install Posse-managed SCIP dependencies"
    if ($ok) {
      $script:Steps["posse SCIP deps"] = "done"
    }
    else {
      $script:Steps["posse SCIP deps"] = "partial"
      Write-Warn "some SCIP language dependencies could not be installed automatically. Install the missing host toolchains and run: posse atlas-v2 scip install --all"
    }
  }
  finally {
    Pop-Location
    Remove-Item Env:\POSSE_INSTALL_SCIP_LANGUAGES, Env:\POSSE_INSTALL_SCIP_FORCE -ErrorAction SilentlyContinue
  }
}

function Test-AnyCommandAvailable {
  param([string[]]$Names)
  foreach ($name in $Names) {
    if (Get-Command $name -ErrorAction SilentlyContinue) { return $true }
  }
  return $false
}

function Get-HostToolDefinitions {
  return @(
    [PSCustomObject]@{
      Label = "ripgrep"
      Commands = @("rg")
      WingetIds = @("BurntSushi.ripgrep.MSVC")
      Reason = "deterministic MCP search_files"
    },
    [PSCustomObject]@{
      Label = "Tesseract OCR"
      Commands = @("tesseract")
      WingetIds = @("UB-Mannheim.TesseractOCR")
      Reason = "image OCR extraction"
    },
    [PSCustomObject]@{
      Label = "ImageMagick"
      Commands = @("magick")
      WingetIds = @("ImageMagick.Q16", "ImageMagick.ImageMagick")
      Reason = "image re-encoding and conversion"
    },
    [PSCustomObject]@{
      Label = "FFmpeg"
      Commands = @("ffmpeg")
      WingetIds = @("Gyan.FFmpeg")
      Reason = "image/video fallback conversion"
    }
  )
}

function Install-WingetPackage {
  param(
    [string]$Label,
    [string[]]$PackageIds
  )
  foreach ($packageId in $PackageIds) {
    Write-Log "Installing $Label via winget package $packageId"
    if (Invoke-Cmd -Script {
      & winget install --id $packageId --exact --source winget --silent --accept-package-agreements --accept-source-agreements
    } -Description "winget install $packageId ($Label)") {
      return $true
    }
  }
  return $false
}

function Install-HostToolDeps {
  if ($SkipHostTools) {
    $script:Steps["host tool deps"] = "skipped"
    return
  }

  $tools = Get-HostToolDefinitions
  $missing = @()
  foreach ($tool in $tools) {
    if (Test-AnyCommandAvailable -Names $tool.Commands) {
      Write-Log "$($tool.Label) found for $($tool.Reason)"
    }
    else {
      $missing += $tool
    }
  }

  if ($missing.Count -eq 0) {
    $script:Steps["host tool deps"] = "ok"
    return
  }

  if ($DryRun) {
    foreach ($tool in $missing) {
      Write-Log "(dry-run) would install $($tool.Label) for $($tool.Reason) via winget package(s): $($tool.WingetIds -join ', ')"
    }
    $script:Steps["host tool deps"] = "dry-run"
    return
  }

  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    $labels = ($missing | ForEach-Object { $_.Label }) -join ", "
    $script:Steps["host tool deps"] = "missing"
    Write-Warn "winget not found; cannot auto-install host CLI dependencies: $labels. Install them manually or re-run after installing winget."
    return
  }

  $failed = @()
  foreach ($tool in $missing) {
    if (Install-WingetPackage -Label $tool.Label -PackageIds $tool.WingetIds) {
      if (-not (Test-AnyCommandAvailable -Names $tool.Commands)) {
        Write-Warn "$($tool.Label) installed, but command '$($tool.Commands[0])' is not visible in this shell yet. Open a new terminal or update PATH before using related tools."
      }
    }
    else {
      $failed += $tool.Label
    }
  }

  if ($failed.Count -gt 0) {
    $script:Steps["host tool deps"] = "partial"
    Write-Warn "some host CLI dependencies could not be installed automatically: $($failed -join ', ')"
  }
  else {
    $script:Steps["host tool deps"] = "done"
  }
}

function Test-ProviderCredentials {
  $found = @()
  if (Get-Command claude -ErrorAction SilentlyContinue) { $found += "claude-cli" }
  if ($env:OPENAI_API_KEY) { $found += "OPENAI_API_KEY" }
  if ($env:XAI_API_KEY)    { $found += "XAI_API_KEY" }
  $codexAuth = Join-Path $env:USERPROFILE ".codex\auth.json"
  if ($env:CODEX_API_KEY -or (Test-Path $codexAuth)) { $found += "codex" }
  if ($found.Count -eq 0) {
    Write-Warn "no provider credentials detected (claude CLI / OPENAI_API_KEY / XAI_API_KEY / CODEX_API_KEY / ~/.codex/auth.json). Posse will not be able to dispatch jobs until one is configured."
  }
  else {
    Write-Log "Detected provider credentials: $($found -join ', ')"
  }
  if ($env:POSSE_KEY) {
    Write-Log "Detected Posse remote key: POSSE_KEY"
  }
  else {
    Write-Warn "POSSE_KEY is not set. Posse remote prompt/tool catalog requests will require this key."
  }
}

function Test-GitConfig {
  $name  = (& git config --global user.name  2>$null)
  $email = (& git config --global user.email 2>$null)
  if (-not $name)  { Write-Warn 'git user.name is not set globally (git config --global user.name "Your Name"). Posse auto-commits will fall back to repo-local config.' }
  if (-not $email) { Write-Warn 'git user.email is not set globally (git config --global user.email "you@example.com").' }
}

function Seed-AccountSettings {
  param([string]$NodeBin)
  if ($DryRun) {
    Write-Log "(dry-run) would seed missing ATLAS keys into ~/.posse/account.db"
    $script:Steps["account settings seed"] = "dry-run"
    return
  }
  $seedJs = @'
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const settingsPath = process.env.POSSE_ACCOUNT_DB_PATH
  ? path.resolve(process.env.POSSE_ACCOUNT_DB_PATH)
  : path.join(os.homedir(), ".posse", "account.db");
const seed = {
  atlas_mode: process.env.POSSE_SEED_MODE,
  atlas_phases: process.env.POSSE_SEED_PHASES,
  atlas_live_funnel: process.env.POSSE_SEED_FUNNEL,
  atlas_scip_mode: process.env.POSSE_SEED_SCIP_MODE,
  atlas_scip_languages: process.env.POSSE_SEED_SCIP_LANGUAGES,
};
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
const db = new Database(settingsPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS account_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
const get = db.prepare(`SELECT setting_value FROM account_settings WHERE setting_key = ?`);
const upsert = db.prepare(`
  INSERT INTO account_settings (setting_key, setting_value, updated_at)
  VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(setting_key) DO UPDATE
    SET setting_value = excluded.setting_value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`);
let added = 0, kept = 0, skipped = 0;
const tx = db.transaction((entries) => {
  for (const [k, v] of entries) {
    if (v == null || String(v).trim() === "") { skipped++; continue; }
    const current = get.get(k);
    if (!current || current.setting_value == null || String(current.setting_value).trim() === "") {
      upsert.run(k, String(v));
      added++;
    } else {
      kept++;
    }
  }
});
tx(Object.entries(seed));
db.close();
console.log(`[seed-settings] wrote ${settingsPath} -- added ${added}, kept ${kept} existing, skipped ${skipped} empty`);
'@

  # Pass values via env vars so we don't have to worry about quoting inside a heredoc-equivalent.
  $env:POSSE_SEED_MODE      = $PosseMode
  $env:POSSE_SEED_PHASES    = $PossePhases
  $env:POSSE_SEED_FUNNEL    = $PosseLiveFunnel
  $env:POSSE_SEED_SCIP_MODE = $PosseScipMode
  $env:POSSE_SEED_SCIP_LANGUAGES = $PosseScipLanguages
  try {
    Push-Location $PosseDir
    try { $seedJs | & $NodeBin --input-type=commonjs - }
    finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "seed-settings node script failed (exit $LASTEXITCODE)"
      $script:Steps["account settings seed"] = "failed"
    }
    else {
      $script:Steps["account settings seed"] = "done"
    }
  }
  finally {
    Remove-Item Env:\POSSE_SEED_MODE, Env:\POSSE_SEED_PHASES, Env:\POSSE_SEED_FUNNEL, `
                Env:\POSSE_SEED_SCIP_MODE, Env:\POSSE_SEED_SCIP_LANGUAGES `
                -ErrorAction SilentlyContinue
  }
}

function Validate-Posse {
  if ($DryRun) { $script:Steps["posse validate"] = "dry-run"; return }
  Push-Location $PosseDir
  try {
    & node orchestrator.js status *> $null
    $script:Steps["posse validate"] = if ($LASTEXITCODE -eq 0) { "ok" } else { "failed" }
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "posse failed to boot (node orchestrator.js status returned $LASTEXITCODE). Run it manually to see the error."
    }
  }
  finally { Pop-Location }
}

function Write-EnvFile {
  param([string]$NodeBin)
  $envDir  = Join-Path $env:USERPROFILE ".config\posse"
  $envFile = Join-Path $envDir "atlas.env.ps1"
  if ($DryRun) {
    Write-Log "(dry-run) would write $envFile"
    $script:Steps["env file"] = "dry-run"
    return $envFile
  }
  New-Item -ItemType Directory -Path $envDir -Force | Out-Null
  $contents = @(
    "# Posse PATH wiring -- generated by install-posse-atlas.ps1",
    "# ATLAS runtime configuration lives in ~\.posse\account.db (posse admin),",
    "# not environment variables.",
    ("`$env:POSSE_BIN_DIR = {0}" -f (ConvertTo-PowerShellLiteral (Join-Path $env:USERPROFILE ".local\bin"))),
    'if (($env:PATH -split '';'') -notcontains $env:POSSE_BIN_DIR) { $env:PATH = "$env:POSSE_BIN_DIR;$env:PATH" }'
  ) -join "`r`n"
  Set-Content -Path $envFile -Value $contents -Encoding UTF8
  Write-Log "Wrote environment file: $envFile"
  $script:Steps["env file"] = "done"
  return $envFile
}

function Append-ProfileSource {
  param([string]$EnvFile)
  if ($NoPersistEnv) { return }
  if (-not $PROFILE) { Write-Warn "No PowerShell profile path available. Skipping auto-source."; return }
  $line = ". $(ConvertTo-PowerShellLiteral $EnvFile)"
  if ($DryRun) {
    Write-Log "(dry-run) would ensure '$line' is in $PROFILE"
    return
  }
  $profileDir = Split-Path $PROFILE -Parent
  if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
  if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
  $existing = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
  if ($null -eq $existing -or -not $existing.Contains($EnvFile)) {
    Add-Content -Path $PROFILE -Value "`n# Posse ATLAS integration`n$line"
    Write-Log "Updated $PROFILE to source $EnvFile"
  }
}

function Ensure-PosseAlias {
  param([string]$NodeBin)
  $binDir = Join-Path $env:USERPROFILE ".local\bin"
  $cmdShim = Join-Path $binDir "posse.cmd"
  $psShim = Join-Path $binDir "posse.ps1"

  if ($DryRun) {
    Write-Log "(dry-run) would create posse alias shims at $cmdShim and $psShim"
    $script:Steps["posse alias"] = "dry-run"
    return
  }

  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $cmdContents = @(
    "@echo off",
    ('"{0}" "{1}" %*' -f $NodeBin, (Join-Path $PosseDir "orchestrator.js"))
  ) -join "`r`n"
  Set-Content -Path $cmdShim -Value $cmdContents -Encoding ASCII

  $psContents = @(
    ('$node = {0}' -f (ConvertTo-PowerShellLiteral $NodeBin)),
    ('$entry = {0}' -f (ConvertTo-PowerShellLiteral (Join-Path $PosseDir "orchestrator.js"))),
    '& $node $entry @args',
    'exit $LASTEXITCODE'
  ) -join "`r`n"
  Set-Content -Path $psShim -Value $psContents -Encoding UTF8

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathParts = @($userPath -split ";" | Where-Object { $_ })
  if (-not ($pathParts | Where-Object { $_ -ieq $binDir })) {
    $newUserPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
  }
  if (-not (($env:Path -split ";") | Where-Object { $_ -ieq $binDir })) {
    $env:Path = "$binDir;$env:Path"
  }

  $script:Steps["posse alias"] = "done"
  Write-Log "Installed posse alias shims: $cmdShim and $psShim"
  if (-not (Get-Command posse -ErrorAction SilentlyContinue)) {
    Write-Warn "posse alias was written to $binDir, but it is not visible in this shell yet. Open a new terminal or ensure the directory is on PATH."
  }
}

# Prompt (hidden) for a provider API key. Skips if the env var is already set.
# Returns $true if a value was captured.
function Prompt-ForKey {
  param([string]$Label, [string]$VarName)
  $existing = [Environment]::GetEnvironmentVariable($VarName, "Process")
  if ($existing) {
    Write-Log "$VarName already set (length $($existing.Length)) -- skipping"
    return $false
  }
  if ($DryRun) {
    Write-Log "(dry-run) would prompt for $Label ($VarName)"
    return $false
  }
  $secure = Read-Host -Prompt "  Enter $Label (press Enter to skip)" -AsSecureString
  # Empty SecureString has Length 0. Convert to plaintext only if user typed something.
  if ($secure.Length -eq 0) {
    Write-Log "Skipped $Label"
    return $false
  }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  }
  finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
  if (-not $plain) {
    Write-Log "Skipped $Label"
    return $false
  }
  # Export for this process (validation, smoke test can use it).
  [Environment]::SetEnvironmentVariable($VarName, $plain, "Process")
  $script:ConfiguredKeys += [PSCustomObject]@{ Name = $VarName; Value = $plain }
  return $true
}

function Configure-Keys {
  param([string]$ProvidersFile)

  # Dot-source any existing providers.env.ps1 so we don't re-prompt for keys
  # that were captured on a previous run.
  if (Test-Path $ProvidersFile) {
    . $ProvidersFile
  }

  Write-Log "Configuring provider API keys. Input is hidden. Press Enter to skip."
  [void](Prompt-ForKey "Posse remote key" "POSSE_KEY")
  [void](Prompt-ForKey "OpenAI API key" "OPENAI_API_KEY")
  [void](Prompt-ForKey "xAI (Grok) key" "XAI_API_KEY")
  [void](Prompt-ForKey "Codex API key (optional -- skip if you prefer 'codex login')" "CODEX_API_KEY")

  if (-not $DryRun) {
    if (Get-Command claude -ErrorAction SilentlyContinue) {
      $ans = Read-Host "  Run 'claude' now to log in to Claude? [y/N]"
      if ($ans -match '^[Yy]$') {
        try { & claude } catch { Write-Warn "claude login command did not exit cleanly: $_" }
      }
    }
    if ((Get-Command codex -ErrorAction SilentlyContinue) -and -not $env:CODEX_API_KEY) {
      $ans = Read-Host "  Run 'codex login' now? [y/N]"
      if ($ans -match '^[Yy]$') {
        try { & codex login } catch { Write-Warn "codex login command did not exit cleanly: $_" }
      }
    }
  }

  if ($script:ConfiguredKeys.Count -eq 0) {
    $script:Steps["provider keys"] = "none captured"
    return
  }

  if ($DryRun) {
    Write-Log "(dry-run) would write $($script:ConfiguredKeys.Count) key(s) to $ProvidersFile"
    $script:Steps["provider keys"] = "dry-run"
    return
  }

  # Merge with existing file: keep any $env: lines for vars we didn't touch.
  $capturedNames = $script:ConfiguredKeys.Name
  $preserved = @()
  if (Test-Path $ProvidersFile) {
    $preserved = Get-Content $ProvidersFile | Where-Object {
      $line = $_
      $keep = $true
      foreach ($n in $capturedNames) {
        if ($line -match "^\s*\`$env:$([regex]::Escape($n))\s*=") { $keep = $false; break }
      }
      $keep
    }
  }

  $lines = @("# Posse provider API keys -- generated by install-posse-atlas.ps1")
  $lines += $preserved | Where-Object { $_ -and ($_ -notmatch '^\s*#\s*Posse provider API keys') }
  foreach ($k in $script:ConfiguredKeys) {
    $lines += ('$env:{0} = {1}' -f $k.Name, (ConvertTo-PowerShellLiteral $k.Value))
  }

  $dir = Split-Path $ProvidersFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $ProvidersFile -Value ($lines -join "`r`n") -Encoding UTF8

  # Tighten ACL so only the current user can read. NTFS ACL set: remove
  # inherited permissions, add explicit full control for the current user.
  try {
    $acl = Get-Acl $ProvidersFile
    $acl.SetAccessRuleProtection($true, $false)  # disable inheritance, don't copy
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
      "FullControl",
      "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl -Path $ProvidersFile -AclObject $acl
  }
  catch {
    Write-Warn "Could not tighten ACL on $ProvidersFile -- file is readable by default NTFS permissions. $_"
  }

  Write-Log "Wrote $($script:ConfiguredKeys.Count) key(s) to $ProvidersFile (ACL: current user only)"
  $script:Steps["provider keys"] = ($capturedNames -join ", ")
}

function Print-Summary {
  param([string]$EnvFile)
  Write-Host ""
  Write-Host "================ Install Summary ================"
  foreach ($k in $script:Steps.Keys) {
    $v = $script:Steps[$k]
    Write-Host ("  {0,-22}: {1}" -f $k, $v)
  }
  Write-Host "================================================="
  if ($script:Warnings.Count -gt 0) {
    Write-Host ""
    Write-Host "Warnings:"
    foreach ($w in $script:Warnings) { Write-Host "  - $w" }
  }
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. . `"$EnvFile`"                        # load ATLAS env for this shell"
  Write-Host "  2. cd `"$PosseDir`""
  Write-Host "  3. posse add                            # describe a task"
  Write-Host "  4. posse go                             # plan + run"
  Write-Host ""
}

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

Require-Cmd git
Require-Cmd node
Require-Cmd npm

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt $NodeMinMajor) {
  Fail "Node $NodeMinMajor+ required. Found $(node -v). Install via nvm-windows or https://nodejs.org."
}

if (-not $PosseDir) { $PosseDir = Join-Path $InstallRoot "posse" }

$PosseDir = Resolve-FullPath $PosseDir

Ensure-GitCheckout -Dir $PosseDir -RepoUrl $PosseRepoUrl -StepKey "posse clone" -Label "posse" -SentinelPath (Join-Path $PosseDir "orchestrator.js") -SentinelLabel "orchestrator.js"

if ($RepoPath -and -not (Test-Path $RepoPath)) { Fail "repo path does not exist: $RepoPath" }
if ($RepoPath -and -not $RepoId) { $RepoId = Split-Path $RepoPath -Leaf }

Test-GitConfig
Test-ProviderCredentials

if ($DryRun) { Write-Log "DRY RUN MODE -- no changes will be made" }

# -----------------------------------------------------------------------------
# Install host CLI deps used by Posse helper tools
# -----------------------------------------------------------------------------

Install-HostToolDeps

# -----------------------------------------------------------------------------
# Install npm deps (idempotent)
# -----------------------------------------------------------------------------

if (-not $Force -and (Test-DepsFresh $PosseDir)) {
  Write-Log "Posse deps are fresh -- skipping npm install (pass -Force to reinstall)"
  $script:Steps["posse npm install"] = "skipped"
}
else {
  Write-Log "Installing posse npm dependencies"
  if (Invoke-Cmd -Script { Push-Location $PosseDir; try { & npm install --include=optional } finally { Pop-Location } } -Description "npm install --include=optional (posse)") {
    $script:Steps["posse npm install"] = if ($DryRun) { "dry-run" } else { "done" }
  }
  else { $script:Steps["posse npm install"] = "failed" }
}

Install-PythonDeps
Install-ScipDeps

# -----------------------------------------------------------------------------
# Write env file + wire profile
# -----------------------------------------------------------------------------

$nodeBin = (Get-Command node).Source
$envFile = Write-EnvFile -NodeBin $nodeBin
Append-ProfileSource -EnvFile $envFile
Ensure-PosseAlias -NodeBin $nodeBin

# -----------------------------------------------------------------------------
# Configure provider API keys (opt-in via -ConfigureKeys)
# -----------------------------------------------------------------------------

$providersFile = Join-Path (Split-Path $envFile -Parent) "providers.env.ps1"
if ($ConfigureKeys) {
  Configure-Keys -ProvidersFile $providersFile
}
if ((Test-Path $providersFile) -and -not $NoPersistEnv -and $PROFILE -and -not $DryRun) {
  $profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
  if ($null -eq $profileContent -or -not $profileContent.Contains($providersFile)) {
    $line = ". `"$providersFile`""
    Add-Content -Path $PROFILE -Value "`n# Posse provider keys`n$line"
    Write-Log "Updated $PROFILE to source $providersFile"
  }
}

# -----------------------------------------------------------------------------
# Seed account settings (merge-only -- never overwrite existing)
# -----------------------------------------------------------------------------

if (-not $SkipSettings) {
  Seed-AccountSettings -NodeBin $nodeBin
}
else {
  $script:Steps["account settings seed"] = "skipped"
}

# -----------------------------------------------------------------------------
# Post-install validation
# -----------------------------------------------------------------------------

Validate-Posse

# -----------------------------------------------------------------------------
# Optional smoke test
# -----------------------------------------------------------------------------

if (-not $NoSmoke) {
  if (-not $RepoPath) {
    Write-Log "Skipping smoke test (no -RepoPath provided)"
    $script:Steps["smoke test"] = "skipped"
  }
  elseif ($DryRun) {
    Write-Log "(dry-run) would run atlas-smoke on $RepoPath"
    $script:Steps["smoke test"] = "dry-run"
  }
  else {
    Write-Log "Running ATLAS smoke test"
    Push-Location $PosseDir
    try {
      . $envFile
      & node ./orchestrator.js atlas-smoke $RepoPath $SmokeQuery $SmokeProvider
      if ($LASTEXITCODE -eq 0) {
        $script:Steps["smoke test"] = "ok"
      }
      else {
        $script:Steps["smoke test"] = "failed"
        Write-Warn "atlas-smoke failed (exit $LASTEXITCODE). Run it manually to see the error: node orchestrator.js atlas-smoke $RepoPath $SmokeQuery $SmokeProvider"
      }
    }
    finally { Pop-Location }
  }
}
else {
  $script:Steps["smoke test"] = "skipped"
}

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------

Print-Summary -EnvFile $envFile
Write-Log "Install complete."
