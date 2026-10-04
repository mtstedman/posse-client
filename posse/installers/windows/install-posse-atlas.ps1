<#
.SYNOPSIS
  Posse + ATLAS Windows installer.

.DESCRIPTION
  Bootstraps a Windows host: helper CLI tools (via winget), SCIP language
  selection, Node.js 24+ (via winget when missing), the Posse
  checkout, npm deps, SCIP language environments (delegated to
  `posse doctor` — the same engine Posse uses at boot), account settings, and
  PATH/profile wiring.

  Design rules (parity with the Linux installer):
    - Never dies mid-run without a summary: every step is fenced, failures are
      recorded and reported, and dependent steps are marked "blocked".
    - Idempotent: re-running is safe; fresh steps are skipped. -Force
      reinstalls npm deps, -DryRun previews without changes.
    - All command output is captured to a log file; failures print the tail.
    - Works under both Windows PowerShell 5.1 and PowerShell 7+ — native
      commands run through cmd.exe with file redirection, so stderr output can
      never surface as a terminating PowerShell error.

.PARAMETER InstallRoot
  Base directory for installs. Default: $env:USERPROFILE\claude-tools

.PARAMETER PosseDir
  Posse checkout directory. Default: installer checkout when available, else
  <InstallRoot>\posse-client (with the Posse root auto-detected inside it).

.PARAMETER PosseRepoUrl
  Fallback Git URL used only when no checkout is detected and PosseDir is missing.

.PARAMETER RepoId
  ATLAS repo id for smoke tests.

.PARAMETER RepoPath
  ATLAS repo path for smoke tests.

.PARAMETER SmokeQuery
  Query used for atlas-smoke. Default: auth

.PARAMETER SmokeProvider
  Provider for atlas-smoke. Default: openai

.PARAMETER ScipLanguages
  Initial SCIP languages to install/index. Values: typescript, python, php, go,
  rust, clang, or all. If omitted in an interactive shell, a multi-select prompt
  is shown. Default: typescript,python. PHP is opt-in because its SCIP indexer
  requires a separate PHP/Composer toolchain.

.PARAMETER NoSmoke
  Skip the smoke test.

.PARAMETER NoPersistEnv
  Don't write PATH/profile wiring.

.PARAMETER SkipSettings
  Don't seed ~/.posse/account.db.

.PARAMETER SkipHostTools
  Don't install helper CLI tools (gh, rg, and with -WithMediaTools tesseract,
  ImageMagick, ffmpeg) or the selected languages' toolchains. Missing tools
  are still reported.

.PARAMETER WithMediaTools
  Also install the media helpers Posse's OCR and image/video conversion tools
  use: Tesseract OCR, ImageMagick, and FFmpeg. Off by default; they install
  after everything else in the tools step.

.PARAMETER NoInstallNode
  Don't auto-install Node through winget or the verified ZIP fallback.

.PARAMETER NonInteractive
  Never prompt; use saved credentials or the process environment.

.PARAMETER SetupOnly
  Install core files and launcher; defer account/runtime setup to first run.

.PARAMETER ConfigureKeys
  Interactively prompt for provider API keys (stored in the private
  %USERPROFILE%\.config\posse\.env with an ACL limited to the current user,
  SYSTEM, and local Administrators). Legacy providers.env.ps1 files and
  user-environment entries left by older installers are kept in sync only
  when they already exist; new installs write only .env.

.PARAMETER KeyFile
  Read keys from this file (NAME=value lines, known key names only) instead of
  prompting, save them like typed keys, and delete the file. Used by the
  Windows setup package so keys never appear on a command line.

.PARAMETER ProgressFile
  Append plain-language progress events (TAB-separated lines) to this file.
  Posse Setup reads it to drive its progress page; full detail stays in the log.

.PARAMETER Uninstall
  Undo this checkout's wiring: the automation owner task, the posse command
  and its PATH entry, and PowerShell profile lines. The checkout itself is
  left for the caller (the setup package's uninstaller) to delete.

.PARAMETER RemoveUserData
  With -Uninstall, also delete account settings, saved keys, logs, and
  managed runtimes (~\.posse, ~\.config\posse, %LOCALAPPDATA%\Posse).

.PARAMETER Force
  Re-run npm install even when node_modules looks fresh.

.PARAMETER CommandTimeoutSeconds
  Maximum runtime for ordinary non-interactive commands. Default: 1800.

.PARAMETER PackageTimeoutSeconds
  Maximum runtime for each winget package install. Default: 600.

.PARAMETER DoctorTimeoutSeconds
  Maximum runtime for doctor, including first-time Jina deployment. Default: 7500.

.PARAMETER DryRun
  Print what would happen; make no changes.

.PARAMETER Plain
  Disable colors, splash gradient, and spinners.

.EXAMPLE
  .\install-posse-atlas.ps1

.EXAMPLE
  .\install-posse-atlas.ps1 -DryRun
#>

[CmdletBinding()]
param(
  [string]$InstallRoot = (Join-Path $env:USERPROFILE "claude-tools"),
  [string]$PosseDir = "",
  [string]$PosseRepoUrl = "https://github.com/mtstedman/posse-client.git",
  [string]$RepoId = "",
  [string]$RepoPath = "",
  [string]$SmokeQuery = "auth",
  [string]$SmokeProvider = "openai",
  [string]$ScipLanguages = "",
  [switch]$NoSmoke,
  [switch]$NoPersistEnv,
  [switch]$SkipSettings,
  [switch]$SkipHostTools,
  [switch]$WithMediaTools,
  [switch]$NoInstallNode,
  [switch]$ConfigureKeys,
  [switch]$NonInteractive,
  [switch]$SetupOnly,
  [string]$KeyFile = "",
  [string]$ProgressFile = "",
  [switch]$Uninstall,
  [switch]$RemoveUserData,
  [switch]$Force,
  [ValidateRange(60, 86400)][int]$CommandTimeoutSeconds = 1800,
  [ValidateRange(60, 86400)][int]$PackageTimeoutSeconds = 600,
  [ValidateRange(60, 86400)][int]$DoctorTimeoutSeconds = 7500,
  [switch]$DryRun,
  [switch]$Plain
)

# Cmdlet failures should surface; native commands never throw because they run
# through the step engine (cmd.exe + file redirection), not raw invocation.
$ErrorActionPreference = "Stop"

# --- config defaults (parity with the Linux script) ---------------------------
$PosseMode          = "preferred"
$PossePhases        = "research,planning,assessment,dev"
$PosseLiveFunnel    = "true"
$PosseScipMode      = "on"
$ScipLanguagesSupplied = $PSBoundParameters.ContainsKey("ScipLanguages")
$PosseScipLanguages = if ($ScipLanguagesSupplied) { $ScipLanguages } else { "typescript,python" }
$NodeMinMajor       = 24
$localAppDataRoot   = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $env:USERPROFILE "AppData\Local" }
$script:ManagedStateRoot = Join-Path $localAppDataRoot "Posse"

# =============================================================================
# UI layer: colors, splash, spinner, step engine
# =============================================================================

$script:Esc = [char]27
$script:UiAnsi = $false
$script:UiSpinner = $false

function Initialize-Ui {
  $isRedirected = $false
  try { $isRedirected = [Console]::IsOutputRedirected } catch { $isRedirected = $false }
  $supportsAnsi = ($PSVersionTable.PSVersion.Major -ge 7) -or $env:WT_SESSION -or ($env:TERM_PROGRAM -eq "vscode")
  $script:UiAnsi = (-not $Plain) -and (-not $env:NO_COLOR) -and (-not $isRedirected) -and $supportsAnsi
  $script:UiSpinner = $script:UiAnsi
  if ($script:UiAnsi) {
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
  }

  if ($script:UiAnsi) {
    $script:R      = "$Esc[0m"
    $script:BOLD   = "$Esc[1m"
    $script:DIM    = "$Esc[2m"
    $script:RED    = "$Esc[31m"
    $script:GREEN  = "$Esc[32m"
    $script:YELLOW = "$Esc[33m"
    $script:CYAN   = "$Esc[36m"
    $script:ORANGE = "$Esc[38;2;255;153;51m"
    $script:GlyphOk = [string][char]0x2713   # ✓
    $script:GlyphFail = [string][char]0x2717 # ✗
    $script:GlyphWarn = "!"
    $script:GlyphDot = [string][char]0x00B7  # ·
    $script:SpinnerFrames = @([char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838, [char]0x283C, [char]0x2834, [char]0x2826, [char]0x2827, [char]0x2807, [char]0x280F | ForEach-Object { [string]$_ })
  }
  else {
    $script:R = ""; $script:BOLD = ""; $script:DIM = ""
    $script:RED = ""; $script:GREEN = ""; $script:YELLOW = ""; $script:CYAN = ""; $script:ORANGE = ""
    $script:GlyphOk = "+"; $script:GlyphFail = "x"; $script:GlyphWarn = "!"; $script:GlyphDot = "-"
    $script:SpinnerFrames = @("-", "\", "|", "/")
  }
}

function Write-Splash {
  Write-Host ""
  if ($script:UiAnsi) {
    $lines = @(
      "$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)  $([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557) $([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)",
      "$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)",
      "$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x255D)$([char]0x2588)$([char]0x2588)$([char]0x2551)   $([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)  ",
      "$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D) $([char]0x2588)$([char]0x2588)$([char]0x2551)   $([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x2550)$([char]0x2550)$([char]0x255D)  ",
      "$([char]0x2588)$([char]0x2588)$([char]0x2551)     $([char]0x255A)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2554)$([char]0x255D)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2551)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2588)$([char]0x2557)",
      "$([char]0x255A)$([char]0x2550)$([char]0x255D)      $([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D) $([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)$([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)$([char]0x255A)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x2550)$([char]0x255D)"
    )
    foreach ($line in $lines) {
      $n = $line.Length
      $sb = New-Object System.Text.StringBuilder
      [void]$sb.Append("  ")
      for ($i = 0; $i -lt $n; $i++) {
        $ch = $line[$i]
        if ($ch -eq " ") { [void]$sb.Append(" "); continue }
        $g = 153 - [int](153 * $i / ($n - 1))
        $b = [int](153 * $i / ($n - 1))
        [void]$sb.Append("$Esc[38;2;255;$g;$b" + "m$ch")
      }
      [void]$sb.Append($script:R)
      Write-Host $sb.ToString()
    }
  }
  else {
    Write-Host "   ____   ___  ____  ____  _____"
    Write-Host "  |  _ \ / _ \/ ___|/ ___|| ____|"
    Write-Host "  | |_) | | | \___ \\___ \|  _|"
    Write-Host "  |  __/| |_| |___) |___) | |___"
    Write-Host "  |_|    \___/|____/|____/|_____|"
  }
  Write-Host ("  {0}{1}Posse + ATLAS{2} {3}$([char]0x2014) multi-provider dev orchestrator $([char]0x00B7) Windows installer{2}" -f $script:BOLD, $script:ORANGE, $script:R, $script:DIM)
  Write-Host ("  {0}{1}{2}" -f $script:DIM, ("-" * 58), $script:R)
  Write-Host ""
}

function Format-Duration {
  param([int]$Seconds)
  if ($Seconds -ge 60) { return ("{0}m {1:d2}s" -f [int][math]::Floor($Seconds / 60), ($Seconds % 60)) }
  return "${Seconds}s"
}

# --- log file ------------------------------------------------------------------
# Uninstall logs to TEMP: ~\.posse may be the very directory being removed.
$script:LogDir = if ($Uninstall) { $env:TEMP } else { Join-Path $env:USERPROFILE ".posse\logs" }
try { New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null }
catch { $script:LogDir = $env:TEMP }
$script:LogFile = Join-Path $script:LogDir ("{0}-{1}.log" -f $(if ($Uninstall) { "posse-uninstall" } else { "install" }), (Get-Date -Format "yyyyMMdd-HHmmss"))
try { Set-Content -Path $script:LogFile -Value "" -Encoding UTF8 } catch { $script:LogFile = Join-Path $env:TEMP "posse-install.log" }

function Write-LogOnly { param([string]$Message) try { Add-Content -Path $script:LogFile -Value $Message -Encoding UTF8 } catch {} }

function Write-Info {
  param([string]$Message)
  Write-Host ("    {0}{1}{2} {3}" -f $script:DIM, $script:GlyphDot, $script:R, $Message)
  Write-LogOnly "[info] $Message"
}

$script:Warnings = @()
function Write-Warn2 {
  param([string]$Message)
  Write-Host ("    {0}{1}{2} {3}" -f $script:YELLOW, $script:GlyphWarn, $script:R, $Message)
  $script:Warnings += $Message
  Write-LogOnly "[warn] $Message"
}

$script:ScipLanguageOptions = @(
  [PSCustomObject]@{ Value = "typescript"; Label = "TypeScript / JavaScript"; Aliases = @("javascript", "node", "nodejs", "ts", "js") },
  [PSCustomObject]@{ Value = "python"; Label = "Python"; Aliases = @("py") },
  [PSCustomObject]@{ Value = "php"; Label = "PHP"; Aliases = @() },
  [PSCustomObject]@{ Value = "go"; Label = "Go"; Aliases = @("golang") },
  [PSCustomObject]@{ Value = "rust"; Label = "Rust"; Aliases = @("rs") },
  [PSCustomObject]@{ Value = "clang"; Label = "C / C++ (clang)"; Aliases = @("c", "c++", "cpp", "cxx", "cc") }
)
$script:ScipLanguageStepStatus = "ok"
# True when the user picked languages (-ScipLanguages or the prompt); that
# choice then replaces the saved account setting.
$script:ScipLanguagesChosen = $false
$script:ScipLanguageStepNote = ""

function Get-ScipLanguagesAllowedText {
  return (($script:ScipLanguageOptions | ForEach-Object { $_.Value }) -join ", ") + ", all"
}

function Test-ScipLanguageSelected {
  param([string]$Language)
  return (",$script:PosseScipLanguages,").Contains("," + $Language.ToLowerInvariant() + ",")
}

function Normalize-ScipLanguages {
  param([string]$Value)
  $tokens = @($Value -split "[,\s]+" | Where-Object { $_ -and $_.Trim() })
  if ($tokens.Count -eq 0) { throw "no SCIP languages selected" }

  $selected = New-Object System.Collections.Generic.List[string]
  $invalid = @()
  foreach ($token in $tokens) {
    $needle = $token.Trim().ToLowerInvariant()
    if ($needle -eq "all") {
      return (($script:ScipLanguageOptions | ForEach-Object { $_.Value }) -join ",")
    }
    $match = $script:ScipLanguageOptions | Where-Object {
      $_.Value -eq $needle -or ($_.Aliases -contains $needle)
    } | Select-Object -First 1
    if ($null -eq $match) {
      $invalid += $token
      continue
    }
    if (-not $selected.Contains($match.Value)) {
      [void]$selected.Add($match.Value)
    }
  }

  if ($invalid.Count -gt 0) {
    throw ("invalid SCIP language(s): {0}; allowed: {1}" -f ($invalid -join ", "), (Get-ScipLanguagesAllowedText))
  }
  if ($selected.Count -eq 0) { throw "no SCIP languages selected" }
  return ($selected -join ",")
}

function Resolve-ScipLanguageSelection {
  if ($ScipLanguagesSupplied) {
    try {
      $script:PosseScipLanguages = Normalize-ScipLanguages $script:PosseScipLanguages
      $script:ScipLanguageStepNote = "selected $script:PosseScipLanguages (-ScipLanguages)"
      $script:ScipLanguagesChosen = $true
      Write-Info "using -ScipLanguages: $script:PosseScipLanguages"
      return $true
    }
    catch {
      $script:ScipLanguageStepStatus = "failed"
      $script:ScipLanguageStepNote = $_.Exception.Message
      Write-LogOnly "[error] $($_.Exception.Message)"
      return $false
    }
  }

  try {
    $script:PosseScipLanguages = Normalize-ScipLanguages $script:PosseScipLanguages
  }
  catch {
    $script:ScipLanguageStepStatus = "failed"
    $script:ScipLanguageStepNote = $_.Exception.Message
    Write-LogOnly "[error] $($_.Exception.Message)"
    return $false
  }

  if ($SkipSettings) {
    $script:ScipLanguageStepStatus = "skipped"
    $script:ScipLanguageStepNote = "-SkipSettings; account language setting unchanged"
    Write-Info "initial SCIP language prompt skipped (-SkipSettings)"
    return $true
  }

  if (-not (Test-InteractiveInput)) {
    $script:ScipLanguageStepNote = "selected $script:PosseScipLanguages (default; no interactive terminal)"
    Write-Info "no interactive terminal for SCIP language selection; using default: $script:PosseScipLanguages"
    return $true
  }

  while ($true) {
    Write-Host ""
    Write-Host ("  {0}Initial SCIP language environments{1}" -f $script:BOLD, $script:R)
    Write-Host ("    Select one or more languages for first-run indexing. Press Enter for defaults [{0}]." -f $script:PosseScipLanguages)
    Write-Host "    Use numbers, names, comma-separated values, or 'all'."
    for ($i = 0; $i -lt $script:ScipLanguageOptions.Count; $i++) {
      $option = $script:ScipLanguageOptions[$i]
      $mark = if ((",$script:PosseScipLanguages,").Contains("," + $option.Value + ",")) { "*" } else { " " }
      Write-Host ("      {0}) [{1}] {2} ({3})" -f ($i + 1), $mark, $option.Label, $option.Value)
    }
    $answer = Read-Host "      Languages (numbers/names, comma-separated, or all)"
    if (-not $answer -or -not $answer.Trim()) {
      $script:ScipLanguageStepNote = "selected $script:PosseScipLanguages (default)"
      Write-Info "initial SCIP languages: $script:PosseScipLanguages"
      return $true
    }

    $selection = @()
    $invalidNumbers = @()
    foreach ($token in @($answer -split "[,\s]+" | Where-Object { $_ -and $_.Trim() })) {
      if ($token -match "^\d+$") {
        $idx = [int]$token - 1
        if ($idx -ge 0 -and $idx -lt $script:ScipLanguageOptions.Count) {
          $selection += $script:ScipLanguageOptions[$idx].Value
        }
        else {
          $invalidNumbers += $token
        }
      }
      else {
        $selection += $token
      }
    }
    if ($invalidNumbers.Count -gt 0) {
      Write-Host ("    {0}{1}{2} invalid option number(s): {3}" -f $script:YELLOW, $script:GlyphWarn, $script:R, ($invalidNumbers -join ", "))
      continue
    }
    try {
      $script:PosseScipLanguages = Normalize-ScipLanguages ($selection -join ",")
      $script:ScipLanguageStepNote = "selected $script:PosseScipLanguages (interactive)"
      $script:ScipLanguagesChosen = $true
      Write-Info "initial SCIP languages: $script:PosseScipLanguages"
      return $true
    }
    catch {
      Write-Host ("    {0}{1}{2} {3}" -f $script:YELLOW, $script:GlyphWarn, $script:R, $_.Exception.Message)
    }
  }
}

function Step-ScipLanguages {
  Step-Begin "languages"
  Write-Info "choose initial SCIP language environments before runtime doctor runs"
  if (Resolve-ScipLanguageSelection) {
    Step-End $script:ScipLanguageStepStatus $script:ScipLanguageStepNote
    return $true
  }
  $script:CriticalFailed = $true
  Step-End "failed" $script:ScipLanguageStepNote
  return $false
}

# --- step engine -----------------------------------------------------------------
# Order: the native download starts in the background right after npm (it
# needs Node, the checkout, its packages, and the Posse key, so keys are asked
# for first), and host tools install while it runs. Git, the one tool the
# checkout needs, is installed by the checkout step.
$script:StepKeys = @("languages", "preflight", "node", "checkout", "keys", "npm", "packages", "composer", "automation", "shell", "seed", "admin", "native", "doctor", "validate", "smoke")
$script:StepTitles = @{
  languages = "SCIP language selection"
  preflight = "Preflight checks"
  packages = "System packages"
  node     = "Node.js runtime"
  checkout = "Posse checkout"
  composer = "Composer (SCIP PHP)"
  npm      = "npm dependencies"
  automation = "Automation owner startup"
  shell    = "Shell wiring"
  seed     = "Account settings"
  doctor   = "Runtime doctor (SCIP + Jina)"
  admin    = "Provider CLI detection"
  keys     = "Provider API keys"
  native   = "Native binaries"
  validate = "Validation"
  smoke    = "ATLAS smoke test"
}
$script:StepStatus = @{}
$script:StepNote = @{}
foreach ($k in $script:StepKeys) { $script:StepStatus[$k] = "pending"; $script:StepNote[$k] = "" }
$script:StepIndex = 0
$script:CurrentStep = ""

# --- setup-package progress ---------------------------------------------------------
# Posse Setup draws its own progress page. With -ProgressFile the engine reports
# each step there in plain words while the full detail stays in the log.
$script:SetupStepText = @{
  languages  = @("Choosing indexing languages", "Indexing languages chosen")
  preflight  = @("Checking your system", "System checked")
  packages   = @("Installing tools", "Tools installed")
  node       = @("Installing Node.js", "Node.js ready")
  checkout   = @("Downloading Posse", "Posse downloaded")
  composer   = @("Setting up Composer for PHP", "Composer ready")
  npm        = @("Installing Posse's components", "Components installed")
  automation = @("Setting up background automation", "Background automation ready")
  shell      = @("Adding the posse command", "posse command added")
  seed       = @("Saving your settings", "Settings saved")
  admin      = @("Looking for AI provider apps", "AI provider apps checked")
  keys       = @("Saving your Posse key", "Posse key saved")
  native     = @("Downloading Posse's native tools", "Native tools downloaded")
  doctor     = @("Setting up code indexing", "Code indexing ready")
  validate   = @("Checking the install", "Install checked")
  smoke      = @("Testing code search", "Code search tested")
}
# Rough share of total setup time per step, so the bar moves at an honest pace.
$script:SetupStepWeight = @{
  languages = 1; preflight = 1; packages = 18; node = 7; checkout = 5; composer = 3; npm = 14; automation = 2
  shell = 1; seed = 1; admin = 2; keys = 1; native = 3; doctor = 32; validate = 3; smoke = 1
}

function Write-SetupProgress {
  param([string[]]$Fields)
  if (-not $ProgressFile) { return }
  # Setup reads lines of up to ~1000 characters and treats "-" as an empty field.
  $clean = @($Fields | ForEach-Object {
    $field = (([string]$_) -replace '[\t\r\n]+', ' ' -replace '[^\x20-\x7E]', '').Trim()
    if ($field.Length -gt 180) { $field = $field.Substring(0, 177) + "..." }
    if ($field) { $field } else { "-" }
  })
  $line = ($clean -join "`t") + "`r`n"
  # Setup reads this file while it grows; a brief sharing clash just retries.
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try { [System.IO.File]::AppendAllText($ProgressFile, $line, [System.Text.Encoding]::ASCII); return }
    catch { Start-Sleep -Milliseconds 50 }
  }
}

function Get-SetupPercent {
  param([string]$Key, [switch]$Including)
  $total = 0
  $before = 0
  $seen = $false
  foreach ($k in $script:StepKeys) {
    $weight = [int]$script:SetupStepWeight[$k]
    $total += $weight
    if ($k -eq $Key) { $seen = $true; if ($Including) { $before += $weight } }
    elseif (-not $seen) { $before += $weight }
  }
  if ($total -le 0) { return 0 }
  return [int][math]::Floor(100 * $before / $total)
}

# PowerShell wraps .NET exceptions; find the WebException underneath, if any.
function Get-WebException {
  param($Exception)
  $current = $Exception
  while ($current -and -not ($current -is [System.Net.WebException])) { $current = $current.InnerException }
  return $current
}

# Downloads a file and reports its percentage to the setup page, which
# Invoke-WebRequest cannot do. A dropped connection is retried, resuming from
# the bytes already received when the server supports ranges. Callers still
# verify the checksum afterwards.
function Save-Download {
  param([string]$Uri, [string]$OutFile, [string]$Activity, [int]$TimeoutSec = 600, [int]$Attempts = 3)
  Write-SetupProgress @("act", $Activity, "0")
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
  for ($attempt = 1; ; $attempt++) {
    try {
      Receive-DownloadAttempt -Uri $Uri -OutFile $OutFile -TimeoutSec $TimeoutSec
      break
    }
    catch {
      if ($attempt -ge $Attempts) { throw }
      # An HTTP error answer (not a dropped connection) restarts from zero.
      $web = Get-WebException $_.Exception
      if ($web -and $web.Response) { Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue }
      $wait = if ($attempt -eq 1) { 3 } else { 10 }
      Write-LogOnly ("[download] {0}: attempt {1} of {2} failed ({3}); retrying in {4}s" -f $Uri, $attempt, $Attempts, $_.Exception.Message, $wait)
      Start-Sleep -Seconds $wait
    }
  }
  Write-SetupProgress @("actpct", "100")
}

function Receive-DownloadAttempt {
  param([string]$Uri, [string]$OutFile, [int]$TimeoutSec)
  $offset = if (Test-Path -LiteralPath $OutFile) { [long](Get-Item -LiteralPath $OutFile).Length } else { [long]0 }
  $request = [System.Net.HttpWebRequest]::Create($Uri)
  $request.Timeout = $TimeoutSec * 1000
  $request.ReadWriteTimeout = 120000
  $request.UserAgent = "PosseSetup"
  if ($offset -gt 0) { $request.AddRange($offset) }
  $response = $request.GetResponse()
  try {
    # 206 resumes only when the range starts where this file ends; any other
    # answer is the whole file again.
    $resume = $false
    if ($offset -gt 0 -and [int]$response.StatusCode -eq 206) {
      $range = [regex]::Match([string]$response.Headers["Content-Range"], '^bytes (\d+)-')
      $resume = $range.Success -and ([long]$range.Groups[1].Value -eq $offset)
      if (-not $resume) {
        Remove-Item -LiteralPath $OutFile -Force -ErrorAction SilentlyContinue
        throw "the server resumed at the wrong byte"
      }
    }
    $received = if ($resume) { $offset } else { [long]0 }
    $total = if ($response.ContentLength -gt 0) { $response.ContentLength + $received } else { [long]-1 }
    $source = $response.GetResponseStream()
    $mode = if ($resume) { [System.IO.FileMode]::Append } else { [System.IO.FileMode]::Create }
    $target = [System.IO.File]::Open($OutFile, $mode, [System.IO.FileAccess]::Write)
    try {
      $buffer = New-Object byte[] 262144
      $reported = -1
      $reportedAt = [DateTime]::UtcNow
      while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $target.Write($buffer, 0, $read)
        $received += $read
        if ($total -gt 0) {
          $percent = [int][math]::Floor(100 * $received / $total)
          if ($percent -ne $reported -and ([DateTime]::UtcNow - $reportedAt).TotalMilliseconds -ge 250) {
            Write-SetupProgress @("actpct", $percent)
            $reported = $percent
            $reportedAt = [DateTime]::UtcNow
          }
        }
      }
    }
    finally {
      $target.Dispose()
      $source.Dispose()
    }
    if ($total -gt 0 -and $received -ne $total) { throw ("download ended after {0} of {1} bytes" -f $received, $total) }
  }
  finally { $response.Dispose() }
}

# "install ImageMagick (ImageMagick.Q16)" -> "Install ImageMagick"
function Format-SetupActivity {
  param([string]$Text)
  $plain = ($Text -replace '\s*\([^)]*\)\s*$', '').Trim()
  if (-not $plain) { return "" }
  return $plain.Substring(0, 1).ToUpperInvariant() + $plain.Substring(1)
}
$script:CriticalFailed = $false
$script:CheckoutIsInstallerSource = $false
$script:InstallFailed = $false
$script:SummaryPrinted = $false
$script:LastCommandStdout = ""

# Seconds each step took, for the log's closing "steps:" line.
$script:StepStartedAt = @{}
$script:StepSeconds = [ordered]@{}
$script:RunStartedAt = Get-Date

function Format-StepTimings {
  $parts = @($script:StepSeconds.Keys | ForEach-Object { "{0}={1}s" -f $_, $script:StepSeconds[$_] })
  $parts += ("total={0}s" -f [int]((Get-Date) - $script:RunStartedAt).TotalSeconds)
  return "steps: " + ($parts -join " ")
}

function Step-Begin {
  param([string]$Key)
  $script:CurrentStep = $Key
  $script:StepStartedAt[$Key] = Get-Date
  $script:StepIndex++
  Write-Host ""
  Write-Host ("{0}[{1,2}/{2}]{3} {4}{5}{6}" -f $script:DIM, $script:StepIndex, $script:StepKeys.Count, $script:R, $script:BOLD, $script:StepTitles[$Key], $script:R)
  Write-LogOnly ""
  Write-LogOnly ("===== [{0}/{1}] {2} =====" -f $script:StepIndex, $script:StepKeys.Count, $script:StepTitles[$Key])
  $text = $script:SetupStepText[$Key]
  if ($text) { Write-SetupProgress @("step", (Get-SetupPercent $Key), (Get-SetupPercent $Key -Including), $text[0]) }
}

function Step-End {
  param([string]$Status, [string]$Note = "")
  $script:StepStatus[$script:CurrentStep] = $Status
  $script:StepNote[$script:CurrentStep] = $Note
  if ($Status -eq "failed") { $script:InstallFailed = $true }
  $took = ""
  if ($script:StepStartedAt.ContainsKey($script:CurrentStep)) {
    $seconds = [int]((Get-Date) - $script:StepStartedAt[$script:CurrentStep]).TotalSeconds
    $script:StepSeconds[$script:CurrentStep] = $seconds
    $took = " [{0}s]" -f $seconds
  }
  Write-LogOnly ("----- {0}: {1}{2}{3}" -f $script:CurrentStep, $Status, $(if ($Note) { " ($Note)" } else { "" }), $took)
  $text = $script:SetupStepText[$script:CurrentStep]
  if ($text) { Write-SetupProgress @("end", $Status, $text[1], $text[0], $Note) }
  switch -Regex ($Status) {
    "^(ok|done)$"        { Write-Host ("    {0}{1}{2} {3}" -f $script:GREEN, $script:GlyphOk, $script:R, $(if ($Note) { $Note } else { "done" })) }
    "^(skipped|dry-run)$" { Write-Host ("    {0}{1} {2}{3}" -f $script:DIM, $script:GlyphDot, $(if ($Note) { $Note } else { $Status }), $script:R) }
    "^partial$"          { Write-Host ("    {0}{1}{2} {3}" -f $script:YELLOW, $script:GlyphWarn, $script:R, $(if ($Note) { $Note } else { "completed with warnings" })) }
    "^failed$"           { Write-Host ("    {0}{1}{2} {3}" -f $script:RED, $script:GlyphFail, $script:R, $(if ($Note) { $Note } else { "failed" })) }
    "^blocked$"          { Write-Host ("    {0}{1} {2}{3}" -f $script:DIM, $script:GlyphFail, $(if ($Note) { $Note } else { "blocked by an earlier failure" }), $script:R) }
  }
}

function Step-FailCritical {
  param([string]$Note)
  $script:CriticalFailed = $true
  Step-End -Status "failed" -Note $Note
}

function Invoke-InstallerStep {
  param(
    [string]$Key,
    [scriptblock]$Body,
    [switch]$Critical
  )
  try {
    & $Body
  }
  catch {
    $message = ($_.Exception.Message -split "`r?`n" | Select-Object -First 1)
    Write-LogOnly ("[error] {0}: {1}" -f $Key, $_.Exception.ToString())
    Write-Warn2 ("{0} failed: {1}" -f $script:StepTitles[$Key], $message)
    if ($script:StepStatus[$Key] -eq "pending") {
      $script:CurrentStep = $Key
      Step-End "failed" $message
    }
    else {
      $script:InstallFailed = $true
    }
    if ($Critical) { $script:CriticalFailed = $true }
  }
}

function Block-PendingSteps {
  param([string]$Note = "blocked by an earlier failure")
  foreach ($key in $script:StepKeys) {
    if ($script:StepStatus[$key] -eq "pending") {
      $script:StepStatus[$key] = "blocked"
      $script:StepNote[$key] = $Note
    }
  }
}

function Quote-NativeArg {
  param([string]$Value)
  if ($Value -eq "") { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Format-CommandLine {
  param([string[]]$Parts)
  return (($Parts | ForEach-Object { Quote-NativeArg $_ }) -join " ")
}

function Stop-InstallerProcessTree {
  param([System.Diagnostics.Process]$Process)
  if (-not $Process) { return }
  try { if ($Process.HasExited) { return } } catch { return }
  $stopped = $false
  try {
    $killInfo = New-Object System.Diagnostics.ProcessStartInfo
    $killInfo.FileName = "taskkill.exe"
    $killInfo.Arguments = "/pid $($Process.Id) /t /f"
    $killInfo.UseShellExecute = $false
    $killInfo.CreateNoWindow = $true
    $kill = [System.Diagnostics.Process]::Start($killInfo)
    if ($kill) {
      [void]$kill.WaitForExit(5000)
      $stopped = $kill.HasExited -and $kill.ExitCode -eq 0
    }
  }
  catch {}
  if (-not $stopped) { try { $Process.Kill() } catch {} }
}

# Runs native executables directly so cmd.exe cannot reinterpret paths, smoke
# queries, or other arguments. Batch launchers such as npm.cmd still use a
# minimal cmd.exe wrapper, with output captured through redirected streams.
function Invoke-Logged {
  param(
    [string]$Description,
    [string[]]$Command,
    [string]$WorkingDirectory = "",
    [int]$TimeoutSeconds = $CommandTimeoutSeconds,
    [string]$Activity = "",
    # The caller tries alternatives and reports the outcome; keep a failed
    # attempt to one line here (the full output still goes to the log).
    [switch]$QuietFailure
  )
  $cmdLine = Format-CommandLine $Command
  Write-SetupProgress @("act", $(if ($Activity) { $Activity } else { Format-SetupActivity $Description }))
  Write-LogOnly ""
  Write-LogOnly (">>> {0}" -f $Description)
  Write-LogOnly (">>> `$ {0}" -f $cmdLine)
  if ($DryRun) {
    Write-Host ("    {0}{1} (dry-run) would run:{2} {3}" -f $script:DIM, $script:GlyphDot, $script:R, $Description)
    return 0
  }

  $started = Get-Date

  $commandInfo = Get-Command $Command[0] -ErrorAction SilentlyContinue
  $executable = if ($commandInfo -and $commandInfo.Source) { $commandInfo.Source } else { $Command[0] }
  $arguments = @($Command | Select-Object -Skip 1)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # PowerShell resolves bare `npm` to npm.ps1 before npm.cmd on a standard
  # Node install. Launch npm's JS entrypoint with its adjacent node.exe so
  # execution policy and cmd.exe argument parsing cannot break fresh installs.
  # Bare `npm` uses the entrypoint Step-Node verified for the chosen Node, so
  # a version manager's shim (Volta, scoop) cannot pick a different runtime.
  $npmCli = ""
  $npmNode = ""
  if ($Command[0] -eq "npm" -and $script:NpmCli -and $script:NodeBin) {
    $npmCli = $script:NpmCli
    $npmNode = $script:NodeBin
  }
  elseif ($executable -match '(?i)\\npm\.(cmd|ps1)$') {
    $candidate = Join-Path (Split-Path $executable -Parent) "node_modules\npm\bin\npm-cli.js"
    if (Test-Path $candidate) {
      $npmCli = $candidate
      $adjacentNode = Join-Path (Split-Path $executable -Parent) "node.exe"
      $npmNode = if (Test-Path $adjacentNode) { $adjacentNode } else { $script:NodeBin }
    }
  }
  if ($npmCli) {
    $psi.FileName = $npmNode
    $psi.Arguments = ((@($npmCli) + $arguments) | ForEach-Object { Quote-NativeArg $_ }) -join " "
  }
  elseif ($executable -match '\.(cmd|bat)$') {
    $batchParts = @($executable) + $arguments
    $batchLine = ($batchParts | ForEach-Object { '"' + ($_ -replace '"', '""') + '"' }) -join " "
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /s /c "' + $batchLine + '"'
  }
  else {
    $psi.FileName = $executable
    $psi.Arguments = ($arguments | ForEach-Object { Quote-NativeArg $_ }) -join " "
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()
  $timedOut = $false
  $i = 0
  $n = $script:SpinnerFrames.Count
  $plainShown = $false

  try {
    while (-not $proc.HasExited) {
      $elapsed = [int]((Get-Date) - $started).TotalSeconds
      if ($TimeoutSeconds -gt 0 -and $elapsed -ge $TimeoutSeconds) {
        $timedOut = $true
        Stop-InstallerProcessTree $proc
        break
      }
      if ($script:UiSpinner) {
        Write-Host ("`r$Esc[2K    {0}{1}{2} {3} {4}({5}){6}" -f $script:CYAN, $script:SpinnerFrames[$i % $n], $script:R, $Description, $script:DIM, (Format-Duration $elapsed), $script:R) -NoNewline
        $i++
      }
      elseif (-not $plainShown) {
        Write-Host ("    {0}{1}{2} {3}" -f $script:DIM, $script:GlyphDot, $script:R, $Description)
        $plainShown = $true
      }
      Start-Sleep -Milliseconds 120
    }
  }
  finally {
    if (-not $proc.HasExited) { Stop-InstallerProcessTree $proc }
  }

  $processExited = $false
  try { $processExited = $proc.WaitForExit(5000) } catch {}
  if (-not $processExited) {
    $timedOut = $true
    Stop-InstallerProcessTree $proc
    try { $processExited = $proc.WaitForExit(5000) } catch {}
  }
  if ($processExited) {
    # Flush redirected async readers after the process handle has signaled.
    $proc.WaitForExit()
  }
  if ($script:UiSpinner) { Write-Host "`r$Esc[2K" -NoNewline }
  $rc = if ($timedOut -or -not $processExited) { 124 } else { $proc.ExitCode }
  $elapsedTotal = [int]((Get-Date) - $started).TotalSeconds

  $chunkContent = if ($processExited) {
    (($stdoutTask.Result, $stderrTask.Result) | Where-Object { $_ }) -join "`r`n"
  } else {
    "process tree did not exit after cancellation"
  }
  if ($timedOut) { $chunkContent = ($chunkContent + "`r`ntimed out after ${TimeoutSeconds}s").Trim() }
  if ($chunkContent) { Write-LogOnly $chunkContent.TrimEnd() }
  Write-LogOnly ("<<< exit {0} after {1}s" -f $rc, $elapsedTotal)
  # Callers that read a command's report (doctor --json) take it from here.
  $script:LastCommandStdout = if ($processExited) { [string]$stdoutTask.Result } else { "" }

  if ($rc -eq 0) {
    Write-Host ("    {0}{1}{2} {3} {4}({5}){6}" -f $script:GREEN, $script:GlyphOk, $script:R, $Description, $script:DIM, (Format-Duration $elapsedTotal), $script:R)
  }
  elseif ($QuietFailure) {
    Write-Host ("    {0}{1} {2}: not available here{3}" -f $script:DIM, $script:GlyphDot, $Description, $script:R)
  }
  else {
    Write-Host ("    {0}{1}{2} {3} {4}(exit {5} after {6}){7}" -f $script:RED, $script:GlyphFail, $script:R, $Description, $script:DIM, $rc, (Format-Duration $elapsedTotal), $script:R)
    if ($chunkContent) {
      Write-Host ("    {0}| last output:{1}" -f $script:DIM, $script:R)
      ($chunkContent -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 10) | ForEach-Object { Write-Host ("      " + $_) }
      Write-Host ("    {0}| full log: {1}{2}" -f $script:DIM, $script:LogFile, $script:R)
    }
  }
  return $rc
}

# --- summary ----------------------------------------------------------------------
function Print-Summary {
  if ($script:SummaryPrinted) { return }
  $script:SummaryPrinted = $true
  Write-Host ""
  Write-Host ("  {0}{1}{2}" -f $script:DIM, ("-" * 58), $script:R)
  Write-Host ("  {0}{1} summary{2}" -f $script:BOLD, $(if ($Uninstall) { "Uninstall" } else { "Install" }), $script:R)
  foreach ($key in $script:StepKeys) {
    $status = $script:StepStatus[$key]
    $note = $script:StepNote[$key]
    switch -Regex ($status) {
      "^(ok|done)$" { $color = $script:GREEN;  $glyph = $script:GlyphOk }
      "^partial$"   { $color = $script:YELLOW; $glyph = $script:GlyphWarn }
      "^failed$"    { $color = $script:RED;    $glyph = $script:GlyphFail }
      "^blocked$"   { $color = $script:DIM;    $glyph = $script:GlyphFail }
      default       { $color = $script:DIM;    $glyph = $script:GlyphDot }
    }
    $noteSuffix = if ($note) { " {0}- {1}{2}" -f $script:DIM, $note, $script:R } else { "" }
    Write-Host ("    {0}{1}{2} {3,-31} {4}{5}{6}{7}" -f $color, $glyph, $script:R, $script:StepTitles[$key], $color, $status, $script:R, $noteSuffix)
  }
  if ($script:Warnings.Count -gt 0) {
    Write-Host ""
    Write-Host ("  {0}Warnings ({1}):{2}" -f $script:YELLOW, $script:Warnings.Count, $script:R)
    foreach ($w in $script:Warnings) { Write-Host ("    {0}{1}{2} {3}" -f $script:YELLOW, $script:GlyphWarn, $script:R, $w) }
  }
  Write-Host ""
  if (-not $Uninstall) {
    $timings = Format-StepTimings
    Write-LogOnly $timings
    Write-Host ("  {0}{1}{2}" -f $script:DIM, $timings, $script:R)
  }
  Write-Host ("  {0}Log:{1} {2}" -f $script:DIM, $script:R, $script:LogFile)
  Write-Host ""
  if ($Uninstall) {
    if ($script:InstallFailed) { Write-Host ("  {0}{1}Uninstall left items behind.{2} See the failed step above." -f $script:RED, $script:BOLD, $script:R) }
    Write-Host ""
    return
  }
  if ($script:InstallFailed) {
    Write-Host ("  {0}{1}Install did not complete.{2} Fix the failed step above and re-run - completed steps are skipped on re-runs." -f $script:RED, $script:BOLD, $script:R)
  }
  else {
    if ($SetupOnly) {
      Write-Host "Core installation complete; runtime readiness has NOT been checked. Supply POSSE_KEY and re-run without -SetupOnly."
      return
    }
    Write-Host ("  {0}Next steps:{1}" -f $script:BOLD, $script:R)
    Write-Host "    1. Open a new terminal (PATH changes need a fresh shell)"
    Write-Host ("    2. cd <your project>; posse add     {0}# describe a task{1}" -f $script:DIM, $script:R)
    Write-Host ("    3. posse go                         {0}# plan + run{1}" -f $script:DIM, $script:R)
  }
  Write-Host ""
}

# =============================================================================
# helpers
# =============================================================================

function Test-Cmd { param([string]$Name) return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

function Test-InteractiveInput {
  if ($NonInteractive -or $SetupOnly -or $DryRun) { return $false }
  if ([Environment]::GetCommandLineArgs() -contains "-NonInteractive") { return $false }
  try { return -not [Console]::IsInputRedirected } catch { return $false }
}

function Get-PersistentExecutionPolicy {
  try {
    $policies = @(Get-ExecutionPolicy -List)
    foreach ($scope in @("MachinePolicy", "UserPolicy", "CurrentUser", "LocalMachine")) {
      $entry = $policies | Where-Object { $_.Scope -eq $scope } | Select-Object -First 1
      if ($entry -and $entry.ExecutionPolicy -ne "Undefined") { return [string]$entry.ExecutionPolicy }
    }
  }
  catch {}
  return "Restricted"
}

function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
  if (-not $key) { return "" }
  try {
    return [string]$key.GetValue(
      "Path",
      "",
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
  }
  finally { $key.Dispose() }
}

function Set-UserPathRaw {
  param([string]$Value)
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  try { $key.SetValue("Path", $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
  finally { $key.Dispose() }
}

function Send-EnvironmentChangeBroadcast {
  # HKCU Environment writes are invisible to Explorer-launched terminals until
  # a WM_SETTINGCHANGE "Environment" broadcast. SetEnvironmentVariable(User)
  # broadcasts on its own; raw registry PATH writes must do it here.
  try {
    if (-not ("PosseNative.EnvBroadcast" -as [type])) {
      Add-Type -Namespace PosseNative -Name EnvBroadcast -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    [UIntPtr]$result = [UIntPtr]::Zero
    # 0xFFFF = HWND_BROADCAST, 0x1A = WM_SETTINGCHANGE, 2 = SMTO_ABORTIFHUNG
    [void][PosseNative.EnvBroadcast]::SendMessageTimeout([IntPtr]0xFFFF, 0x1A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
  }
  catch { Write-LogOnly ("[env-broadcast] {0}" -f $_.Exception.Message) }
}

function Expand-PathEntry {
  param([string]$Entry)
  if ([string]::IsNullOrWhiteSpace($Entry)) { return "" }
  try { return [Environment]::ExpandEnvironmentVariables($Entry) } catch { return $Entry }
}

function Test-DirectoryWriteAccess {
  param([string]$DirectoryPath, [switch]$Create)
  if ([string]::IsNullOrWhiteSpace($DirectoryPath)) { return $false }
  $probeDir = Resolve-FullPath $DirectoryPath
  try {
    if (-not (Test-Path -LiteralPath $probeDir)) {
      if (-not $Create) { return $false }
      New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    }
    $probePath = Join-Path $probeDir (".posse-write-probe-" + [Guid]::NewGuid().ToString("N"))
    try {
      [System.IO.File]::WriteAllText($probePath, "ok", (New-Object System.Text.UTF8Encoding($false)))
    }
    finally {
      Remove-Item -LiteralPath $probePath -Force -ErrorAction SilentlyContinue
    }
    return $true
  }
  catch {
    Write-LogOnly ("[write-probe] {0}: {1}" -f $probeDir, $_.Exception.Message)
    return $false
  }
}

# What `node` on PATH really is. Version managers (Volta, scoop, nvm) put a
# shim first on PATH, so ask Node for its own executable, and look for npm's
# entrypoint beside it, then beside the `npm` on PATH. Invoke-Logged launches
# npm through that entrypoint (see there), so a Node whose npm cannot be found
# this way is not usable even when `npm` runs.
function Get-NodeRuntimeInfo {
  $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { return $null }
  $info = [PSCustomObject]@{ Path = $node.Source; NodeBin = ""; Version = ""; Major = 0; NpmCli = "" }
  try { $reported = [string]((& $node.Source -p "[process.execPath, process.versions.node].join('|')") 2>$null | Select-Object -First 1) }
  catch { $reported = "" }
  if ($LASTEXITCODE -ne 0 -or $reported -notmatch '^(.+)\|((\d+)\.\d+\.\d+)$') { return $info }
  $info.NodeBin = $Matches[1]
  $info.Version = $Matches[2]
  $info.Major = [int]$Matches[3]
  $candidates = @(Join-Path (Split-Path $info.NodeBin -Parent) "node_modules\npm\bin\npm-cli.js")
  $npm = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($npm -and $npm.Source) { $candidates += Join-Path (Split-Path $npm.Source -Parent) "node_modules\npm\bin\npm-cli.js" }
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    try {
      & $info.NodeBin $candidate --version *> $null
      if ($LASTEXITCODE -eq 0) { $info.NpmCli = $candidate; break }
    }
    catch {}
  }
  return $info
}

function Resolve-FullPath {
  param([string]$PathValue)
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return $PathValue }
  try { return $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($PathValue) }
  catch { return [System.IO.Path]::GetFullPath($PathValue) }
}

function Get-InstallerPosseDir {
  if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) { return "" }
  $candidate = Resolve-FullPath (Join-Path $PSScriptRoot "..\..")
  if (Test-Path (Join-Path $candidate "orchestrator.js")) { return $candidate }
  return ""
}

function Resolve-PosseRootFromCheckout {
  param([string]$CheckoutDir)
  if ([string]::IsNullOrWhiteSpace($CheckoutDir)) { return "" }
  $root = Resolve-FullPath $CheckoutDir
  if (Test-Path (Join-Path $root "orchestrator.js")) { return $root }
  $nested = Join-Path $root "posse"
  if (Test-Path (Join-Path $nested "orchestrator.js")) { return $nested }
  return ""
}

# Trimmed stdout of a git probe in $Repo, or $null when git fails or is missing.
function Get-GitOutput {
  param([string]$Repo, [string[]]$GitArgs, [int]$TimeoutMs = 30000)
  $git = Get-Command git -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $git -or -not $git.Source) { return $null }
  $result = Get-NativeOutput $git.Source (@("-C", $Repo) + $GitArgs) $TimeoutMs
  if (-not $result -or $result.ExitCode -ne 0) { return $null }
  return ([string]$result.StdOut).Trim()
}

# A checkout left by an earlier install is brought up to date the way `posse
# update` does it: only a tree without local changes moves, and only forward,
# so local work is never lost. A copy this installer manages may instead be
# reset onto the current release when its history cannot fast-forward.
function Update-PosseCheckout {
  param([string]$Root, [switch]$Managed)
  $top = Get-GitOutput $Root @("rev-parse", "--show-toplevel")
  if (-not $top) { return [PSCustomObject]@{ Ok = $false; Note = "not a git checkout, so setup cannot update it" } }
  $branch = Get-GitOutput $top @("rev-parse", "--abbrev-ref", "HEAD")
  if (-not $branch -or $branch -eq "HEAD") { return [PSCustomObject]@{ Ok = $false; Note = "no branch is checked out, so setup cannot update it" } }
  $dirty = Get-GitOutput $top @("status", "--porcelain", "--untracked-files=no")
  if ($null -eq $dirty) { return [PSCustomObject]@{ Ok = $false; Note = "git could not read it, so setup did not update it" } }
  if ($dirty) { return [PSCustomObject]@{ Ok = $false; Note = "it has local changes, so setup did not update it" } }
  if ($DryRun) { return [PSCustomObject]@{ Ok = $true; Note = ("would update it from origin/{0}" -f $branch) } }

  $rc = Invoke-Logged -Description ("fetch origin/{0} for the existing checkout" -f $branch) -Activity "Checking for a newer Posse" -Command @("git", "-C", $top, "fetch", "origin", $branch) -QuietFailure
  $before = Get-GitOutput $top @("rev-parse", "HEAD")
  $after = if ($rc -eq 0) { Get-GitOutput $top @("rev-parse", "FETCH_HEAD") } else { $null }
  if (-not $before -or -not $after) { return [PSCustomObject]@{ Ok = $false; Note = ("could not fetch origin/{0}; see log" -f $branch) } }
  if ($before -eq $after) { return [PSCustomObject]@{ Ok = $true; Note = ("already current at {0}" -f $before.Substring(0, 9)) } }

  if ($null -ne (Get-GitOutput $top @("merge-base", "--is-ancestor", $before, $after))) {
    $command = @("git", "-C", $top, "merge", "--ff-only", $after)
  }
  elseif ($Managed) {
    $command = @("git", "-C", $top, "reset", "--hard", $after)
  }
  else {
    return [PSCustomObject]@{ Ok = $false; Note = ("it cannot fast-forward to origin/{0}, so setup did not update it" -f $branch) }
  }
  $rc = Invoke-Logged -Description ("update the existing checkout to origin/{0}" -f $branch) -Activity "Updating Posse" -Command $command
  if ($rc -ne 0) { return [PSCustomObject]@{ Ok = $false; Note = "updating it failed; see log" } }
  return [PSCustomObject]@{ Ok = $true; Note = ("updated {0} -> {1}" -f $before.Substring(0, 9), $after.Substring(0, 9)) }
}

# Winget installs land on Machine/User PATH, which this process doesn't see.
# Re-merge them (preserving process-local additions) so freshly installed
# tools are visible without a new shell.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $merged = @()
  foreach ($part in (($machine, $user, $env:Path) -join ";") -split ";") {
    $p = $part.Trim()
    if ($p -and ($merged -notcontains $p)) { $merged += $p }
  }
  $env:Path = $merged -join ";"
}

# A fresh terminal sees only the saved Machine + User PATH. A tool visible only
# to this session, or only through a winget alias, breaks the next shell, so
# tools are located and verified against the saved PATH.
function Get-SavedPathDirs {
  $dirs = @()
  foreach ($raw in @([Environment]::GetEnvironmentVariable("Path", "Machine"), (Get-UserPathRaw))) {
    foreach ($entry in ([string]$raw -split ";")) {
      $expanded = Expand-PathEntry $entry
      if ($expanded) { $dirs += $expanded.TrimEnd("\") }
    }
  }
  return $dirs
}

# winget exposes portable packages through symlinks in WinGet\Links. Tools that
# find their own files beside the launched binary (PHP's php.ini and ext\)
# break through those links, so resolve to the real file.
function Resolve-RealExecutable {
  param([string]$PathValue)
  $current = $PathValue
  for ($hop = 0; $hop -lt 8; $hop++) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if (-not $item -or -not $item.LinkType -or -not $item.Target) { break }
    $target = [string]@($item.Target)[0]
    if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path $current -Parent) $target }
    $current = Resolve-FullPath $target
  }
  return $current
}

function Test-ExecutableLink {
  param([string]$PathValue)
  $item = Get-Item -LiteralPath $PathValue -Force -ErrorAction SilentlyContinue
  return [bool]($item -and $item.LinkType)
}

function Find-ExeOnSavedPath {
  param([string]$Exe)
  foreach ($dir in (Get-SavedPathDirs)) {
    $candidate = Join-Path $dir $Exe
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  return ""
}

function Add-UserPathEntry {
  param([string]$Dir, [switch]$Prepend)
  $Dir = $Dir.TrimEnd("\")
  $sessionParts = @($env:Path -split ";" | Where-Object { $_ -and ($_.TrimEnd("\") -ine $Dir) })
  $env:Path = $(if ($Prepend) { @($Dir) + $sessionParts } else { $sessionParts + @($Dir) }) -join ";"
  if ($NoPersistEnv -or $DryRun) { return $false }
  $userPath = Get-UserPathRaw
  $parts = @($userPath -split ";" | Where-Object { $_ -and ((Expand-PathEntry $_).TrimEnd("\") -ine $Dir) })
  $newUserPath = $(if ($Prepend) { @($Dir) + $parts } else { $parts + @($Dir) }) -join ";"
  if ($newUserPath -ieq $userPath) { return $false }
  Set-UserPathRaw $newUserPath
  Send-EnvironmentChangeBroadcast
  return $true
}

# --- find before installing ------------------------------------------------------
# A tool that is already on this PC and new enough counts as installed, wherever
# it came from. Candidates come from PATH, Windows' installed-app registry and
# App Paths, package-manager folders, each tool's usual folders, and winget's
# package folders; the first copy whose version probe passes is used.

# Installed apps as Apps & features lists them, read once per run.
$script:InstalledApps = @()
$script:InstalledAppsRead = $false
function Get-InstalledApps {
  if ($script:InstalledAppsRead) { return $script:InstalledApps }
  $apps = @()
  foreach ($root in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
  )) {
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
      try {
        $entry = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
        if ($entry.DisplayName) {
          $apps += [PSCustomObject]@{ Name = [string]$entry.DisplayName; Location = [string]$entry.InstallLocation; Icon = [string]$entry.DisplayIcon }
        }
      }
      catch {}
    }
  }
  $script:InstalledApps = $apps
  $script:InstalledAppsRead = $true
  return $apps
}

function Get-RegisteredAppDirs {
  param($Tool)
  $dirs = @()
  # App Paths is Windows' own "where is this program" registry.
  foreach ($hive in @("HKCU:", "HKLM:")) {
    try {
      $entry = Get-ItemProperty -LiteralPath ("{0}\Software\Microsoft\Windows\CurrentVersion\App Paths\{1}" -f $hive, $Tool.Exe) -ErrorAction Stop
      $default = ([string]$entry.'(default)').Trim('"')
      if ($default) { $dirs += (Split-Path $default -Parent) }
      if ($entry.Path) { $dirs += [string]$entry.Path }
    }
    catch {}
  }
  foreach ($pattern in @($Tool.AppNames | Where-Object { $_ })) {
    foreach ($app in @(Get-InstalledApps | Where-Object { $_.Name -like $pattern })) {
      $bases = @($app.Location)
      if ($app.Icon) { $bases += (Split-Path (($app.Icon -split ",")[0].Trim().Trim('"')) -Parent) }
      foreach ($base in @($bases | Where-Object { $_ })) {
        $dirs += @($base, (Join-Path $base "bin"), (Join-Path $base "cmd"))
      }
    }
  }
  return $dirs
}

function Get-PackageManagerDirs {
  $dirs = @((Join-Path $localAppDataRoot "Microsoft\WinGet\Links"))
  if ($env:ProgramFiles) { $dirs += (Join-Path $env:ProgramFiles "WinGet\Links") }
  $scoop = if ($env:SCOOP) { $env:SCOOP } else { Join-Path $env:USERPROFILE "scoop" }
  $dirs += (Join-Path $scoop "shims")
  $choco = if ($env:ChocolateyInstall) { $env:ChocolateyInstall } elseif ($env:ProgramData) { Join-Path $env:ProgramData "chocolatey" } else { "" }
  if ($choco) { $dirs += (Join-Path $choco "bin") }
  return $dirs
}

# Expands %VARS% and wildcards (newest-looking folder first).
function Expand-KnownDirs {
  param([string[]]$Patterns)
  $dirs = @()
  foreach ($pattern in @($Patterns | Where-Object { $_ })) {
    $expanded = Expand-PathEntry $pattern
    if ($expanded -match '[*?]') {
      $dirs += @(Get-Item -Path $expanded -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer } | Sort-Object Name -Descending | ForEach-Object { $_.FullName })
    }
    elseif ($expanded) { $dirs += $expanded }
  }
  return $dirs
}

function Get-ToolCandidates {
  param($Tool)
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($command in @(Get-Command $Tool.Exe -CommandType Application -All -ErrorAction SilentlyContinue)) {
    if ($command.Source -and -not $found.Contains($command.Source)) { $found.Add($command.Source) }
  }
  $dirs = @(Get-SavedPathDirs) + @(Get-RegisteredAppDirs $Tool) + @(Get-PackageManagerDirs) + @(Expand-KnownDirs $Tool.KnownDirs)
  if ($Tool.Locate) { $dirs += @(& $Tool.Locate) }
  foreach ($dir in @($dirs | Where-Object { $_ })) {
    $candidate = Join-Path $dir $Tool.Exe
    if (-not $found.Contains($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { $found.Add($candidate) }
  }
  $wingetRoots = @((Join-Path $localAppDataRoot "Microsoft\WinGet"))
  if ($env:ProgramFiles) { $wingetRoots += (Join-Path $env:ProgramFiles "WinGet") }
  foreach ($root in $wingetRoots) {
    foreach ($id in @($Tool.WingetIds | Where-Object { $_ })) {
      foreach ($package in @(Get-ChildItem -LiteralPath (Join-Path $root "Packages") -Directory -Filter ($id + "_*") -ErrorAction SilentlyContinue)) {
        foreach ($hit in @(Get-ChildItem -LiteralPath $package.FullName -Filter $Tool.Exe -File -Recurse -Depth 3 -ErrorAction SilentlyContinue)) {
          if (-not $found.Contains($hit.FullName)) { $found.Add($hit.FullName) }
        }
      }
    }
  }
  return ,$found.ToArray()
}

# Runs the tool's version command. A copy that does not run (a Store
# placeholder, a broken install) is not a candidate at all.
function Get-ToolVersion {
  param($Tool, [string]$Path)
  $arguments = if ($Tool.VersionArgs) { $Tool.VersionArgs } else { @("--version") }
  $probe = Get-NativeOutput $Path $arguments
  if (-not $probe -or $probe.ExitCode -ne 0) { return [PSCustomObject]@{ Runs = $false; Version = $null } }
  $pattern = if ($Tool.VersionPattern) { $Tool.VersionPattern } else { '(\d+)\.(\d+)' }
  $match = [regex]::Match([string]$probe.Output, $pattern)
  $version = if ($match.Success) { [version]("{0}.{1}" -f $match.Groups[1].Value, $match.Groups[2].Value) } else { $null }
  return [PSCustomObject]@{ Runs = $true; Version = $version }
}

function Find-CompliantTool {
  param($Tool)
  $tooOld = $null
  foreach ($path in (Get-ToolCandidates $Tool)) {
    $real = if ($Tool.RealDirFirst) { Resolve-RealExecutable $path } else { $path }
    $dir = Split-Path $real -Parent
    if (@($Tool.Companions | Where-Object { $_ -and -not (Test-Path -LiteralPath (Join-Path $dir $_)) }).Count -gt 0) { continue }
    $probe = Get-ToolVersion $Tool $real
    if (-not $probe.Runs) { continue }
    if ($Tool.MinVersion -and (-not $probe.Version -or $probe.Version -lt [version]$Tool.MinVersion)) {
      if (-not $tooOld) { $tooOld = [PSCustomObject]@{ Path = $real; Version = $probe.Version } }
      continue
    }
    return [PSCustomObject]@{ Path = $real; Version = $probe.Version; TooOld = $null }
  }
  return [PSCustomObject]@{ Path = ""; Version = $null; TooOld = $tooOld }
}

# Puts a found copy where a new terminal will use it: on the saved PATH, ahead
# of any other copy of the same command. Returns a note when PATH changed.
function Use-ToolPath {
  param($Tool, [string]$Path)
  $dir = (Split-Path $Path -Parent).TrimEnd("\")
  $first = Find-ExeOnSavedPath $Tool.Exe
  $isFirst = $first -and ((Resolve-RealExecutable $first) -ieq (Resolve-RealExecutable $Path)) -and -not ($Tool.RealDirFirst -and (Test-ExecutableLink $first))
  if ($isFirst) {
    if (-not (@($env:Path -split ";") | Where-Object { $_ -and $_.TrimEnd("\") -ieq (Split-Path $first -Parent).TrimEnd("\") })) {
      $env:Path = (Split-Path $first -Parent) + ";" + $env:Path
    }
    return ""
  }
  # The system PATH always comes before the user PATH, so a different copy
  # there still wins in new terminals; say so instead of pretending otherwise.
  $machineDirs = @(([string][Environment]::GetEnvironmentVariable("Path", "Machine")) -split ";" | ForEach-Object { (Expand-PathEntry $_).TrimEnd("\") })
  if ($first -and ($machineDirs -icontains (Split-Path $first -Parent).TrimEnd("\"))) {
    Write-Warn2 ("{0} at {1} comes first on the system PATH; Posse needs the copy in {2}" -f $Tool.Label, $first, $dir)
  }
  try {
    if (Add-UserPathEntry $dir -Prepend:([bool]$first -or [bool]$Tool.RealDirFirst)) { return ("added {0} to your PATH" -f $dir) }
  }
  catch { Write-Warn2 ("could not save {0} to your PATH: {1}" -f $dir, $_.Exception.Message) }
  return ("using {0}" -f $dir)
}

# Is this requirement met, and if so by which copy? Tools without an
# executable to look for (none today) fall back to their Test.
function Resolve-ToolRequirement {
  param($Tool)
  if (-not $Tool.Exe) {
    return [PSCustomObject]@{ Satisfied = [bool](& $Tool.Test); Path = ""; Version = $null; Note = ""; TooOld = $null }
  }
  $found = Find-CompliantTool $Tool
  if ($found.Path) {
    $note = Use-ToolPath $Tool $found.Path
    return [PSCustomObject]@{ Satisfied = $true; Path = $found.Path; Version = $found.Version; Note = $note; TooOld = $null }
  }
  if ($Tool.Fallback -and (& $Tool.Fallback)) {
    return [PSCustomObject]@{ Satisfied = $true; Path = ""; Version = $null; Note = ""; TooOld = $null }
  }
  return [PSCustomObject]@{ Satisfied = $false; Path = ""; Version = $null; Note = ""; TooOld = $found.TooOld }
}

# Python's installer records each version under PEP 514 keys, PATH or not.
function Get-PythonRegistryDirs {
  $dirs = @()
  foreach ($root in @("HKCU:\Software\Python\PythonCore", "HKLM:\Software\Python\PythonCore", "HKLM:\Software\WOW6432Node\Python\PythonCore")) {
    foreach ($version in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Sort-Object PSChildName -Descending)) {
      try {
        $installPath = [string](Get-ItemProperty -LiteralPath (Join-Path $version.PSPath "InstallPath") -ErrorAction Stop).'(default)'
        if ($installPath) { $dirs += $installPath }
      }
      catch {}
    }
  }
  return $dirs
}

# Git for Windows records where it lives.
function Get-GitRegistryDirs {
  $dirs = @()
  foreach ($key in @("HKLM:\Software\GitForWindows", "HKCU:\Software\GitForWindows")) {
    try {
      $installPath = [string](Get-ItemProperty -LiteralPath $key -ErrorAction Stop).InstallPath
      if ($installPath) { $dirs += (Join-Path $installPath "cmd") }
    }
    catch {}
  }
  return $dirs
}

function Install-PortableGo {
  # Not winget: GoLang.Go is a machine-scope MSI, and a silent MSI started
  # without elevation can fail instead of asking for approval. The official zip
  # needs no administrator rights and is checked against go.dev's SHA-256.
  $archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($archName) { "ARM64" { "arm64" } "AMD64" { "amd64" } default { throw "Go indexing needs x64 or ARM64 Windows" } }
  $runtimeRoot = Join-Path $script:ManagedStateRoot "runtimes"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $stage = Join-Path $runtimeRoot (".go-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $releases = Invoke-RestMethod -Uri "https://go.dev/dl/?mode=json" -TimeoutSec 60
    $release = @($releases | Where-Object { $_.stable }) | Select-Object -First 1
    $file = @($release.files | Where-Object { $_.os -eq "windows" -and $_.arch -eq $arch -and $_.kind -eq "archive" }) | Select-Object -First 1
    if (-not $file -or $file.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "no Go $arch archive in go.dev's release list" }
    $archive = Join-Path $stage $file.filename
    Write-Info ("downloading {0}" -f $file.filename)
    Save-Download -Uri ("https://go.dev/dl/" + $file.filename) -OutFile $archive -Activity "Downloading Go" 
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $file.sha256) { throw "Go archive checksum mismatch; refusing to install it" }
    # ZipFile is far faster than Expand-Archive on Go's ~12k files.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, (Join-Path $stage "x"))
    $goExe = Join-Path $stage "x\go\bin\go.exe"
    & $goExe version *> $null
    if ($LASTEXITCODE -ne 0) { throw "downloaded Go cannot run on this Windows host" }
    $destination = Join-Path $runtimeRoot "go"
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    Move-Item -LiteralPath (Join-Path $stage "x\go") -Destination $destination
    [void](Add-UserPathEntry (Join-Path $destination "bin"))
    return 0
  }
  finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

function Install-Rustup {
  # Not winget: its Rustup package defaults to the MSVC toolchain, which needs
  # Visual Studio Build Tools. The GNU host ships its own linker, which is all
  # rust-analyzer needs to run build scripts while indexing.
  $archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($archName) {
    "AMD64" { $initTriple = "x86_64-pc-windows-msvc"; $defaultHost = "x86_64-pc-windows-gnu" }
    "ARM64" { $initTriple = "aarch64-pc-windows-msvc"; $defaultHost = "aarch64-pc-windows-msvc" }
    default { throw "Rust indexing needs x64 or ARM64 Windows" }
  }
  if ($archName -eq "ARM64") { Write-Warn2 "ARM64 Rust uses the MSVC toolchain; crates with build scripts need Visual Studio Build Tools to index fully" }
  $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("posse-rustup-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $url = "https://static.rust-lang.org/rustup/dist/$initTriple/rustup-init.exe"
    $init = Join-Path $stage "rustup-init.exe"
    $shaFile = Join-Path $stage "rustup-init.exe.sha256"
    Invoke-WebRequest -UseBasicParsing -Uri "$url.sha256" -OutFile $shaFile -TimeoutSec 60
    $expected = @(([string](Get-Content -LiteralPath $shaFile -Raw)).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw "rustup-init checksum file is malformed" }
    Save-Download -Uri $url -OutFile $init -Activity "Downloading the Rust installer" -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $init -Algorithm SHA256).Hash -ine $expected) { throw "rustup-init checksum mismatch; refusing to run it" }
    $rc = Invoke-Logged -Description ("install Rust ({0}) with rust-analyzer" -f $defaultHost) -Activity "Installing Rust and rust-analyzer" -Command @(
      $init, "-y", "--profile", "minimal", "--default-host", $defaultHost, "--component", "rust-analyzer"
    )
    Update-SessionPath
    return $rc
  }
  finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
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
    try {
      & $cmd.Source @($candidate.Args + @("-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)")) *> $null
      if ($LASTEXITCODE -eq 0) { return [PSCustomObject]@{ Command = $cmd.Source; Args = $candidate.Args } }
    }
    catch {}
  }
  return $null
}

function Test-DepsFresh {
  param([string]$Dir)
  $nm = Join-Path $Dir "node_modules"
  $lock = Join-Path $nm ".package-lock.json"
  $pkg = Join-Path $Dir "package.json"
  if (-not ((Test-Path $nm) -and (Test-Path $lock) -and (Test-Path $pkg))) { return $false }
  if ((Get-Item $pkg).LastWriteTime -gt (Get-Item $lock).LastWriteTime) { return $false }
  Push-Location -LiteralPath $Dir
  try {
    & $script:NodeBin --input-type=commonjs -e 'const D = require("better-sqlite3"); const db = new D(":memory:"); db.close();' *> $null
    return $LASTEXITCODE -eq 0
  } catch { return $false } finally { Pop-Location }
}

# Runs a native probe through redirected streams, so a tool that writes to
# stderr cannot become a terminating error under Windows PowerShell 5.1.
function Get-NativeOutput {
  param([string]$FileName, [string[]]$Arguments, [int]$TimeoutMs = 15000)
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FileName
    $psi.Arguments = ($Arguments | ForEach-Object { Quote-NativeArg $_ }) -join " "
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)
    $stdout = $proc.StandardOutput.ReadToEndAsync()
    $stderr = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) { Stop-InstallerProcessTree $proc; return $null }
    $proc.WaitForExit()
    return [PSCustomObject]@{ ExitCode = $proc.ExitCode; StdOut = [string]$stdout.Result; Output = [string]$stdout.Result + [string]$stderr.Result }
  }
  catch { return $null }
}

# ImageMagick installs into a versioned folder and records it in the registry;
# the Store package exposes an app alias instead.
function Get-ImageMagickDirs {
  $dirs = @()
  foreach ($key in @("HKLM:\SOFTWARE\ImageMagick\Current", "HKLM:\SOFTWARE\WOW6432Node\ImageMagick\Current", "HKCU:\SOFTWARE\ImageMagick\Current")) {
    try {
      $bin = [string](Get-ItemProperty -LiteralPath $key -ErrorAction Stop).BinPath
      if ($bin) { $dirs += $bin }
    }
    catch {}
  }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }) {
    $dirs += @(Get-ChildItem -LiteralPath $root -Directory -Filter "ImageMagick-*" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | ForEach-Object { $_.FullName })
  }
  $dirs += (Join-Path $localAppDataRoot "Microsoft\WindowsApps")
  return $dirs
}

# winget answers worth a second try: a failed download or package source, no
# network, or another installation holding the Windows Installer lock.
$script:WingetTransientExitCodes = @(
  -1978335224, # 0x8A150008 DOWNLOAD_FAILED
  -1978335217, # 0x8A15000F SOURCE_DATA_MISSING
  -1978335169, # 0x8A15003F SOURCE_DATA_INTEGRITY_FAILURE
  -1978335163, # 0x8A150045 SOURCE_OPEN_FAILED
  -1978334974, # 0x8A150102 INSTALL_INSTALL_IN_PROGRESS
  -1978334969  # 0x8A150107 INSTALL_NO_NETWORK
)
# With --scope user winget keeps only per-user, portable, and MSIX installers.
# A package that has none answers this at once instead of asking for
# administrator approval in a prompt setup's hidden engine cannot show.
$script:WingetNoApplicableInstaller = -1978335216 # 0x8A150010

function Format-WingetFailure {
  param([int]$ExitCode)
  if ($ExitCode -eq 124) { return ("timed out after {0} min" -f [int][math]::Ceiling($PackageTimeoutSeconds / 60)) }
  if ($ExitCode -eq $script:WingetNoApplicableInstaller) { return "no per-user installer; needs an administrator" }
  return ("winget exit 0x{0:X8}" -f $ExitCode)
}

# Installs one winget package for this user only, within -PackageTimeoutSeconds.
# A transient failure gets one more try; a timeout does not.
function Invoke-WingetInstall {
  param([string]$Label, [string]$Id, [string]$Activity, [switch]$QuietFailure)
  $command = @(
    "winget", "install", "--id", $Id, "--exact", "--source", "winget", "--silent", "--scope", "user",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
  )
  $rc = 0
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $retryNote = if ($attempt -gt 1) { ", retry" } else { "" }
    $rc = Invoke-Logged -Description ("install {0} ({1}{2})" -f $Label, $Id, $retryNote) -Activity $Activity -Command $command -TimeoutSeconds $PackageTimeoutSeconds -QuietFailure:$QuietFailure
    if ($rc -eq 0 -or $script:WingetTransientExitCodes -notcontains $rc -or $attempt -eq 2) { break }
    Write-LogOnly ("[winget] {0}: {1}; trying once more" -f $Id, (Format-WingetFailure $rc))
    Start-Sleep -Seconds 5
  }
  return $rc
}

function Get-MissingPhpComposerExtensions {
  param([string]$PhpPath)
  # One probe through redirected streams: a PHP that prints startup warnings
  # (common with dev setups) must not read as "extension missing".
  $code = 'foreach (["openssl", "curl", "zip"] as $e) { if (!extension_loaded($e)) { echo $e, PHP_EOL; } }'
  $probe = Get-NativeOutput $PhpPath @("-r", $code)
  if (-not $probe -or $probe.ExitCode -ne 0) { return @("openssl", "curl", "zip") }
  return @(([string]$probe.StdOut -split "\r?\n") | ForEach-Object { $_.Trim() } | Where-Object { $_ -in @("openssl", "curl", "zip") })
}

function Enable-PhpComposerExtensions {
  param([string]$PhpPath)

  $missingBefore = @(Get-MissingPhpComposerExtensions $PhpPath)
  if ($missingBefore.Count -eq 0) {
    return [PSCustomObject]@{ Ok = $true; Changed = $false; IniPath = ""; Message = "PHP Composer extensions already enabled" }
  }

  $phpBinary = ""
  $binaryProbe = Get-NativeOutput $PhpPath @("-r", "echo PHP_BINARY;")
  if ($binaryProbe -and $binaryProbe.ExitCode -eq 0) { $phpBinary = ([string]$binaryProbe.StdOut).Trim() }
  if ([string]::IsNullOrWhiteSpace($phpBinary) -or -not (Test-Path -LiteralPath $phpBinary)) {
    $phpBinary = $PhpPath
  }
  try { $phpBinary = (Resolve-Path -LiteralPath $phpBinary -ErrorAction Stop).Path } catch {}
  # Through winget's Links alias, PHP_BINARY names the link, not the folder
  # that holds ext\ and php.ini.
  $phpBinary = Resolve-RealExecutable $phpBinary
  $phpDir = Split-Path $phpBinary -Parent
  if (-not (Test-DirectoryWriteAccess $phpDir)) {
    return [PSCustomObject]@{
      Ok = $false; Changed = $false; IniPath = ""
      Message = ("PHP directory is not writable by the current user: {0}" -f $phpDir)
    }
  }
  $extDir = Join-Path $phpDir "ext"
  $missingDlls = @($missingBefore | Where-Object { -not (Test-Path -LiteralPath (Join-Path $extDir ("php_{0}.dll" -f $_))) })
  if ($missingDlls.Count -gt 0) {
    return [PSCustomObject]@{
      Ok = $false; Changed = $false; IniPath = ""
      Message = ("the PHP distribution is missing extension DLL(s): {0}" -f ($missingDlls -join ", "))
    }
  }

  $loadedIni = ""
  $iniProbe = Get-NativeOutput $phpBinary @("-r", 'echo php_ini_loaded_file() ?: "";')
  if ($iniProbe -and $iniProbe.ExitCode -eq 0) { $loadedIni = ([string]$iniProbe.StdOut).Trim() }
  $iniPath = if ($loadedIni) { $loadedIni } else { Join-Path $phpDir "php.ini" }
  $created = $false
  try {
    if (-not (Test-Path -LiteralPath $iniPath)) {
      $template = @(
        (Join-Path $phpDir "php.ini-production"),
        (Join-Path $phpDir "php.ini-development")
      ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
      if (-not $template) {
        return [PSCustomObject]@{
          Ok = $false; Changed = $false; IniPath = $iniPath
          Message = "PHP has no loaded php.ini or bundled php.ini template"
        }
      }
      Copy-Item -LiteralPath $template -Destination $iniPath
      $created = $true
    }
    else {
      $backupPath = $iniPath + ".posse-backup"
      if (-not (Test-Path -LiteralPath $backupPath)) {
        Copy-Item -LiteralPath $iniPath -Destination $backupPath
      }
    }

    $contents = [System.IO.File]::ReadAllText($iniPath)
    $newline = if ($contents.Contains("`r`n")) { "`r`n" } else { "`n" }
    # Remove active copies before appending a final authoritative block. The
    # stock templates keep their commented examples as documentation.
    $contents = [regex]::Replace($contents, '(?im)^[ \t]*extension_dir[ \t]*=.*(?:\r?\n)?', '')
    $contents = [regex]::Replace($contents, '(?im)^[ \t]*extension[ \t]*=[ \t]*(?:php_)?(?:openssl|curl|zip)(?:\.dll)?[ \t]*(?:;.*)?(?:\r?\n)?', '')
    $extIniPath = $extDir.Replace('\', '/')
    $posseBlock = @(
      "; Posse installer: secure and fast Composer package downloads.",
      ('extension_dir = "{0}"' -f $extIniPath),
      "extension=openssl",
      "extension=curl",
      "extension=zip"
    ) -join $newline
    $contents = $contents.TrimEnd([char[]]"`r`n") + $newline + $newline + $posseBlock + $newline
    [System.IO.File]::WriteAllText($iniPath, $contents, (New-Object System.Text.UTF8Encoding($false)))
  }
  catch {
    return [PSCustomObject]@{
      Ok = $false; Changed = $created; IniPath = $iniPath
      Message = ("could not configure PHP Composer extensions: {0}" -f $_.Exception.Message)
    }
  }

  $missingAfter = @(Get-MissingPhpComposerExtensions $phpBinary)
  if ($missingAfter.Count -gt 0) {
    return [PSCustomObject]@{
      Ok = $false; Changed = $true; IniPath = $iniPath
      Message = ("PHP still cannot load extension(s) after configuring {0}: {1}" -f $iniPath, ($missingAfter -join ", "))
    }
  }
  return [PSCustomObject]@{
    Ok = $true; Changed = $true; IniPath = $iniPath
    Message = ("enabled PHP OpenSSL, cURL, and ZIP in {0}" -f $iniPath)
  }
}

# =============================================================================
# steps
# =============================================================================

# Git is the one host tool needed before the checkout; Step-Checkout installs
# it early when it must clone, and Step-Packages finds it already present.
function Get-GitToolSpec {
  [PSCustomObject]@{ Label = "Git"; Exe = "git.exe"; VersionPattern = 'git version (\d+)\.(\d+)'; AppNames = @("Git", "Git version *"); Locate = { Get-GitRegistryDirs }; KnownDirs = @("%ProgramFiles%\Git\cmd", "%LOCALAPPDATA%\Programs\Git\cmd"); WingetIds = @("Git.Git"); Reason = "required Posse checkout and worktree lifecycle" }
}

# Installs one host tool (its own installer, else winget) and reports whether
# a usable copy now runs.
function Install-HostTool {
  param($Tool, [string]$Counter = "", [bool]$HasWinget = $true)
  Write-SetupProgress @("act", ("Installing {0}{1}" -f $Tool.Label, $Counter))
  $installed = $false
  $reason = ""
  if ($Tool.Install) {
    try {
      if ((& $Tool.Install) -eq 0) {
        Update-SessionPath
        $installed = (Resolve-ToolRequirement $Tool).Satisfied
      }
    }
    catch { Write-Warn2 ("{0} install failed: {1}" -f $Tool.Label, $_.Exception.Message) }
  }
  elseif ($HasWinget) {
    foreach ($id in $Tool.WingetIds) {
      $rc = Invoke-WingetInstall -Label $Tool.Label -Id $id -Activity ("Installing {0}{1}" -f $Tool.Label, $Counter) -QuietFailure
      if ($rc -ne 0) { $reason = Format-WingetFailure $rc; continue }
      # An installed package only counts once a new-enough copy actually runs.
      Update-SessionPath
      if ((Resolve-ToolRequirement $Tool).Satisfied) { $installed = $true; break }
      $reason = "installed but not usable"
      Write-LogOnly ("[packages] {0} installed but {1} is not usable; trying the next package" -f $id, $Tool.Label)
    }
  }
  return [PSCustomObject]@{ Installed = $installed; Reason = $reason }
}

function Step-Packages {
  Step-Begin "packages"

  # Each tool says what counts as "already installed": its executable, the
  # oldest version Posse works with (when it matters), how to ask for that
  # version, and where its installers usually register or unpack it.
  $tools = @(
    (Get-GitToolSpec),
    [PSCustomObject]@{ Label = "GitHub CLI"; Exe = "gh.exe"; AppNames = @("GitHub CLI*"); KnownDirs = @("%ProgramFiles%\GitHub CLI"); WingetIds = @("GitHub.cli"); Reason = "optional GitHub authentication and Session provisioning" },
    [PSCustomObject]@{ Label = "ripgrep"; Exe = "rg.exe"; WingetIds = @("BurntSushi.ripgrep.MSVC"); Reason = "deterministic search" }
  )
  if (Test-ScipLanguageSelected "python") {
    # Posse itself needs no Python; Python projects do. The py launcher also
    # satisfies this when python.exe is not on PATH.
    $tools += [PSCustomObject]@{ Label = "Python 3"; Exe = "python.exe"; MinVersion = "3.9"; VersionPattern = 'Python (\d+)\.(\d+)'; AppNames = @("Python 3*"); Locate = { Get-PythonRegistryDirs }; Fallback = { $null -ne (Get-PythonRunner) }; WingetIds = @("Python.Python.3.13", "Python.Python.3.12"); Reason = "explicitly selected SCIP Python indexing" }
  }
  if (Test-ScipLanguageSelected "php") {
    # Posse's scip-php needs PHP 8.2+: 8.3+ runs current upstream scip-php and
    # 8.2 the pinned v0.0.2 track (posse doctor picks it). PHP reads php.ini and
    # ext\ beside the binary it was launched as, so its real folder must come
    # before winget's Links alias on PATH.
    $tools += [PSCustomObject]@{ Label = "PHP"; Exe = "php.exe"; MinVersion = "8.2"; VersionPattern = 'PHP (\d+)\.(\d+)'; RealDirFirst = $true; AppNames = @("PHP*"); KnownDirs = @("C:\xampp\php", "C:\laragon\bin\php\php-*", "C:\tools\php*", "%USERPROFILE%\scoop\apps\php\current"); WingetIds = @("PHP.PHP.8.4", "PHP.PHP.8.3"); Reason = "explicitly selected SCIP PHP indexing" }
  }
  if (Test-ScipLanguageSelected "go") {
    # Go 1.21+ fetches the newer toolchain scip-go declares by itself.
    $tools += [PSCustomObject]@{ Label = "Go"; Exe = "go.exe"; MinVersion = "1.21"; VersionArgs = @("version"); VersionPattern = 'go(\d+)\.(\d+)'; AppNames = @("Go Programming Language*"); KnownDirs = @("%ProgramFiles%\Go\bin", (Join-Path $script:ManagedStateRoot "runtimes\go\bin")); WingetIds = @("GoLang.Go"); Install = { Install-PortableGo }; InstallLabel = "the official go.dev zip"; Reason = "explicitly selected SCIP Go indexing" }
  }
  if (Test-ScipLanguageSelected "rust") {
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE ".cargo" }
    $tools += [PSCustomObject]@{ Label = "Rust"; Exe = "cargo.exe"; Companions = @("rustc.exe"); KnownDirs = @((Join-Path $cargoHome "bin")); Install = { Install-Rustup }; InstallLabel = "rustup (GNU toolchain + rust-analyzer)"; Reason = "explicitly selected SCIP Rust indexing" }
  }
  # Media helpers are opt-in and go last: they are the largest downloads, and
  # Posse runs without them (OCR is unavailable and image conversion falls
  # back to sharp or System.Drawing).
  if ($WithMediaTools) {
    $tools += [PSCustomObject]@{ Label = "Tesseract OCR"; Exe = "tesseract.exe"; AppNames = @("Tesseract-OCR*"); KnownDirs = @("%ProgramFiles%\Tesseract-OCR", "%ProgramFiles(x86)%\Tesseract-OCR", "%LOCALAPPDATA%\Programs\Tesseract-OCR"); WingetIds = @("UB-Mannheim.TesseractOCR"); Reason = "image OCR extraction (-WithMediaTools)" }
    # The Store (MSIX) builds install per user without administrator rights.
    $tools += [PSCustomObject]@{ Label = "ImageMagick"; Exe = "magick.exe"; MinVersion = "7.0"; VersionArgs = @("-version"); VersionPattern = 'ImageMagick (\d+)\.(\d+)'; AppNames = @("ImageMagick*"); Locate = { Get-ImageMagickDirs }; WingetIds = @("ImageMagick.Q16-HDRI", "ImageMagick.Q16"); Reason = "image conversion (-WithMediaTools)" }
    $tools += [PSCustomObject]@{ Label = "FFmpeg"; Exe = "ffmpeg.exe"; VersionArgs = @("-version"); WingetIds = @("Gyan.FFmpeg"); Reason = "media conversion (-WithMediaTools)" }
  }
  else {
    Write-Info "media tools (Tesseract OCR, ImageMagick, FFmpeg) not requested; -WithMediaTools adds them"
  }

  # Find before installing: anything already here and new enough is used as-is.
  Write-SetupProgress @("act", "Looking for tools already on this PC")
  $satisfied = @{}
  $pathNotes = @()
  foreach ($tool in $tools) {
    $result = Resolve-ToolRequirement $tool
    if ($result.Satisfied) {
      $satisfied[$tool.Label] = $true
      if ($result.Note) { $pathNotes += $tool.Label; Write-Info ("{0}: {1}" -f $tool.Label, $result.Note) }
    }
    elseif ($result.TooOld) {
      Write-Info ("found {0} {1} at {2}, but Posse needs {3} or newer" -f $tool.Label, $result.TooOld.Version, $result.TooOld.Path, $tool.MinVersion)
    }
  }

  $missing = @($tools | Where-Object { -not $satisfied[$_.Label] })
  $failed = @()
  foreach ($tool in $missing) { Write-Info ("missing: {0} ({1})" -f $tool.Label, $tool.Reason) }
  if ($missing.Count -gt 0) {
    if ($SkipHostTools) {
      Step-End "skipped" ("-SkipHostTools; missing: " + (($missing | ForEach-Object { $_.Label }) -join ", "))
      return
    }
    if ($DryRun) {
      foreach ($tool in $missing) {
        $how = if ($tool.Install) { $tool.InstallLabel } else { "winget install " + $tool.WingetIds[0] }
        Write-Host ("    {0}{1} (dry-run) would install {2} via {3}{4}" -f $script:DIM, $script:GlyphDot, $tool.Label, $how, $script:R)
      }
      Step-End "dry-run" "would install missing tools"
      return
    }
    $hasWinget = Test-Cmd "winget"
    if (-not $hasWinget -and @($missing | Where-Object { -not $_.Install }).Count -gt 0) {
      Write-Warn2 "winget is not available; install the missing tools manually (App Installer from the Microsoft Store provides winget)"
    }
    $toolNumber = 0
    foreach ($tool in $missing) {
      $toolNumber++
      $counter = if ($missing.Count -gt 1) { " ({0} of {1})" -f $toolNumber, $missing.Count } else { "" }
      $result = Install-HostTool -Tool $tool -Counter $counter -HasWinget $hasWinget
      if ($result.Installed) { $satisfied[$tool.Label] = $true }
      else { $failed += $(if ($result.Reason) { "{0} ({1})" -f $tool.Label, $result.Reason } else { $tool.Label }) }
    }
  }

  $pathNote = if ($pathNotes.Count -gt 0) { "; PATH set for " + ($pathNotes -join ", ") } else { "" }
  if ($failed.Count -eq 0) {
    $message = if ($missing.Count -eq 0) { "all selected tools already present" } else { "missing tools installed" }
    Step-End "ok" ($message + $pathNote)
  }
  else {
    Write-Warn2 ("could not install: " + ($failed -join ", ") + " (Posse degrades gracefully; related helpers stay disabled)")
    Step-End "partial" ("could not install " + ($failed -join ", ") + $pathNote)
  }
}

# True when the Node on PATH is new enough and has a working npm; it then
# becomes the Node this installer and the posse launcher run.
function Test-NodeRuntime {
  $info = Get-NodeRuntimeInfo
  if (-not $info -or $info.Major -lt $NodeMinMajor -or -not $info.NpmCli) { return $false }
  $script:NodeBin = $info.NodeBin
  $script:NpmCli = $info.NpmCli
  return $true
}

function Install-PortableNode {
  # No winget or administrator required. Stage a checksum-verified official
  # distribution beside its final destination; never overwrite a working tree.
  $archName = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($archName) { "ARM64" { "arm64" } "AMD64" { "x64" } default { throw "Node requires x64 or ARM64 Windows" } }
  $runtimeRoot = Join-Path $script:ManagedStateRoot "runtimes"
  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $stage = Join-Path $runtimeRoot (".node-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $baseUrl = "https://nodejs.org/dist/latest-v$NodeMinMajor.x"
    $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 60).Content
    $pattern = '(?m)^([a-fA-F0-9]{64})\s+(node-v' + $NodeMinMajor + '\.\d+\.\d+-win-' + $arch + '\.zip)\r?$'
    $match = [regex]::Match([string]$checksums, $pattern)
    if (-not $match.Success) { throw "No supported Node archive in official checksum manifest" }
    $filename = $match.Groups[2].Value
    $archive = Join-Path $stage $filename
    # Use the immutable version URL after resolving latest, avoiding release races.
    $version = ($filename -split '-')[1]
    Save-Download -Uri "https://nodejs.org/dist/$version/$filename" -OutFile $archive -Activity "Downloading Node.js" -TimeoutSec 300
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $match.Groups[1].Value) { throw "Node archive checksum mismatch" }
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    $directoryName = [IO.Path]::GetFileNameWithoutExtension($filename)
    $extracted = Join-Path $stage $directoryName
    $candidate = Join-Path $extracted "node.exe"
    & $candidate --version *> $null
    if ($LASTEXITCODE -ne 0) { throw "Downloaded Node cannot run on this Windows host" }
    $destination = Join-Path $runtimeRoot ($directoryName + "-" + [Guid]::NewGuid().ToString("N"))
    Move-Item -LiteralPath $extracted -Destination $destination
    $env:Path = "$destination;$env:Path"
    if (-not (Test-NodeRuntime)) { throw "Downloaded Node/npm failed verification" }
  }
  finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

function Step-Node {
  Step-Begin "node"
  if (Test-NodeRuntime) {
    Step-End "ok" ("Node + npm ready at {0}" -f $script:NodeBin)
    return
  }
  # Say why an existing Node is not used. It is left exactly as it is: Posse
  # gets its own per-user Node beside it (the posse launcher names that Node
  # explicitly), never a winget upgrade of the one already installed.
  $existing = Get-NodeRuntimeInfo
  if ($existing -and $existing.Major -gt 0 -and $existing.Major -lt $NodeMinMajor) {
    Write-Info ("found Node {0} at {1}; Posse needs Node {2}+, so it gets its own copy and yours stays as it is" -f $existing.Version, $existing.NodeBin, $NodeMinMajor)
  }
  elseif ($existing -and $existing.Major -gt 0) {
    Write-Info ("found Node {0} at {1}, but no working npm beside it; Posse gets its own Node and yours stays as it is" -f $existing.Version, $existing.NodeBin)
  }
  elseif ($existing) {
    Write-Info ("found node at {0}, but it did not run; Posse gets its own Node" -f $existing.Path)
  }
  # Reuse a previously installed portable runtime in shells without its PATH.
  $runtimeRoot = Join-Path $script:ManagedStateRoot "runtimes"
  if (Test-Path -LiteralPath $runtimeRoot) {
    foreach ($directory in @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter "node-v$NodeMinMajor.*" | Sort-Object LastWriteTime -Descending)) {
      $previousPath = $env:Path
      $env:Path = "$($directory.FullName);$env:Path"
      if (Test-NodeRuntime) {
        Step-End "ok" "reused managed Node + npm"
        return
      }
      $env:Path = $previousPath
    }
  }
  if ($NoInstallNode) { Step-FailCritical "Node $NodeMinMajor+ with npm required (-NoInstallNode was passed)."; return }
  if ($DryRun) { Step-End "dry-run" "would install Node + npm via winget or verified per-user ZIP"; return }
  if (-not $existing -and (Test-Cmd "winget")) {
    foreach ($id in @("OpenJS.NodeJS.LTS", "OpenJS.NodeJS")) {
      [void](Invoke-WingetInstall -Label "Node.js" -Id $id -Activity "Installing Node.js")
      Update-SessionPath
      if (Test-NodeRuntime) { break }
    }
  }
  if (-not (Test-NodeRuntime)) {
    $why = if ($existing) { "keeping the Node already installed" } else { "winget unavailable or unsuccessful" }
    Write-Info ("installing official Node ZIP in user-owned storage ({0})" -f $why)
    Install-PortableNode
  }
  if (-not (Test-NodeRuntime)) { Step-FailCritical "Node $NodeMinMajor+ with npm could not be set up; see log"; return }
  Step-End "ok" ("Node + npm ready at {0}" -f $script:NodeBin)
}

function Step-Checkout {
  Step-Begin "checkout"
  if ($script:CriticalFailed) { Step-End "blocked"; return }

  if (-not $script:PosseDirResolved) {
    $detected = Get-InstallerPosseDir
    if ($detected) {
      if ($DryRun -or (Test-DirectoryWriteAccess $detected)) {
        $script:PosseDirResolved = $detected
        $script:CheckoutIsInstallerSource = $true
        Write-Info "using the writable Posse checkout containing this installer"
      }
      else {
        $script:PosseDirResolved = Join-Path $InstallRoot "posse-client"
        Write-Warn2 ("installer checkout is read-only for the current user; cloning a user-owned copy into {0}" -f $script:PosseDirResolved)
      }
    }
    else {
      $script:PosseDirResolved = Join-Path $InstallRoot "posse-client"
    }
  }
  $script:PosseDirResolved = Resolve-FullPath $script:PosseDirResolved

  if (Test-Path $script:PosseDirResolved) {
    $resolvedRoot = Resolve-PosseRootFromCheckout $script:PosseDirResolved
    if ($resolvedRoot) {
      $script:PosseDirResolved = $resolvedRoot
      if (-not $DryRun -and -not (Test-DirectoryWriteAccess $resolvedRoot)) {
        Step-FailCritical ("Posse checkout is not writable by the current user: {0}. Move/reclone it into a user-owned directory or omit -PosseDir." -f $resolvedRoot)
      }
      elseif ($script:CheckoutIsInstallerSource) {
        # A developer running setup from their own clone keeps it as it is.
        Step-End "ok" ("using the checkout this installer runs from: {0}" -f $resolvedRoot)
      }
      else {
        $update = Update-PosseCheckout $resolvedRoot -Managed:(Test-PathUnder $resolvedRoot $InstallRoot)
        if ($update.Ok) { Step-End "ok" ("existing checkout {0}: {1}" -f $resolvedRoot, $update.Note) }
        else {
          Write-Warn2 ("kept the existing checkout {0} as it is: {1}" -f $resolvedRoot, $update.Note)
          Step-End "partial" ("existing Posse kept as it is: {0}" -f $update.Note)
        }
      }
    }
    else {
      Step-FailCritical ("{0} exists but has no orchestrator.js at its root or under posse\ (move or remove the partial directory, then re-run)" -f $script:PosseDirResolved)
    }
    return
  }

  # Host tools install after npm, so the native downloads can start sooner;
  # cloning needs Git now. A Git installed off PATH is found and used.
  $gitSpec = Get-GitToolSpec
  if (-not (Test-Cmd "git") -and -not (Resolve-ToolRequirement $gitSpec).Satisfied -and -not $DryRun -and -not $SkipHostTools) {
    [void](Install-HostTool -Tool $gitSpec -HasWinget (Test-Cmd "winget"))
  }
  if (-not (Test-Cmd "git")) {
    Step-FailCritical "git is required to clone Posse but is not installed (winget install Git.Git)"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" ("would shallow-clone {0} into {1} and auto-detect the Posse root" -f $PosseRepoUrl, $script:PosseDirResolved)
    return
  }
  $checkoutDir = $script:PosseDirResolved
  $parent = Split-Path $checkoutDir -Parent
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $cloneDir = $checkoutDir + ".installing-" + [Guid]::NewGuid().ToString("N")
  try {
    $rc = Invoke-Logged -Description ("clone {0}" -f $PosseRepoUrl) -Activity "Downloading Posse from GitHub" -Command @("git", "-c", "core.longpaths=true", "clone", "--depth", "1", $PosseRepoUrl, $cloneDir)
    $clonedRoot = if ($rc -eq 0) { Resolve-PosseRootFromCheckout $cloneDir } else { "" }
    if ($clonedRoot) {
      $nested = $clonedRoot -ne (Resolve-FullPath $cloneDir)
      Move-Item -LiteralPath $cloneDir -Destination $checkoutDir
      $script:PosseDirResolved = if ($nested) { Join-Path $checkoutDir "posse" } else { $checkoutDir }
      Step-End "ok" ("cloned into {0}" -f $script:PosseDirResolved)
    }
    else {
      Step-FailCritical "git clone failed (or orchestrator.js is missing at the checkout root and under posse\); see log"
    }
  }
  finally {
    if (Test-Path $cloneDir) { Remove-Item -LiteralPath $cloneDir -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

function Step-Composer {
  Step-Begin "composer"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if (-not (Test-ScipLanguageSelected "php")) {
    Step-End "skipped" "PHP SCIP not selected"
    return
  }
  $pharPath = Join-Path $script:ManagedStateRoot "scip\bin\composer.phar"
  # A Composer 2 you already have is used as-is: nothing to install, and no
  # changes to your php.ini.
  $existing = Get-Command composer -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($existing -and $existing.Source) {
    $version = Get-NativeOutput $existing.Source @("--version", "--no-ansi") 60000
    if ($version -and $version.ExitCode -eq 0 -and $version.Output -match 'Composer (?:version )?(\d+)\.(\d+)') {
      if ([int]$Matches[1] -ge 2) { Step-End "ok" ("using your Composer {0}.{1} at {2}" -f $Matches[1], $Matches[2], $existing.Source); return }
      Write-Info ("found Composer {0}.{1} at {2}; Posse needs Composer 2, so setup adds its own" -f $Matches[1], $Matches[2], $existing.Source)
    }
    else { Write-Info ("found {0}, but it did not run; setup adds its own Composer" -f $existing.Source) }
  }
  $php = Get-Command php -ErrorAction SilentlyContinue
  if ($php -and -not $DryRun) {
    $phpExtensions = Enable-PhpComposerExtensions $php.Source
    if (-not $phpExtensions.Ok) {
      Write-Warn2 ("PHP Composer extension setup failed: {0}" -f $phpExtensions.Message)
      Step-End "partial" ("Composer skipped: {0}" -f $phpExtensions.Message)
      return
    }
    if ($phpExtensions.Changed) { Write-Info $phpExtensions.Message }
  }
  if (Test-Path $pharPath) { Step-End "ok" ("composer.phar already present in {0}" -f $pharPath); return }
  if (-not $php) {
    Write-Warn2 "PHP is not installed, so Composer was skipped - SCIP PHP indexing stays disabled until both exist"
    Step-End "skipped" "php not available"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" ("would configure PHP Composer extensions and download signature-verified composer.phar into {0}" -f $pharPath)
    return
  }

  $binDir = Split-Path $pharPath -Parent
  $setupPath = Join-Path ([System.IO.Path]::GetTempPath()) ("composer-setup-" + [Guid]::NewGuid().ToString("N") + ".php")
  try {
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
    Write-Info "downloading Composer installer (signature-verified)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $expected = (Invoke-RestMethod -Uri "https://composer.github.io/installer.sig" -TimeoutSec 30).Trim()
    Invoke-WebRequest -Uri "https://getcomposer.org/installer" -OutFile $setupPath -UseBasicParsing -TimeoutSec 120
    # Hash here, not with `php -r`: Windows PowerShell 5.1 drops the inner
    # double quotes of native arguments, so PHP would get broken code.
    $actual = (Get-FileHash -LiteralPath $setupPath -Algorithm SHA384).Hash
    if ([string]::IsNullOrWhiteSpace($expected) -or ($actual -ine $expected)) {
      Write-Warn2 "Composer installer signature verification failed"
      Step-End "partial" "composer unavailable (signature mismatch)"
      return
    }
    $rc = Invoke-Logged -Description "run Composer installer" -Activity "Installing Composer" -Command @($php.Source, $setupPath, "--install-dir=$binDir", "--filename=composer.phar", "--quiet")
    if ($rc -eq 0 -and (Test-Path $pharPath)) {
      Step-End "ok" ("composer.phar installed into {0}" -f $pharPath)
    }
    else {
      Write-Warn2 "Composer could not be installed; SCIP PHP dependency installs will be skipped"
      Step-End "partial" "composer unavailable"
    }
  }
  catch {
    Write-Warn2 ("Composer install failed: {0}" -f $_.Exception.Message)
    Step-End "partial" "composer unavailable"
  }
  finally {
    Remove-Item $setupPath -Force -ErrorAction SilentlyContinue
  }
}

function Step-Npm {
  Step-Begin "npm"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if (-not $Force -and (Test-DepsFresh $script:PosseDirResolved)) {
    Step-End "skipped" "node_modules is fresh (pass -Force to reinstall)"
    return
  }
  $npm = Get-NpmInstallCommand $script:PosseDirResolved
  if ($DryRun) {
    Step-End "dry-run" ("would run {0} in {1}" -f $npm.Label, $script:PosseDirResolved)
    return
  }
  $rc = Invoke-Logged -Description $npm.Label -Activity "Installing Posse's npm packages" -Command $npm.Command -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Complete-NodeInstall; return }

  Write-Info "retrying once (transient network/registry failures are common)"
  $rc = Invoke-Logged -Description ("{0} (retry)" -f $npm.Label) -Activity "Retrying Posse's npm packages" -Command $npm.Command -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Complete-NodeInstall; return }

  Step-FailCritical ("{0} failed twice; see the installer log for details" -f $npm.Label)
}

# The checkout's lockfile pins every version. `npm ci` installs exactly that
# into a fresh tree. An existing tree is updated in place instead, because ci
# deletes node_modules first, which fails while a running Posse (the
# automation owner) holds its SQLite addon open. Neither writes the lockfile,
# so `posse update` never finds it modified. Older checkouts without a
# lockfile keep a plain npm install. Scripts are off: npm installing from a
# lockfile misses better-sqlite3's "gypfile": false and compiles it from
# source, which fails without Visual Studio's C++ tools; its bundled prebuilt
# addon needs no build. Complete-NodeInstall then runs the install scripts of
# the packages that really have them.
function Get-NpmInstallCommand {
  param([string]$Dir)
  $common = @("--include=dev", "--include=optional", "--ignore-scripts", "--no-fund", "--no-audit")
  if (-not (Test-Path -LiteralPath (Join-Path $Dir "package-lock.json"))) {
    return [PSCustomObject]@{ Label = "npm install"; Command = @("npm", "install") + $common }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Dir "node_modules"))) {
    return [PSCustomObject]@{ Label = "npm ci"; Command = @("npm", "ci") + $common }
  }
  return [PSCustomObject]@{ Label = "npm install (locked versions)"; Command = @("npm", "install", "--no-save", "--prefer-offline") + $common }
}

function Complete-NodeInstall {
  $previousAdopt = $env:POSSE_MAINTENANCE_ADOPT_NODE
  $previousScripts = $env:POSSE_MAINTENANCE_INSTALL_SCRIPTS
  try {
    $env:POSSE_MAINTENANCE_ADOPT_NODE = "1"
    $env:POSSE_MAINTENANCE_INSTALL_SCRIPTS = "1"
    $rc = Invoke-Logged -Description "verify and repair Node native addons" -Activity "Checking Posse's native add-ons" -WorkingDirectory $script:PosseDirResolved -Command @(
      $script:NodeBin, "lib/domains/cli/functions/maintenance-node-repair.js"
    )
    if ($rc -eq 0) { Step-End "ok" "npm dependencies and SQLite runtime verified" }
    else { Step-FailCritical "Node dependencies remain unusable after repair; check the build toolchain and log" }
  }
  finally {
    $env:POSSE_MAINTENANCE_ADOPT_NODE = $previousAdopt
    $env:POSSE_MAINTENANCE_INSTALL_SCRIPTS = $previousScripts
  }
}

function Step-Automation {
  Step-Begin "automation"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would install the per-user Posse automation scheduled task"
    return
  }
  $rc = Invoke-Logged -Description "install supervised automation owner" -Activity "Registering the background task" -WorkingDirectory $script:PosseDirResolved -Command @(
    $script:NodeBin, "orchestrator.js", "automation", "service", "install"
  )
  if ($rc -eq 0) {
    Step-End "ok" "automation owner enabled for login/reboot startup"
  }
  else {
    Write-Warn2 "could not enable the automation owner; run 'posse automation service install' after installation"
    Step-End "partial" "automation starts on first use but scheduled work needs the user service"
  }
}

# The checkout a Posse launcher (posse.cmd, npm's shims) runs, or "" when the
# file is not a Posse launcher. npm shims name their package folder, which an
# `npm link` turns into a junction to a checkout elsewhere.
function Get-PosseLauncherRoot {
  param([string]$ShimPath)
  $text = try { [System.IO.File]::ReadAllText($ShimPath) } catch { "" }
  $match = [regex]::Match($text, '"?([^"\r\n]*?)[\\/]orchestrator\.js"?', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return "" }
  $dir = $match.Groups[1].Value -replace '(?i)^%~?dp0%?\\?', ((Split-Path $ShimPath -Parent) + "\") -replace '(?i)^\$basedir/', ((Split-Path $ShimPath -Parent) + "\")
  $dir = $dir.Replace("/", "\").Replace("%%", "%")
  try {
    $item = Get-Item -LiteralPath $dir -Force -ErrorAction Stop
    if ($item.LinkType -and $item.Target) { $dir = @($item.Target)[0] }
    return (Resolve-FullPath $dir).TrimEnd("\")
  }
  catch { return (Resolve-FullPath $dir).TrimEnd("\") }
}

# Deletes a directory without following junctions or symlinks inside it (cmd's
# rmdir removes a link itself; PowerShell 5.1 can recurse into its target).
# The rename first fails cleanly while any file in it is in use.
function Remove-DirectoryTree {
  param([string]$Path)
  $staging = $Path.TrimEnd("\") + ".removing-" + [Guid]::NewGuid().ToString("N").Substring(0, 8)
  Rename-Item -LiteralPath $Path -NewName (Split-Path $staging -Leaf) -ErrorAction Stop
  $rc = Invoke-Logged -Description ("delete {0}" -f $Path) -Activity "Removing an old Posse copy" -Command @($env:ComSpec, "/d", "/c", "rmdir", "/s", "/q", $staging) -QuietFailure
  if ($rc -ne 0 -or (Test-Path -LiteralPath $staging)) { throw ("could not finish deleting {0}" -f $staging) }
}

# Earlier installs leave their own `posse` commands, checkouts, and native
# binaries behind: the pre-July <InstallRoot>\posse layout, npm global or
# linked copies, and launchers in other PATH folders. Retire them so only this
# checkout answers `posse`. Old copies this installer created are deleted when
# they hold no local changes; anything else is only unlinked and named.
function Remove-StalePosseInstalls {
  param([string]$CurrentRoot, [string]$ManagedBinDir)
  $notes = @()
  $current = (Resolve-FullPath $CurrentRoot).TrimEnd("\")
  $isCurrent = { param([string]$Root) $Root -and ((Test-PathUnder $Root $current) -or (Test-PathUnder $current $Root)) }
  $oldRoots = @()

  # npm's global copy, or an `npm link` to another checkout.
  $npmPackage = if ($env:APPDATA) { Join-Path $env:APPDATA "npm\node_modules\claude-org" } else { "" }
  if ($npmPackage -and (Test-Path -LiteralPath $npmPackage)) {
    $item = Get-Item -LiteralPath $npmPackage -Force
    $target = if ($item.LinkType -and $item.Target) { Resolve-FullPath (@($item.Target)[0]) } else { $npmPackage }
    if (-not (& $isCurrent $target)) {
      if ($DryRun) { $notes += ("would uninstall the npm global Posse ({0})" -f $target) }
      else {
        $npm = Get-Command npm -ErrorAction SilentlyContinue | Select-Object -First 1
        $rc = if ($npm) { Invoke-Logged -Description "uninstall the npm global Posse (claude-org)" -Activity "Removing an old Posse copy" -Command @($npm.Source, "rm", "-g", "claude-org") -QuietFailure } else { 1 }
        if ($rc -eq 0) { $notes += ("uninstalled the npm global Posse ({0})" -f $target) }
        else { $notes += ("could not uninstall the npm global Posse; run: npm rm -g claude-org") }
      }
      if ($item.LinkType) { $oldRoots += $target }
    }
  }

  # Launchers in other PATH folders (and npm's folder) that run another copy.
  $dirs = @(Get-SavedPathDirs)
  if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA "npm") }
  $seen = @{}
  foreach ($dir in $dirs) {
    $full = try { (Resolve-FullPath $dir).TrimEnd("\") } catch { "" }
    if (-not $full -or $seen.ContainsKey($full.ToLowerInvariant()) -or $full -ieq $ManagedBinDir.TrimEnd("\")) { continue }
    $seen[$full.ToLowerInvariant()] = $true
    foreach ($name in @("posse", "posse.cmd", "posse.ps1", "claude-org", "claude-org.cmd", "claude-org.ps1")) {
      $launcher = Join-Path $full $name
      if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { continue }
      $root = Get-PosseLauncherRoot $launcher
      if (-not $root -or (& $isCurrent $root)) { continue }
      $oldRoots += $root
      if ($DryRun) { $notes += ("would remove the old posse command {0}" -f $launcher); continue }
      try { Remove-Item -LiteralPath $launcher -Force -ErrorAction Stop; $notes += ("removed the old posse command {0}" -f $launcher) }
      catch { $notes += ("could not remove the old posse command {0}: {1}" -f $launcher, $_.Exception.Message) }
    }
  }

  # Copies this installer created under InstallRoot, including abandoned clones.
  $installDirs = if ($InstallRoot -and (Test-Path -LiteralPath $InstallRoot)) { @(Get-ChildItem -LiteralPath $InstallRoot -Directory -Force -ErrorAction SilentlyContinue) } else { @() }
  foreach ($dir in $installDirs) {
    $root = Resolve-PosseRootFromCheckout $dir.FullName
    $abandoned = $dir.Name -match '^posse(-client)?\.(installing|removing)-[0-9a-f]+$'
    if (-not $abandoned -and ($dir.Name -notin @("posse", "posse-client") -or -not $root -or (& $isCurrent $root))) { continue }
    if (-not $abandoned) {
      $dirty = Get-GitOutput $dir.FullName @("status", "--porcelain", "--untracked-files=no")
      if ($null -eq $dirty -or $dirty) {
        $notes += ("kept the old Posse copy {0}: it has local changes or is not a git checkout; delete it yourself if unused" -f $dir.FullName)
        continue
      }
    }
    if ($DryRun) { $notes += ("would delete the old Posse copy {0}" -f $dir.FullName); continue }
    try { Remove-DirectoryTree $dir.FullName; $notes += ("deleted the old Posse copy {0}" -f $dir.FullName) }
    catch { $notes += ("could not delete the old Posse copy {0} (close any Posse windows, then delete it): {1}" -f $dir.FullName, $_.Exception.Message) }
  }

  # Other checkouts the old commands ran are the user's own; name, never delete.
  foreach ($root in @($oldRoots | Where-Object { $_ -and (Test-Path -LiteralPath $_) -and -not ($InstallRoot -and (Test-PathUnder $_ $InstallRoot)) } | Sort-Object -Unique)) {
    $notes += ("an older Posse checkout at {0} no longer answers the posse command; delete it if unused" -f $root)
  }

  # Bossy falls back to this cache to find Posse; an old root there would send
  # it to the retired copy. Posse rewrites it on the next update check.
  $updateCheck = Join-Path $env:USERPROFILE ".posse\update-check.json"
  if (Test-Path -LiteralPath $updateCheck) {
    $cached = try { Get-Content -LiteralPath $updateCheck -Raw | ConvertFrom-Json } catch { $null }
    $cachedRoot = if ($cached -and $cached.check) { [string]$(if ($cached.check.posse_root) { $cached.check.posse_root } else { $cached.check.repo_root }) } else { "" }
    if ($cachedRoot -and -not (& $isCurrent (Resolve-FullPath $cachedRoot))) {
      if ($DryRun) { $notes += "would clear the update-check cache that names another Posse copy" }
      else { Remove-Item -LiteralPath $updateCheck -Force -ErrorAction SilentlyContinue; $notes += "cleared the update-check cache that named another Posse copy" }
    }
  }

  foreach ($note in $notes) {
    if ($note -match '^(could not|kept)') { Write-Warn2 $note } else { Write-Info $note }
  }
  return $notes
}

function Step-ShellWiring {
  Step-Begin "shell"
  $envDir = Join-Path $env:USERPROFILE ".config\posse"
  $script:EnvFile = Join-Path $envDir "atlas.env.ps1"
  $binDir = Join-Path $env:USERPROFILE ".local\bin"

  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" ("would write {0}, posse shims in {1}, and PATH/profile wiring" -f $script:EnvFile, $binDir)
    return
  }

  New-Item -ItemType Directory -Path $envDir -Force | Out-Null
  $envLiteral = "'" + ($binDir -replace "'", "''") + "'"
  $contents = @(
    "# Posse PATH wiring -- generated by install-posse-atlas.ps1",
    "# ATLAS runtime configuration lives in ~\.posse\account.db (posse admin),",
    "# not environment variables.",
    ('$env:POSSE_BIN_DIR = ' + $envLiteral),
    '$env:PATH = (@($env:POSSE_BIN_DIR) + @($env:PATH -split [System.IO.Path]::PathSeparator | Where-Object { $_ -and $_ -ine $env:POSSE_BIN_DIR })) -join [System.IO.Path]::PathSeparator'
  ) -join "`r`n"
  Set-Content -Path $script:EnvFile -Value $contents -Encoding UTF8

  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $cmdShim = Join-Path $binDir "posse.cmd"
  $psShim = Join-Path $binDir "posse.ps1"
  $orchestrator = Join-Path $script:PosseDirResolved "orchestrator.js"
  # cmd.exe expands %NAME% even inside quotes; double every literal percent so
  # a checkout path containing % cannot corrupt the shim.
  $cmdNodeBin = $script:NodeBin -replace "%", "%%"
  $cmdOrchestrator = $orchestrator -replace "%", "%%"
  $cmdNodeDir = (Split-Path $script:NodeBin -Parent) -replace "%", "%%"
  $cmdContents = ("@echo off`r`nset ""PATH={2};%PATH%""`r`n""{0}"" ""{1}"" %*`r`n" -f $cmdNodeBin, $cmdOrchestrator, $cmdNodeDir)
  [System.IO.File]::WriteAllText($cmdShim, $cmdContents, (New-Object System.Text.UTF8Encoding($false)))
  # A same-name .ps1 takes precedence over posse.cmd in PowerShell and is
  # unusable under the default Restricted execution policy. Remove the old
  # installer-generated shim; the UTF-8 posse.cmd is policy-independent.
  if (Test-Path $psShim) { Remove-Item $psShim -Force }

  # Keep the managed shim first so an older npm/global Posse install cannot
  # win command resolution. The shim itself is rewritten above to point at the
  # checkout resolved by this installer run.
  $script:UserPathChangedThisRun = $false
  if (-not $NoPersistEnv) {
    try {
      $userPath = Get-UserPathRaw
      # Compare expanded forms so a pre-existing %USERPROFILE%-style entry
      # dedupes against the expanded $binDir instead of duplicating it.
      $parts = @($userPath -split ";" | Where-Object { $_ -and ((Expand-PathEntry $_) -ine $binDir) })
      $newUserPath = (@($binDir) + $parts) -join ";"
      if ($newUserPath -ine $userPath) {
        Set-UserPathRaw $newUserPath
        Send-EnvironmentChangeBroadcast
        $script:UserPathChangedThisRun = $true
      }
    }
    catch {
      Write-Warn2 ("could not persist the Posse PATH entry; the shim still works in this session: {0}" -f $_.Exception.Message)
    }
  }
  $sessionParts = @($env:Path -split ";" | Where-Object { $_ -and $_ -ine $binDir })
  $env:Path = (@($binDir) + $sessionParts) -join ";"

  $executionPolicy = Get-PersistentExecutionPolicy
  $profileAllowed = $executionPolicy -notin @("Restricted", "AllSigned")
  if (-not $NoPersistEnv -and $PROFILE -and $profileAllowed) {
    try {
      $profileDir = Split-Path $PROFILE -Parent
      if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
      if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
      $existing = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
      if ($null -eq $existing -or -not $existing.Contains($script:EnvFile)) {
        Add-Content -Path $PROFILE -Value ("`n# Posse ATLAS integration`n. '" + ($script:EnvFile -replace "'", "''") + "'")
        Write-Info "updated $PROFILE"
      }
    }
    catch {
      Write-Warn2 ("could not update the PowerShell profile; posse.cmd remains available through PATH: {0}" -f $_.Exception.Message)
    }
  }
  elseif (-not $NoPersistEnv -and -not $profileAllowed) {
    Write-Warn2 ("PowerShell execution policy is {0}; skipped profile script wiring. posse.cmd remains available through the user PATH." -f $executionPolicy)
  }

  $note = "env file + UTF-8 posse.cmd shim installed for $script:PosseDirResolved"
  $retired = @(Remove-StalePosseInstalls $script:PosseDirResolved $binDir)
  if ($retired.Count -gt 0) { $note += ("; cleaned up {0} item(s) from older Posse installs (see log)" -f $retired.Count) }
  # Test-Cmd runs against this process's freshly seeded PATH, so it cannot
  # detect the case that matters; base the reminder on the persisted change.
  if ($script:UserPathChangedThisRun) { $note += " (open a new terminal to pick up PATH)" }
  Step-End "ok" $note
}

$script:SeedJs = @'
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const settingsPath = process.env.POSSE_ACCOUNT_DB_PATH
  ? path.resolve(process.env.POSSE_ACCOUNT_DB_PATH)
  : path.join(os.homedir(), ".posse", "account.db");
const seed = {
  atlas_phases: process.env.POSSE_SEED_PHASES,
  atlas_live_funnel: process.env.POSSE_SEED_FUNNEL,
  atlas_scip_mode: process.env.POSSE_SEED_SCIP_MODE,
  atlas_scip_languages: process.env.POSSE_SEED_SCIP_LANGUAGES,
};
// Keys named in POSSE_SEED_REPLACE (a language choice the user just made)
// overwrite a saved value; every other key only fills a missing one.
const replace = new Set(String(process.env.POSSE_SEED_REPLACE || "").split(",").map((key) => key.trim()).filter(Boolean));
let added = 0, kept = 0, skipped = 0, replaced = 0;
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
const tx = db.transaction((entries) => {
  for (const [k, v] of entries) {
    if (v == null || String(v).trim() === "") { skipped++; continue; }
    const current = get.get(k);
    if (!current || current.setting_value == null || String(current.setting_value).trim() === "") {
      upsert.run(k, String(v));
      added++;
    } else if (replace.has(k) && String(current.setting_value) !== String(v)) {
      upsert.run(k, String(v));
      replaced++;
    } else {
      kept++;
    }
  }
});
tx(Object.entries(seed));
db.close();
console.log(`[seed-settings] wrote ${settingsPath} -- added ${added}, replaced ${replaced}, kept ${kept} existing, skipped ${skipped} empty`);
'@

function Step-SeedSettings {
  Step-Begin "seed"
  if ($SkipSettings) { Step-End "skipped" "-SkipSettings"; return }
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would seed missing ATLAS keys into ~/.posse/account.db (merge-only)"
    return
  }
  # The seed file must live inside the Posse tree: Node resolves require()
  # from the script's own directory, and better-sqlite3 lives in
  # $PosseDir\node_modules. The .cjs extension keeps it CommonJS despite the
  # repo's "type": "module"; .posse\ is gitignored.
  $seedDir = Join-Path $script:PosseDirResolved ".posse"
  New-Item -ItemType Directory -Path $seedDir -Force | Out-Null
  $seedFile = Join-Path $seedDir "install-seed.tmp.cjs"
  Set-Content -Path $seedFile -Value $script:SeedJs -Encoding UTF8

  $env:POSSE_SEED_MODE = $PosseMode
  $env:POSSE_SEED_PHASES = $PossePhases
  $env:POSSE_SEED_FUNNEL = $PosseLiveFunnel
  $env:POSSE_SEED_SCIP_MODE = $PosseScipMode
  $env:POSSE_SEED_SCIP_LANGUAGES = $PosseScipLanguages
  $env:POSSE_SEED_REPLACE = if ($script:ScipLanguagesChosen) { "atlas_scip_languages" } else { "" }
  try {
    $rc = Invoke-Logged -Description "seed ~/.posse/account.db (missing values filled; a language choice replaces the saved one)" -Activity "Saving account settings" -Command @($script:NodeBin, $seedFile) -WorkingDirectory $script:PosseDirResolved
    if ($rc -eq 0) { Step-End "ok" "account settings seeded" }
    else {
      Write-Warn2 "settings seed failed; run 'posse admin' to configure ATLAS settings manually"
      Step-End "failed" "seed script failed; see log"
    }
  }
  finally {
    Remove-Item $seedFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\POSSE_SEED_MODE, Env:\POSSE_SEED_PHASES, Env:\POSSE_SEED_FUNNEL, Env:\POSSE_SEED_SCIP_MODE, Env:\POSSE_SEED_SCIP_LANGUAGES, Env:\POSSE_SEED_REPLACE -ErrorAction SilentlyContinue
  }
}

function Step-Doctor {
  Step-Begin "doctor"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would run 'posse doctor' (SCIP + current native binaries + Jina)"
    return
  }
  Write-Info "delegating to Posse's own dependency engine (SCIP indexer environments)"
  $rc = Invoke-Logged -Description "posse doctor (first run builds SCIP envs and deploys Jina)" -Activity "Building code indexers and the search model (the longest step)" -Command @($script:NodeBin, "orchestrator.js", "doctor", "--adopt-node-install") -WorkingDirectory $script:PosseDirResolved -TimeoutSeconds $DoctorTimeoutSeconds
  if ($rc -eq 0) { Step-End "ok" "runtime dependencies, binaries, and Jina ready"; return }
  if ($rc -eq 124) {
    Write-Warn2 "posse doctor did not finish in time - run 'posse doctor' to complete it (log has details)"
    Step-End "failed" ("posse doctor timed out after {0} min" -f [int]($DoctorTimeoutSeconds / 60))
    return
  }

  # Most first-run failures are downloads, so try once more. The retry reports
  # as JSON, which says exactly what is still missing.
  Write-Info "retrying posse doctor once"
  $rc = Invoke-Logged -Description "posse doctor (retry)" -Activity "Retrying the code indexers and search model" -Command @($script:NodeBin, "orchestrator.js", "doctor", "--adopt-node-install", "--json") -WorkingDirectory $script:PosseDirResolved -TimeoutSeconds $DoctorTimeoutSeconds
  if ($rc -eq 0) { Step-End "ok" "runtime dependencies, binaries, and Jina ready (second attempt)"; return }
  $failedLabels = @(Get-DoctorFailedLabels $script:LastCommandStdout)
  # Without the search model Posse still runs, with lexical search only; only
  # doctor (or posse update) downloads it later, so say so.
  if ($rc -ne 124 -and $failedLabels.Count -gt 0 -and @($failedLabels | Where-Object { $_ -notmatch '^model ' }).Count -eq 0) {
    Write-Warn2 "the code search model did not download; semantic search stays off until 'posse doctor' completes it"
    Step-End "partial" "search model not downloaded; run 'posse doctor' later to add semantic search"
    return
  }
  $what = if ($failedLabels.Count -gt 0) { (@($failedLabels | Select-Object -First 4) -join ", ") } else { "see log" }
  Write-Warn2 "posse doctor reported unresolved dependencies - run 'posse doctor' after fixing the tools it names (log has details)"
  Step-End "failed" ("still unresolved after a retry: {0}" -f $what)
}

# Labels of the entries `posse doctor --json` reports as failed ("model jina",
# "scip python", "native posse-ml", ...); empty when the output holds no report.
function Get-DoctorFailedLabels {
  param([string]$Output)
  $match = [regex]::Match([string]$Output, '(?ms)^\{\r?\n\s*"ok":.*?^\}')
  if (-not $match.Success) { return @() }
  try { $report = ConvertFrom-Json -InputObject $match.Value }
  catch { return @() }
  if (-not $report.doctor) { return @() }
  return @(@($report.doctor.failed) | Where-Object { $_ } | ForEach-Object {
    if ($_.label) { [string]$_.label } elseif ($_.language) { [string]$_.language } else { "dependency" }
  })
}

function Step-AdminInit {
  Step-Begin "admin"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would run posse admin init --non-interactive --provider-clis-only"
    return
  }
  $rc = Invoke-Logged -Description "detect provider CLIs (admin init)" -Activity "Looking for Claude, Codex, and other provider apps" -Command @($script:NodeBin, "orchestrator.js", "admin", "init", "--non-interactive", "--provider-clis-only") -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "provider CLI detection complete" }
  else {
    Write-Warn2 "posse admin init failed - run 'posse admin init' manually to see provider CLI detection details"
    Step-End "failed" "admin init failed; see log"
  }
}

function Step-Validate {
  Step-Begin "validate"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would run posse status"
    return
  }
  $rc = Invoke-Logged -Description "boot posse (posse status)" -Activity "Starting Posse to check it works" -Command @($script:NodeBin, "orchestrator.js", "status") -WorkingDirectory $script:PosseDirResolved -TimeoutSeconds 300
  if ($rc -eq 0) { Step-End "ok" "posse boots cleanly" }
  else {
    Write-Warn2 ("posse failed to boot - run 'posse status' in {0} to see the error" -f $script:PosseDirResolved)
    Step-End "failed" "status returned non-zero; see log"
  }
}

# --- provider keys (interactive; no spinner) --------------------------------------
$script:ConfiguredKeys = @()
$script:ProviderKeyNames = @("POSSE_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY", "CODEX_API_KEY")

function Read-ProviderKeysFile {
  param([string]$PathValue)
  $values = @{}
  if (-not (Test-Path -LiteralPath $PathValue)) { return ,$values }
  # This file is data, not trusted code. Accept only the exact single-quoted
  # assignments emitted by this installer; ignore comments or arbitrary PS.
  $assignment = '^\s*\$env:(POSSE_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|CODEX_API_KEY)\s*=\s*''((?:[^'']|'''')*)''\s*$'
  foreach ($line in Get-Content -LiteralPath $PathValue -ErrorAction Stop) {
    $match = [regex]::Match([string]$line, $assignment)
    if (-not $match.Success) { continue }
    $values[$match.Groups[1].Value] = $match.Groups[2].Value.Replace("''", "'")
  }
  return ,$values
}

function Import-ProviderKeysFile {
  param([string]$PathValue)
  $values = Read-ProviderKeysFile $PathValue
  foreach ($name in $values.Keys) {
    if (-not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, [string]$values[$name], "Process")
    }
  }
  return ,$values
}

# Only the file's access list changes: you, SYSTEM, and Administrators, nothing
# inherited. The owner is left alone (you already own files you create).
function New-ProviderFileSecurity {
  $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $security = New-Object System.Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sidValue in @($currentUser.Value, "S-1-5-18", "S-1-5-32-544")) {
    $sid = New-Object System.Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  return $security
}

# Writes only the access list. Set-Acl also tries to rewrite the audit list,
# which needs SeSecurityPrivilege and fails for a normal user.
function Set-FileAccessList {
  param([string]$PathValue, $Security)
  if ($PSVersionTable.PSEdition -eq "Core") {
    [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($PathValue), $Security)
  }
  else {
    [System.IO.File]::SetAccessControl($PathValue, $Security)
  }
}

function Set-ProviderFileAcl {
  param([string]$PathValue)
  Set-FileAccessList $PathValue (New-ProviderFileSecurity)
}

function Write-RestrictedProviderFile {
  param([string]$PathValue, [string]$Contents)
  $dir = Split-Path $PathValue -Parent
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  if (Test-Path -LiteralPath $PathValue) { Set-ProviderFileAcl $PathValue }

  $temporary = Join-Path $dir (".providers-" + [Guid]::NewGuid().ToString("N") + ".tmp")
  $stream = $null
  $writer = $null
  try {
    $security = New-ProviderFileSecurity
    # Create an empty file first, apply the restricted ACL, and only then write
    # secret bytes. This works on both .NET Framework (PS 5.1) and modern .NET.
    $stream = [System.IO.File]::Open(
      $temporary,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
    $stream.Dispose()
    $stream = $null
    Set-FileAccessList $temporary $security
    $stream = [System.IO.File]::Open(
      $temporary,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
    $stream = $null # StreamWriter owns it from here.
    $writer.Write($Contents)
    $writer.Flush()
    $writer.Dispose()
    $writer = $null
    Move-Item -LiteralPath $temporary -Destination $PathValue -Force
    Set-ProviderFileAcl $PathValue
  }
  finally {
    if ($writer) { $writer.Dispose() }
    if ($stream) { $stream.Dispose() }
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Persist-UserEnvironmentKey {
  param([string]$VarName, [string]$Value)
  # The launcher loads the private .env itself, so user-scope environment
  # persistence is no longer created for new installs: HKCU values are
  # inherited by every process in the session and would shadow a rotated
  # .env key. Existing entries from older installers are only kept in sync.
  try {
    [Environment]::SetEnvironmentVariable($VarName, $Value, "User")
    return $true
  }
  catch {
    Write-Warn2 ("could not update {0} in the user environment: {1}" -f $VarName, $_.Exception.Message)
    return $false
  }
}

function Sync-LegacyUserEnvironmentKey {
  param([string]$VarName, [string]$Value)
  $existing = [Environment]::GetEnvironmentVariable($VarName, "User")
  if (-not $existing -or $existing -ceq $Value) { return $false }
  return (Persist-UserEnvironmentKey $VarName $Value)
}

function Prompt-ForKey {
  param([string]$Label, [string]$VarName, [switch]$FromParentEnv, [string]$StoredValue = "")
  if ($FromParentEnv) {
    $existing = [Environment]::GetEnvironmentVariable($VarName, "Process")
    Write-Info "$VarName already set in this shell (length $($existing.Length)) - keeping it"
    return $false
  }
  $promptSuffix = if ($StoredValue) { "press Enter to keep the stored key" } else { "press Enter to skip" }
  $secure = Read-Host -Prompt "      Enter $Label ($promptSuffix)" -AsSecureString
  if ($secure.Length -eq 0) {
    if ($StoredValue) { Write-Info "kept stored $VarName" } else { Write-Info "skipped $Label" }
    return $false
  }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  # Pasted keys often carry surrounding whitespace; interior whitespace is
  # never part of a key, so refuse it rather than save a value that fails later.
  $plain = if ($plain) { $plain.Trim() } else { "" }
  if (-not $plain) { Write-Info "skipped $Label"; return $false }
  if ($plain -match '\s') {
    Write-Warn2 "$Label contained interior whitespace and was not saved; re-run with -ConfigureKeys to try again"
    return $false
  }
  [Environment]::SetEnvironmentVariable($VarName, $plain, "Process")
  $script:ConfiguredKeys += [PSCustomObject]@{ Name = $VarName; Value = $plain }
  return $true
}

function Get-SavedEnvironmentKey {
  foreach ($scope in @("User", "Machine")) {
    $value = [Environment]::GetEnvironmentVariable("POSSE_KEY", $scope)
    if ($value) { return [PSCustomObject]@{ Scope = $scope.ToLowerInvariant(); Value = $value } }
  }
  return $null
}

# Keys collected by the setup wizard arrive in a file, never on the command
# line. The file is data: only known NAME=value lines are read, and it is
# deleted whether or not it parses.
function Read-InstallerKeyFile {
  param([string]$PathValue)
  $values = @{}
  try {
    foreach ($line in Get-Content -LiteralPath $PathValue -ErrorAction Stop) {
      $match = [regex]::Match([string]$line, '^\s*(POSSE_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|CODEX_API_KEY)=(.*)$')
      if (-not $match.Success) { continue }
      $value = $match.Groups[2].Value.Trim()
      if (-not $value) { continue }
      if ($value -match '\s') {
        Write-Warn2 ("{0} from setup contained interior whitespace and was not saved" -f $match.Groups[1].Value)
        continue
      }
      $values[$match.Groups[1].Value] = $value
    }
  }
  finally {
    Remove-Item -LiteralPath $PathValue -Force -ErrorAction SilentlyContinue
  }
  return ,$values
}

function Step-Keys {
  Step-Begin "keys"
  $providersFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") "providers.env.ps1"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  # Snapshot which keys the parent shell already carried, before the stored
  # file is imported into process env, so re-running -ConfigureKeys can still
  # replace a stored (rotated/wrong) key.
  $parentEnvKeys = @{}
  foreach ($name in $script:ProviderKeyNames) {
    if ([Environment]::GetEnvironmentVariable($name, "Process")) { $parentEnvKeys[$name] = $true }
  }
  $privateEnvFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") ".env"
  $envBridge = Join-Path $script:PosseDirResolved "installers\installer-env.mjs"
  $dotenvKeys = @{}
  # An existing checkout is reused as-is, so a newer installer can meet an
  # older tree that lacks the credential bridge. Name the real cause.
  if (-not (Test-Path -LiteralPath $envBridge)) {
    Step-FailCritical ("checkout {0} predates this installer (installers\installer-env.mjs is missing); update it with 'git pull' or 'posse update', then re-run" -f $script:PosseDirResolved)
    return
  }
  if (-not $DryRun) {
    $json = & $script:NodeBin $envBridge read-json
    if ($LASTEXITCODE -ne 0) { Step-FailCritical "cannot read private .env file"; return }
    $saved = ConvertFrom-Json -InputObject ([string]$json)
    foreach ($property in $saved.PSObject.Properties) {
      $dotenvKeys[$property.Name] = [string]$property.Value
      if (-not [Environment]::GetEnvironmentVariable($property.Name, "Process")) {
        [Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value, "Process")
      }
    }
    # Tightening an existing file's permissions is hardening, not a reason to
    # fail setup when the saved keys themselves are fine.
    if (Test-Path -LiteralPath $privateEnvFile) {
      try { Set-ProviderFileAcl $privateEnvFile }
      catch { Write-Warn2 ("could not restrict permissions on {0}: {1}" -f $privateEnvFile, $_.Exception.Message) }
    }
  }
  $storedKeys = $dotenvKeys.Clone()
  $aclReady = $true
  if (Test-Path -LiteralPath $providersFile) {
    try {
      $legacyKeys = Import-ProviderKeysFile $providersFile
      foreach ($name in $legacyKeys.Keys) {
        if (-not $storedKeys.ContainsKey($name)) { $storedKeys[$name] = $legacyKeys[$name] }
      }
      if (-not $DryRun) {
        # The file is dot-sourced by $PROFILE, so it must only ever contain the
        # known assignments -- but never destroy user content silently: keep a
        # one-time .bak beside it when unrecognized lines are dropped.
        $assignmentPattern = '^\s*\$env:(POSSE_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY|XAI_API_KEY|CODEX_API_KEY)\s*=\s*''(?:[^'']|'''')*''\s*$'
        $rawLines = @(Get-Content -LiteralPath $providersFile -ErrorAction Stop)
        $droppedLines = @($rawLines | Where-Object { $_ -and $_.Trim() -and $_ -notmatch $assignmentPattern -and $_.Trim() -notmatch '^#' })
        if ($droppedLines.Count -gt 0) {
          $backupPath = "$providersFile.bak"
          if (-not (Test-Path -LiteralPath $backupPath)) {
            Copy-Item -LiteralPath $providersFile -Destination $backupPath -Force
            try { Set-ProviderFileAcl $backupPath } catch { Write-LogOnly ("[keys] backup ACL: {0}" -f $_.Exception.Message) }
          }
          Write-Warn2 ("{0} unrecognized line(s) in {1} were dropped (only key assignments are kept); original saved to {2}" -f $droppedLines.Count, $providersFile, $backupPath)
        }
        $safeLines = @("# Posse provider API keys -- generated by install-posse-atlas.ps1")
        foreach ($name in $script:ProviderKeyNames) {
          if ($storedKeys.ContainsKey($name) -and $storedKeys[$name]) {
            $safeLines += ('$env:{0} = ''{1}''' -f $name, ([string]$storedKeys[$name] -replace "'", "''"))
          }
        }
        Write-RestrictedProviderFile $providersFile (($safeLines -join "`r`n") + "`r`n")
        # Legacy keys are read as data by the runtime's .env loader; they are
        # deliberately not copied into the user environment any more.
      }
    }
    catch {
      $aclReady = $false
      Write-Warn2 ("could not validate or restrict provider key file {0}: {1}" -f $providersFile, $_.Exception.Message)
    }
  }
  if ($KeyFile -and -not $DryRun) {
    try { $handedKeys = Read-InstallerKeyFile $KeyFile }
    catch { Step-FailCritical ("could not read the keys handed over by setup: {0}" -f $_.Exception.Message); return }
    foreach ($name in $script:ProviderKeyNames) {
      if (-not $handedKeys.ContainsKey($name)) { continue }
      [Environment]::SetEnvironmentVariable($name, [string]$handedKeys[$name], "Process")
      $script:ConfiguredKeys += [PSCustomObject]@{ Name = $name; Value = [string]$handedKeys[$name] }
    }
  }
  # A key saved as a Windows environment variable after this shell started is
  # not inherited; use it rather than asking for it again.
  if (-not $env:POSSE_KEY) {
    $savedKey = Get-SavedEnvironmentKey
    if ($savedKey) {
      [Environment]::SetEnvironmentVariable("POSSE_KEY", $savedKey.Value, "Process")
      Write-Info ("using the POSSE_KEY saved in your {0} environment variables" -f $savedKey.Scope)
    }
  }
  $promptPosseKey = -not $env:POSSE_KEY -and (Test-InteractiveInput)
  if (-not $ConfigureKeys -and -not $promptPosseKey -and $script:ConfiguredKeys.Count -eq 0) {
    if (-not $DryRun -and -not $env:POSSE_KEY) {
      Step-FailCritical "POSSE_KEY is required; re-run interactively, inject it into the environment, or use -SetupOnly for an image build"
      return
    }
    if (Test-Path -LiteralPath $providersFile) {
      if ($DryRun) { Step-End "dry-run" "would sanitize known provider assignments and repair the existing ACL" }
      elseif ($aclReady) { Step-End "ok" "existing provider key file sanitized and ACL repaired" }
      else { Step-End "partial" "existing provider key file ACL could not be secured" }
    }
    else { Step-End "ok" "Posse key available from .env or process environment" }
    return
  }
  if ($DryRun) {
    Step-End "dry-run" "would prompt for POSSE_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY / CODEX_API_KEY"
    return
  }
  # Keys handed over by setup need no terminal; prompt only when asked to.
  if ($ConfigureKeys -or $promptPosseKey) {
    if (-not (Test-InteractiveInput)) {
      Write-Warn2 "-ConfigureKeys needs an interactive terminal; skipped"
      Step-End "skipped" "no interactive terminal"
      return
    }

    Write-Info "input is hidden; press Enter to skip any key"
    foreach ($prompt in @(
      @{ Label = "Posse remote key"; Name = "POSSE_KEY" },
      @{ Label = "Anthropic API key"; Name = "ANTHROPIC_API_KEY" },
      @{ Label = "OpenAI API key"; Name = "OPENAI_API_KEY" },
      @{ Label = "xAI (Grok) key"; Name = "XAI_API_KEY" },
      @{ Label = "Codex API key (optional - skip if you prefer 'codex login')"; Name = "CODEX_API_KEY" }
    )) {
      if (-not $ConfigureKeys -and $prompt.Name -ne "POSSE_KEY") { continue }
      $stored = if ($storedKeys.ContainsKey($prompt.Name)) { [string]$storedKeys[$prompt.Name] } else { "" }
      [void](Prompt-ForKey $prompt.Label $prompt.Name -FromParentEnv:($parentEnvKeys.ContainsKey($prompt.Name)) -StoredValue $stored)
    }

    if ($ConfigureKeys -and (Test-Cmd "claude")) {
      $ans = Read-Host "      Run 'claude' now to log in to Claude? [y/N]"
      if ($ans -match '^[Yy]$') {
        try { & claude } catch { Write-Warn2 "claude login command did not exit cleanly: $_" }
      }
    }
    if ($ConfigureKeys -and (Test-Cmd "codex") -and -not $env:CODEX_API_KEY) {
      $ans = Read-Host "      Run 'codex login' now? [y/N]"
      if ($ans -match '^[Yy]$') {
        try { & codex login } catch { Write-Warn2 "codex login command did not exit cleanly: $_" }
      }
    }
  }

  if (-not $env:POSSE_KEY) { Step-FailCritical "POSSE_KEY was not provided; runtime setup requires it"; return }
  if ($script:ConfiguredKeys.Count -eq 0) {
    if ($aclReady) { Step-End "ok" "no new keys captured; existing ACL verified" }
    else { Step-End "partial" "no new keys captured; existing ACL could not be secured" }
    return
  }

  # Merge only known assignments. Unknown lines are intentionally discarded so
  # a provider data file can never become a persistence/code-execution vector.
  foreach ($key in $script:ConfiguredKeys) { $storedKeys[$key.Name] = $key.Value }
  $lines = @("# Posse provider API keys -- generated by install-posse-atlas.ps1")
  foreach ($name in $script:ProviderKeyNames) {
    if ($storedKeys.ContainsKey($name) -and $storedKeys[$name]) {
      $lines += ('$env:{0} = ''{1}''' -f $name, ([string]$storedKeys[$name] -replace "'", "''"))
    }
  }
  try {
    $configuredNames = @($script:ConfiguredKeys | ForEach-Object { $_.Name })
    $envContents = & $script:NodeBin $envBridge format @configuredNames
    if ($LASTEXITCODE -ne 0) { throw "could not format private .env file" }
    Write-RestrictedProviderFile $privateEnvFile (($envContents -join "`n") + "`n")
    $aclReady = $true
    # The private .env is the only store new installs create. Older stores
    # (profile-sourced providers.env.ps1, HKCU user environment) shadow .env
    # in every new shell, so when they already exist they must follow a
    # rotation; they are never created here.
    $syncedStores = @()
    if (Test-Path -LiteralPath $providersFile) {
      Write-RestrictedProviderFile $providersFile (($lines -join "`r`n") + "`r`n")
      $syncedStores += "providers.env.ps1"
    }
    foreach ($name in $script:ProviderKeyNames) {
      if ($storedKeys.ContainsKey($name) -and $storedKeys[$name]) {
        if (Sync-LegacyUserEnvironmentKey $name ([string]$storedKeys[$name])) { $syncedStores += "user environment ($name)" }
      }
    }
  }
  catch {
    Write-Warn2 ("could not write provider keys with a restrictive ACL; the previous file was preserved: {0}" -f $_.Exception.Message)
    Step-FailCritical "could not securely persist credentials; fix file permissions and re-run"
    return
  }

  $note = "wrote {0} key(s) to {1} (restricted ACL)" -f $script:ConfiguredKeys.Count, $privateEnvFile
  if ($syncedStores.Count -gt 0) { $note += "; updated existing legacy stores: " + ($syncedStores -join ", ") }
  Step-End "ok" $note
}

# POSSE_KEY for the native download: the process environment, else the older
# provider file, else the user/machine environment. False when there is none.
function Import-NativeDownloadKey {
  $providersFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") "providers.env.ps1"
  if (-not $env:POSSE_KEY -and (Test-Path $providersFile)) {
    try { [void](Import-ProviderKeysFile $providersFile) }
    catch { Write-Warn2 ("provider key file could not be parsed safely: {0}" -f $_.Exception.Message) }
  }
  if (-not $env:POSSE_KEY) {
    $persistedKey = [Environment]::GetEnvironmentVariable("POSSE_KEY", "User")
    if (-not $persistedKey) { $persistedKey = [Environment]::GetEnvironmentVariable("POSSE_KEY", "Machine") }
    if ($persistedKey) { $env:POSSE_KEY = $persistedKey }
  }
  return [bool]$env:POSSE_KEY
}

# The native binaries are setup's largest downloads and need only Node, the
# checkout's npm packages, and the Posse key. Start-NativeDownload runs them in
# the background as soon as npm finishes, while host tools and the rest of
# setup install; Step-NativeBinaries collects the result before doctor, which
# uses them, and downloads in the foreground if the background run failed.
function Start-NativeDownload {
  if ($script:CriticalFailed -or $DryRun -or $script:NativeDownload) { return }
  if (-not (Import-NativeDownloadKey)) { return }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $out = Join-Path $script:LogDir ("native-download-{0}.out.log" -f $stamp)
  $err = Join-Path $script:LogDir ("native-download-{0}.err.log" -f $stamp)
  try {
    $process = Start-Process -FilePath $script:NodeBin -ArgumentList "scripts/pull-native-artifacts.mjs" -WorkingDirectory $script:PosseDirResolved -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    # Holding the handle keeps ExitCode readable after the process exits.
    $null = $process.Handle
    $script:NativeDownload = [PSCustomObject]@{ Process = $process; Out = $out; Err = $err; Started = Get-Date }
    Write-LogOnly (">>> native binaries downloading in the background (pid {0})" -f $process.Id)
    Write-Info "native tools are downloading in the background while setup continues"
  }
  catch { Write-LogOnly ("[native] could not start the background download: {0}" -f $_.Exception.Message) }
}

# Waits for the background download (within the command timeout) and returns
# its exit code: 124 on timeout, $null when none was started. -Abandon stops
# one still running because setup ended early.
function Receive-NativeDownload {
  param([switch]$Abandon)
  $job = $script:NativeDownload
  if (-not $job) { return $null }
  $script:NativeDownload = $null
  $process = $job.Process
  $rc = $null
  if ($Abandon) {
    Stop-InstallerProcessTree $process
    $rc = 130
  }
  elseif (-not $process.HasExited) {
    Write-SetupProgress @("act", "Finishing the native tool downloads")
    $elapsed = [int]((Get-Date) - $job.Started).TotalSeconds
    if (-not $process.WaitForExit([Math]::Max(1, $CommandTimeoutSeconds - $elapsed) * 1000)) {
      Stop-InstallerProcessTree $process
      $rc = 124
    }
  }
  if ($null -eq $rc) {
    $process.WaitForExit()
    $rc = $process.ExitCode
  }
  foreach ($file in @($job.Out, $job.Err)) {
    try { Get-Content -LiteralPath $file -ErrorAction Stop | ForEach-Object { Write-LogOnly ("[native] {0}" -f $_) } } catch {}
    Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  }
  Write-LogOnly ("[native] background download exited {0} after {1}s" -f $rc, [int]((Get-Date) - $job.Started).TotalSeconds)
  return $rc
}

function Step-NativeBinaries {
  Step-Begin "native"
  if ($script:CriticalFailed) {
    [void](Receive-NativeDownload -Abandon)
    Step-End "blocked"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" "would download current native binaries for this platform (in the background, from right after npm)"
    return
  }

  $background = Receive-NativeDownload
  if ($background -eq 0) {
    Step-End "ok" "native binaries downloaded while setup ran"
    return
  }
  if ($null -ne $background) { Write-Info "the background native download did not finish; downloading in the foreground" }
  if (-not (Import-NativeDownloadKey)) {
    Write-Warn2 "native binaries need POSSE_KEY; set it or re-run with -ConfigureKeys, then run 'npm run pull:native'"
    Step-End "partial" "POSSE_KEY unavailable; boot readiness will retry the download"
    return
  }

  # The download reports its combined percentage straight to the setup page.
  if ($ProgressFile) { $env:POSSE_SETUP_PROGRESS_FILE = $ProgressFile }
  try {
    $rc = Invoke-Logged -Description "download current native binaries" -Activity "Downloading Posse's native tools" -Command @($script:NodeBin, "scripts/pull-native-artifacts.mjs") -WorkingDirectory $script:PosseDirResolved
    # Binaries already current are only checked again, so one retry is cheap.
    if ($rc -ne 0 -and $rc -ne 124 -and $null -eq $background) {
      Write-Info "retrying once (transient network failures are common)"
      $rc = Invoke-Logged -Description "download current native binaries (retry)" -Activity "Retrying Posse's native tools" -Command @($script:NodeBin, "scripts/pull-native-artifacts.mjs") -WorkingDirectory $script:PosseDirResolved
    }
  }
  finally { Remove-Item Env:\POSSE_SETUP_PROGRESS_FILE -ErrorAction SilentlyContinue }
  if ($rc -eq 0) {
    Step-End "ok" "native binaries downloaded or already current"
  }
  else {
    Write-Warn2 ("native binary download failed; boot readiness will retry, or run 'npm run pull:native' in {0}" -f $script:PosseDirResolved)
    Step-End "partial" "native binaries unavailable; see log"
  }
}

function Step-Smoke {
  Step-Begin "smoke"
  if ($NoSmoke) { Step-End "skipped" "-NoSmoke"; return }
  if (-not $RepoPath) { Step-End "skipped" "no -RepoPath provided"; return }
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" ("would run atlas-smoke on {0}" -f $RepoPath)
    return
  }
  $repoLabel = if ($RepoId) { $RepoId } else { Split-Path $RepoPath -Leaf }
  $rc = Invoke-Logged -Description ("atlas-smoke {0} (query: {1})" -f $repoLabel, $SmokeQuery) -Activity "Testing code search" -Command @($script:NodeBin, "orchestrator.js", "atlas-smoke", $RepoPath, $SmokeQuery, $SmokeProvider) -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "smoke test passed" }
  else {
    Write-Warn2 ("atlas-smoke failed - run it manually: posse atlas-smoke {0} {1} {2}" -f $RepoPath, $SmokeQuery, $SmokeProvider)
    Step-End "failed" "smoke test failed; see log"
  }
}

# --- soft preflight checks (warnings only) ------------------------------------------
function Test-ProviderCredentials {
  # Saved keys are loaded later by the keys step (it needs Node and the
  # checkout); preflight runs before that, so do not warn about their absence.
  $savedEnv = Join-Path (Join-Path $env:USERPROFILE ".config\posse") ".env"
  if ((Test-Path -LiteralPath $savedEnv) -and (Get-Item -LiteralPath $savedEnv).Length -gt 0) {
    Write-Info ("saved credentials found in {0}; they load in the keys step" -f $savedEnv)
    return
  }
  $found = @()
  if (Test-Cmd "claude") { $found += "claude-cli" }
  if ($env:ANTHROPIC_API_KEY) { $found += "ANTHROPIC_API_KEY" }
  if ($env:OPENAI_API_KEY) { $found += "OPENAI_API_KEY" }
  if ($env:XAI_API_KEY) { $found += "XAI_API_KEY" }
  $codexAuth = Join-Path $env:USERPROFILE ".codex\auth.json"
  if ($env:CODEX_API_KEY -or (Test-Path $codexAuth)) { $found += "codex" }
  if ($found.Count -eq 0) {
    if ($ConfigureKeys) { Write-Info "no provider credentials detected yet - the keys step below will prompt for them" }
    else { Write-Warn2 "no provider credentials detected (claude CLI / ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY / codex). Re-run with -ConfigureKeys, or set one before dispatching jobs." }
  }
  else {
    Write-Info ("provider credentials detected: " + ($found -join ", "))
  }
  if (-not $env:POSSE_KEY -and -not $ConfigureKeys -and -not $KeyFile) {
    Write-Warn2 "POSSE_KEY is not set - Posse remote prompt/tool catalog requests need it (-ConfigureKeys can capture it)"
  }
}

function Test-GitConfig {
  if (-not (Test-Cmd "git")) { return }
  $name = ""; $email = ""
  try { $name = (& git config --global user.name 2>$null) } catch {}
  try { $email = (& git config --global user.email 2>$null) } catch {}
  if (-not $name) { Write-Warn2 'git user.name is not set globally (git config --global user.name "Your Name")' }
  if (-not $email) { Write-Warn2 'git user.email is not set globally (git config --global user.email "you@example.com")' }
}

# Free bytes on the fullest drive among these paths (existing parents count).
function Get-LowestFreeDisk {
  param([string[]]$Paths)
  $lowest = $null
  foreach ($pathValue in @($Paths | Where-Object { $_ })) {
    try {
      $root = [System.IO.Path]::GetPathRoot((Resolve-FullPath $pathValue))
      if (-not $root) { continue }
      $free = (New-Object System.IO.DriveInfo($root)).AvailableFreeSpace
      if ($null -eq $lowest -or $free -lt $lowest.Free) { $lowest = [PSCustomObject]@{ Root = $root; Free = [long]$free } }
    }
    catch { Write-LogOnly ("[preflight] free space of {0}: {1}" -f $pathValue, $_.Exception.Message) }
  }
  return $lowest
}

# Hosts setup downloads from that this PC cannot reach, as "host (why)". Any
# HTTP answer counts as reachable; only a failed connection does not.
function Get-UnreachableHosts {
  param([string[]]$Hosts, [int]$TimeoutMs = 8000)
  $why = @{
    NameResolutionFailure = "name lookup failed"; ConnectFailure = "connection refused or blocked"; Timeout = "timed out"
    TrustFailure = "certificate not trusted; a proxy may be inspecting traffic"; SecureChannelFailure = "secure connection failed"
    ProxyNameResolutionFailure = "proxy not found"
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $missing = @()
  foreach ($hostName in $Hosts) {
    try {
      $request = [System.Net.HttpWebRequest]::Create("https://$hostName/")
      $request.Method = "HEAD"
      $request.Timeout = $TimeoutMs
      $request.AllowAutoRedirect = $false
      $request.UserAgent = "PosseSetup"
      $request.GetResponse().Dispose()
    }
    catch {
      $web = Get-WebException $_.Exception
      if ($web -and $web.Response) { $web.Response.Dispose(); continue }
      $status = if ($web) { [string]$web.Status } else { "" }
      $reason = if ($why.ContainsKey($status)) { $why[$status] } elseif ($status) { $status } else { $_.Exception.Message }
      $missing += ("{0} ({1})" -f $hostName, $reason)
    }
  }
  return $missing
}

# A proxy URL can carry a password; never log it.
function Format-ProxyForLog {
  param([string]$Url)
  return ([string]$Url -replace '//[^/@]*@', '//***@')
}

function Test-IsElevated {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  catch { return $false }
}

function Step-Preflight {
  Step-Begin "preflight"
  if (Test-IsElevated) {
    $script:CriticalFailed = $true
    Step-End "failed" "do not run this installer elevated: it would install Posse into the Administrator profile (PATH, keys, and managed state land in the wrong account). Re-run from a normal PowerShell window."
    return $false
  }
  if ($script:RepoPath) {
    $script:RepoPath = Resolve-FullPath $script:RepoPath
    if (-not (Test-Path $script:RepoPath)) {
      $script:CriticalFailed = $true
      Step-End "failed" ("repo path does not exist: {0}" -f $script:RepoPath)
      return $false
    }
    if (-not $script:RepoId) { $script:RepoId = Split-Path $script:RepoPath -Leaf }
    Write-Info "smoke repo: $script:RepoPath"
  }
  else {
    Write-Info "no -RepoPath provided; smoke test will be skipped"
  }
  if (-not $DryRun) {
    $requiredUserDirs = @(
      $script:ManagedStateRoot,
      (Join-Path $env:USERPROFILE ".config\posse"),
      (Join-Path $env:USERPROFILE ".local\bin")
    )
    foreach ($requiredDir in $requiredUserDirs) {
      if (-not (Test-DirectoryWriteAccess $requiredDir -Create)) {
        $script:CriticalFailed = $true
        Step-End "failed" ("current user cannot write required install directory: {0}" -f $requiredDir)
        return $false
      }
    }
    Write-Info ("managed Windows runtimes: {0}" -f $script:ManagedStateRoot)
  }
  $notes = @()
  if (-not $DryRun) {
    # Disk: Git, Node, node_modules, indexers, and the search model need about
    # 3 GB (more with Rust); under 1 GB the install cannot finish.
    $target = if ($PosseDir) { $PosseDir } else { $InstallRoot }
    $disk = Get-LowestFreeDisk @($env:USERPROFILE, $localAppDataRoot, $target)
    if ($disk) {
      $freeGb = [math]::Round($disk.Free / 1GB, 1)
      if ($disk.Free -lt 1GB) {
        $script:CriticalFailed = $true
        Step-End "failed" ("only {0} GB free on {1}; Posse needs about 3 GB. Free some space, then run setup again." -f $freeGb, $disk.Root)
        return $false
      }
      if ($disk.Free -lt 3GB) {
        Write-Warn2 ("only {0} GB free on {1}; a full install needs about 3 GB" -f $freeGb, $disk.Root)
        $notes += ("low disk space ({0} GB free)" -f $freeGb)
      }
    }

    # Network: a blocked host is a warning, not a stop, because proxies can
    # make a probe fail where the real download works.
    $hosts = @("github.com", "registry.npmjs.org", "api.yourposseai.com")
    if (-not $SkipHostTools -and (Test-Cmd "winget")) { $hosts += "cdn.winget.microsoft.com" }
    $unreachable = @(Get-UnreachableHosts $hosts)
    if ($unreachable.Count -gt 0) {
      Write-Warn2 ("cannot reach {0}; steps that download from there will fail" -f ($unreachable -join ", "))
      $notes += ("cannot reach " + ($unreachable -join ", "))
    }
    try {
      $probe = [Uri]"https://github.com/"
      $systemProxy = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($probe)
      if ($systemProxy -and $systemProxy -ne $probe) { Write-Info ("downloads go through the proxy {0}" -f (Format-ProxyForLog $systemProxy.AbsoluteUri)) }
    }
    catch {}
    foreach ($name in @("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")) {
      $value = [Environment]::GetEnvironmentVariable($name)
      if ($value) { Write-Info ("{0} is set: {1}" -f $name, (Format-ProxyForLog $value)); break }
    }
  }
  Test-GitConfig
  if (-not $SetupOnly) { Test-ProviderCredentials }
  if ($notes.Count -gt 0) { Step-End "partial" ($notes -join "; ") }
  else { Step-End "ok" "preflight complete" }
  return $true
}

# =============================================================================
# uninstall (driven by the Windows setup package's uninstaller)
# =============================================================================

$script:AutomationTaskName = "Posse Automation Owner"
$script:KeepSharedWiring = $false

function Test-PathUnder {
  param([string]$PathValue, [string]$Root)
  if ([string]::IsNullOrWhiteSpace($PathValue) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $full = (Resolve-FullPath $PathValue).TrimEnd("\")
  $base = (Resolve-FullPath $Root).TrimEnd("\")
  return ($full -ieq $base) -or $full.StartsWith($base + "\", [StringComparison]::OrdinalIgnoreCase)
}

# posse.cmd (Step-ShellWiring) ends with: "<node>" "<orchestrator.js>" %*
function Read-PosseShim {
  param([string]$ShimPath)
  if (-not (Test-Path -LiteralPath $ShimPath)) { return $null }
  foreach ($line in Get-Content -LiteralPath $ShimPath -ErrorAction SilentlyContinue) {
    $match = [regex]::Match([string]$line, '^"([^"]+)" "([^"]+)" %\*$')
    if ($match.Success) {
      return [PSCustomObject]@{ Node = $match.Groups[1].Value.Replace("%%", "%"); Orchestrator = $match.Groups[2].Value.Replace("%%", "%") }
    }
  }
  return $null
}

function Get-AutomationTask {
  return Get-ScheduledTask -TaskName $script:AutomationTaskName -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Step-UninstallService {
  Step-Begin "service"
  $task = Get-AutomationTask
  if (-not $task) { Step-End "ok" "no automation owner task registered"; return }
  # One task name serves every Posse install for this user; leave a task that
  # runs another live checkout alone.
  $entry = [string](@($task.Actions | ForEach-Object { $_.Arguments }) | Select-Object -First 1)
  $entry = $entry.Trim().Trim('"')
  $ours = (-not $entry) -or (Test-PathUnder $entry $script:PosseDirResolved) -or -not (Test-Path -LiteralPath $entry)
  if (-not $ours) {
    $script:KeepSharedWiring = $true
    Step-End "skipped" ("the automation task runs another Posse install ({0})" -f $entry)
    return
  }
  if ($DryRun) { Step-End "dry-run" "would stop and remove the automation owner task"; return }
  $shim = Read-PosseShim (Join-Path $env:USERPROFILE ".local\bin\posse.cmd")
  $node = if ($shim -and (Test-Path -LiteralPath $shim.Node)) { $shim.Node } else { (Get-Command node -ErrorAction SilentlyContinue).Source }
  if ($node -and (Test-Path -LiteralPath (Join-Path $script:PosseDirResolved "orchestrator.js"))) {
    $rc = Invoke-Logged -Description "stop and remove the automation owner" -WorkingDirectory $script:PosseDirResolved -Command @($node, "orchestrator.js", "automation", "service", "remove")
    if ($rc -eq 0) { Step-End "ok" "automation owner stopped and removed"; return }
  }
  # Fallback when the checkout or Node is unusable: stop the task, then delete it.
  try {
    $task | Stop-ScheduledTask -ErrorAction SilentlyContinue
    $task | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop
    Step-End "ok" "automation owner task stopped and deleted"
  }
  catch {
    Step-End "failed" ("could not delete the '{0}' scheduled task; remove it in Task Scheduler" -f $script:AutomationTaskName)
  }
}

function Step-UninstallCommand {
  Step-Begin "command"
  $binDir = Join-Path $env:USERPROFILE ".local\bin"
  $cmdShim = Join-Path $binDir "posse.cmd"
  $notes = @()
  $shim = Read-PosseShim $cmdShim
  if (Test-Path -LiteralPath $cmdShim) {
    if ($shim -and -not (Test-PathUnder $shim.Orchestrator $script:PosseDirResolved) -and (Test-Path -LiteralPath $shim.Orchestrator)) {
      $script:KeepSharedWiring = $true
      $notes += ("kept the posse command; it runs another install ({0})" -f $shim.Orchestrator)
    }
    elseif ($DryRun) { $notes += "would remove posse.cmd" }
    else {
      Remove-Item -LiteralPath $cmdShim -Force
      $notes += "removed posse.cmd"
    }
  }
  $psShim = Join-Path $binDir "posse.ps1"
  if ((Test-Path -LiteralPath $psShim) -and -not $DryRun -and -not $script:KeepSharedWiring) { Remove-Item -LiteralPath $psShim -Force }

  # ~\.local\bin is shared with other tools: drop it from PATH only once empty.
  if (-not $script:KeepSharedWiring -and (Test-Path -LiteralPath $binDir) -and -not (Get-ChildItem -LiteralPath $binDir -Force | Select-Object -First 1)) {
    if ($DryRun) { $notes += "would remove the empty ~\.local\bin PATH entry" }
    else {
      Remove-Item -LiteralPath $binDir -Force -ErrorAction SilentlyContinue
      $userPath = Get-UserPathRaw
      $newUserPath = @($userPath -split ";" | Where-Object { $_ -and ((Expand-PathEntry $_).TrimEnd("\") -ine $binDir) }) -join ";"
      if ($newUserPath -ine $userPath) {
        Set-UserPathRaw $newUserPath
        Send-EnvironmentChangeBroadcast
        $notes += "removed ~\.local\bin from PATH"
      }
    }
  }
  if (-not $script:KeepSharedWiring -and (Test-Path -LiteralPath $script:EnvFile) -and -not $DryRun) {
    Remove-Item -LiteralPath $script:EnvFile -Force
  }
  if ($notes.Count -eq 0) { $notes += "no posse command found" }
  Step-End "ok" ($notes -join "; ")
}

# Older installers could also persist keys in the user environment.
function Clear-LegacyUserEnvironmentKeys {
  foreach ($name in $script:ProviderKeyNames) {
    if ([Environment]::GetEnvironmentVariable($name, "User")) { [Environment]::SetEnvironmentVariable($name, $null, "User") }
  }
}

function Step-UninstallData {
  Step-Begin "data"
  if (-not $RemoveUserData) { Step-End "skipped" "kept settings, saved keys, and runtimes (-RemoveUserData deletes them)"; return }
  if ($script:KeepSharedWiring) { Step-End "skipped" "another Posse install still uses your settings and keys"; return }
  $dirs = @((Join-Path $env:USERPROFILE ".config\posse"), (Join-Path $env:USERPROFILE ".posse"), $script:ManagedStateRoot)
  if ($DryRun) { Step-End "dry-run" ("would delete " + ($dirs -join ", ")); return }
  $left = @()
  foreach ($dir in $dirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop }
    catch {
      Write-LogOnly ("[data] {0}: {1}" -f $dir, $_.Exception.Message)
      $left += $dir
    }
  }
  Clear-LegacyUserEnvironmentKeys
  if ($left.Count -gt 0) { Step-End "failed" ("could not fully delete (close running Posse processes, then delete): " + ($left -join ", ")) }
  else { Step-End "ok" "deleted settings, saved keys, logs, and runtimes" }
}

function Test-ProfileTargetRemoved {
  param([string]$Target)
  if (-not $DryRun) { return -not (Test-Path -LiteralPath $Target) }
  # Dry run: predict what the command and data steps would have deleted.
  if ($script:KeepSharedWiring) { return $false }
  return $RemoveUserData -or ($Target -ieq $script:EnvFile)
}

# Drop profile lines that dot-source a Posse config file that no longer exists,
# so a new PowerShell window cannot fail on a removed file.
function Step-UninstallProfile {
  Step-Begin "profile"
  $configDir = Join-Path $env:USERPROFILE ".config\posse"
  $documents = [Environment]::GetFolderPath("MyDocuments")
  $profiles = @(
    (Join-Path $documents "WindowsPowerShell\Microsoft.PowerShell_profile.ps1"),
    (Join-Path $documents "PowerShell\Microsoft.PowerShell_profile.ps1"),
    $PROFILE
  ) | Where-Object { $_ } | Select-Object -Unique
  $edited = @()
  foreach ($profilePath in $profiles) {
    if (-not (Test-Path -LiteralPath $profilePath)) { continue }
    $kept = New-Object System.Collections.Generic.List[string]
    $changed = $false
    foreach ($line in @(Get-Content -LiteralPath $profilePath -ErrorAction Stop)) {
      $match = [regex]::Match([string]$line, "^\s*\.\s+'((?:[^']|'')+)'\s*$")
      if ($match.Success) {
        $target = $match.Groups[1].Value.Replace("''", "'")
        $gone = (Test-PathUnder $target $configDir) -and (Test-ProfileTargetRemoved $target)
        if ($gone) {
          if ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq "# Posse ATLAS integration") { $kept.RemoveAt($kept.Count - 1) }
          $changed = $true
          continue
        }
      }
      $kept.Add([string]$line)
    }
    if ($changed) {
      if (-not $DryRun) { Set-Content -LiteralPath $profilePath -Value $kept -Encoding UTF8 }
      $edited += $profilePath
    }
  }
  if ($edited.Count -eq 0) { Step-End "ok" "no Posse profile lines to remove" }
  elseif ($DryRun) { Step-End "dry-run" ("would edit " + ($edited -join ", ")) }
  else { Step-End "ok" ("removed Posse lines from " + ($edited -join ", ")) }
}

function Invoke-Uninstall {
  $script:StepKeys = @("service", "command", "data", "profile")
  $script:StepTitles = @{
    service = "Automation owner task"
    command = "posse command and PATH"
    data    = "Settings, keys, and runtimes"
    profile = "PowerShell profile"
  }
  foreach ($k in $script:StepKeys) { $script:StepStatus[$k] = "pending"; $script:StepNote[$k] = "" }
  $root = if ($PosseDir) { Resolve-FullPath $PosseDir } else { Get-InstallerPosseDir }
  if (-not $root) { throw "-Uninstall needs -PosseDir (the checkout being removed)" }
  # The checkout may already be partly gone; wiring that points into it still goes.
  $resolved = Resolve-PosseRootFromCheckout $root
  $script:PosseDirResolved = if ($resolved) { $resolved } else { $root }
  Write-Info ("removing Posse wiring for {0}" -f $script:PosseDirResolved)
  Invoke-InstallerStep "service" { Step-UninstallService }
  Invoke-InstallerStep "command" { Step-UninstallCommand }
  Invoke-InstallerStep "data" { Step-UninstallData }
  Invoke-InstallerStep "profile" { Step-UninstallProfile }
}

# =============================================================================
# main
# =============================================================================

$script:NodeBin = ""
$script:NpmCli = ""
$script:NativeDownload = $null
$script:EnvFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") "atlas.env.ps1"
$script:PosseDirResolved = $PosseDir

if ($Uninstall) {
  try {
    Initialize-Ui
    Write-LogOnly ("posse uninstall started {0}" -f (Get-Date -Format "o"))
    Write-Host ("  {0}Log: {1}{2}" -f $script:DIM, $script:LogFile, $script:R)
    Invoke-Uninstall
  }
  catch {
    $script:InstallFailed = $true
    Write-LogOnly ("[fatal] " + $_.Exception.ToString())
    Write-Warn2 ("uninstall failed: " + $_.Exception.Message)
    Block-PendingSteps "uninstall aborted after an unexpected error"
  }
  finally {
    Print-Summary
  }
  if ($script:InstallFailed) { exit 1 }
  exit 0
}

try {
  Initialize-Ui
  Write-Splash

  Write-LogOnly ("install-posse-atlas started {0}" -f (Get-Date -Format "o"))
  Write-SetupProgress @("log", $script:LogFile)
  Write-LogOnly ("dry_run={0} force={1} host_tools={2} media_tools={3} install_node={4}" -f $DryRun, $Force, (-not $SkipHostTools), [bool]$WithMediaTools, (-not $NoInstallNode))

  if ($DryRun) {
    Write-Host ("  {0}{1}DRY RUN{2} {3}- no changes will be made{2}" -f $script:BOLD, $script:YELLOW, $script:R, $script:DIM)
  }
  Write-Host ("  {0}Log: {1}{2}" -f $script:DIM, $script:LogFile, $script:R)

  Invoke-InstallerStep "languages" {
    if (-not (Step-ScipLanguages)) { Block-PendingSteps "language selection failed" }
  } -Critical

  if (-not $script:CriticalFailed) {
    Invoke-InstallerStep "preflight" {
      if (-not (Step-Preflight)) { Block-PendingSteps "preflight failed" }
    } -Critical
  }

  if (-not $script:CriticalFailed) {
    Invoke-InstallerStep "node" { Step-Node } -Critical
    Invoke-InstallerStep "checkout" { Step-Checkout } -Critical
    if ($SetupOnly) {
      Step-Begin "keys"
      Step-End "skipped" "-SetupOnly; complete setup at runtime"
    }
    else {
      Invoke-InstallerStep "keys" { Step-Keys }
    }
    Invoke-InstallerStep "npm" { Step-Npm } -Critical
    if (-not $SetupOnly) { Start-NativeDownload }
    Invoke-InstallerStep "packages" { Step-Packages }
    Invoke-InstallerStep "composer" { Step-Composer }
    Invoke-InstallerStep "automation" { Step-Automation }
    Invoke-InstallerStep "shell" { Step-ShellWiring } -Critical
    if ($SetupOnly) {
      foreach ($key in @("seed", "admin", "native", "doctor", "validate", "smoke")) {
        Step-Begin $key
        Step-End "skipped" "-SetupOnly; complete setup at runtime"
      }
    }
    else {
      Invoke-InstallerStep "seed" { Step-SeedSettings }
      Invoke-InstallerStep "admin" { Step-AdminInit }
      Invoke-InstallerStep "native" { Step-NativeBinaries }
      Invoke-InstallerStep "doctor" { Step-Doctor }
      Invoke-InstallerStep "validate" { Step-Validate }
      Invoke-InstallerStep "smoke" { Step-Smoke }
    }
  }
}
catch {
  $script:InstallFailed = $true
  $script:CriticalFailed = $true
  Write-LogOnly ("[fatal] " + $_.Exception.ToString())
  Write-Warn2 ("installer failed: " + $_.Exception.Message)
  Block-PendingSteps "installer aborted after an unexpected error"
}
finally {
  # Setup that ended early must not leave a download running behind it.
  [void](Receive-NativeDownload -Abandon)
  Print-Summary
}

if ($script:InstallFailed) { exit 1 }
exit 0
