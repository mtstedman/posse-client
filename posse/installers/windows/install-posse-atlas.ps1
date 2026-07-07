<#
.SYNOPSIS
  Posse + ATLAS Windows installer.

.DESCRIPTION
  Bootstraps a Windows host: helper CLI tools (via winget), Node.js 24+ (via
  winget when missing), the Posse checkout, npm deps, Python venv + SCIP
  language environments (delegated to `posse doctor` — the same engine Posse
  uses at boot), account settings, and PATH/profile wiring.

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
  Posse checkout directory. Default: installer checkout when available, else <InstallRoot>\posse

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
  is shown. Default: typescript,python,php.

.PARAMETER NoSmoke
  Skip the smoke test.

.PARAMETER NoPersistEnv
  Don't write PATH/profile wiring.

.PARAMETER SkipSettings
  Don't seed ~/.posse/account.db.

.PARAMETER SkipHostTools
  Don't install helper CLI tools (rg, tesseract, ImageMagick, ffmpeg, Python,
  PHP). Missing tools are still reported.

.PARAMETER NoInstallNode
  Don't auto-install Node via winget when Node 24+ is missing.

.PARAMETER ConfigureKeys
  Interactively prompt for provider API keys (stored in providers.env.ps1 with
  a user-only ACL).

.PARAMETER Force
  Re-run npm install even when node_modules looks fresh.

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
  [string]$PosseRepoUrl = "https://github.com/mtstedman/posse.git",
  [string]$RepoId = "",
  [string]$RepoPath = "",
  [string]$SmokeQuery = "auth",
  [string]$SmokeProvider = "openai",
  [string]$ScipLanguages = "",
  [switch]$NoSmoke,
  [switch]$NoPersistEnv,
  [switch]$SkipSettings,
  [switch]$SkipHostTools,
  [switch]$NoInstallNode,
  [switch]$ConfigureKeys,
  [switch]$Force,
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
$PosseScipLanguages = if ($ScipLanguagesSupplied) { $ScipLanguages } else { "typescript,python,php" }
$NodeMinMajor       = 24

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
$script:LogDir = Join-Path $env:USERPROFILE ".posse\logs"
try { New-Item -ItemType Directory -Force -Path $script:LogDir | Out-Null }
catch { $script:LogDir = $env:TEMP }
$script:LogFile = Join-Path $script:LogDir ("install-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
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
$script:ScipLanguageStepNote = ""

function Get-ScipLanguagesAllowedText {
  return (($script:ScipLanguageOptions | ForEach-Object { $_.Value }) -join ", ") + ", all"
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

  $inputRedirected = $false
  try { $inputRedirected = [Console]::IsInputRedirected } catch { $inputRedirected = $false }
  if ($inputRedirected) {
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
$script:StepKeys = @("languages", "preflight", "packages", "node", "checkout", "composer", "npm", "shell", "seed", "doctor", "admin", "validate", "keys", "smoke")
$script:StepTitles = @{
  languages = "SCIP language selection"
  preflight = "Preflight checks"
  packages = "System packages"
  node     = "Node.js runtime"
  checkout = "Posse checkout"
  composer = "Composer (SCIP PHP)"
  npm      = "npm dependencies"
  shell    = "Shell wiring"
  seed     = "Account settings"
  doctor   = "Runtime doctor (Python + SCIP)"
  admin    = "Provider CLI detection"
  validate = "Validation"
  keys     = "Provider API keys"
  smoke    = "ATLAS smoke test"
}
$script:StepStatus = @{}
$script:StepNote = @{}
foreach ($k in $script:StepKeys) { $script:StepStatus[$k] = "pending"; $script:StepNote[$k] = "" }
$script:StepIndex = 0
$script:CurrentStep = ""
$script:CriticalFailed = $false
$script:SummaryPrinted = $false

function Step-Begin {
  param([string]$Key)
  $script:CurrentStep = $Key
  $script:StepIndex++
  Write-Host ""
  Write-Host ("{0}[{1,2}/{2}]{3} {4}{5}{6}" -f $script:DIM, $script:StepIndex, $script:StepKeys.Count, $script:R, $script:BOLD, $script:StepTitles[$Key], $script:R)
  Write-LogOnly ""
  Write-LogOnly ("===== [{0}/{1}] {2} =====" -f $script:StepIndex, $script:StepKeys.Count, $script:StepTitles[$Key])
}

function Step-End {
  param([string]$Status, [string]$Note = "")
  $script:StepStatus[$script:CurrentStep] = $Status
  $script:StepNote[$script:CurrentStep] = $Note
  Write-LogOnly ("----- {0}: {1}{2}" -f $script:CurrentStep, $Status, $(if ($Note) { " ($Note)" } else { "" }))
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

function Block-PendingSteps {
  param([string]$Note = "blocked by an earlier failure")
  foreach ($key in $script:StepKeys) {
    if ($script:StepStatus[$key] -eq "pending") {
      $script:StepStatus[$key] = "blocked"
      $script:StepNote[$key] = $Note
    }
  }
}

function Quote-Arg {
  param([string]$Value)
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  if ($Value -eq "") { return '""' }
  return $Value
}

function Format-CommandLine {
  param([string[]]$Parts)
  return (($Parts | ForEach-Object { Quote-Arg $_ }) -join " ")
}

# Runs a native command line via cmd.exe with output appended to the log file.
# Never throws on native stderr (the PS 5.1 NativeCommandError trap); shows a
# spinner with elapsed time on capable terminals; prints the output tail on
# failure. Returns the exit code.
function Invoke-Logged {
  param(
    [string]$Description,
    [string[]]$Command,
    [string]$WorkingDirectory = ""
  )
  $cmdLine = Format-CommandLine $Command
  Write-LogOnly ""
  Write-LogOnly (">>> {0}" -f $Description)
  Write-LogOnly (">>> `$ {0}" -f $cmdLine)
  if ($DryRun) {
    Write-Host ("    {0}{1} (dry-run) would run:{2} {3}" -f $script:DIM, $script:GlyphDot, $script:R, $Description)
    return 0
  }

  $chunk = [System.IO.Path]::GetTempFileName()
  $started = Get-Date

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  $psi.Arguments = '/d /s /c "' + $cmdLine + ' >> "' + $chunk + '" 2>&1"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }
  $proc = [System.Diagnostics.Process]::Start($psi)

  if ($script:UiSpinner) {
    $i = 0
    $n = $script:SpinnerFrames.Count
    while (-not $proc.HasExited) {
      $elapsed = [int]((Get-Date) - $started).TotalSeconds
      Write-Host ("`r$Esc[2K    {0}{1}{2} {3} {4}({5}){6}" -f $script:CYAN, $script:SpinnerFrames[$i % $n], $script:R, $Description, $script:DIM, (Format-Duration $elapsed), $script:R) -NoNewline
      $i++
      Start-Sleep -Milliseconds 120
    }
    Write-Host "`r$Esc[2K" -NoNewline
  }
  else {
    Write-Host ("    {0}{1}{2} {3}" -f $script:DIM, $script:GlyphDot, $script:R, $Description)
    $proc.WaitForExit()
  }

  $proc.WaitForExit()
  $rc = $proc.ExitCode
  $elapsedTotal = [int]((Get-Date) - $started).TotalSeconds

  $chunkContent = ""
  try { $chunkContent = Get-Content -Path $chunk -Raw -ErrorAction SilentlyContinue } catch {}
  if ($chunkContent) { Write-LogOnly $chunkContent.TrimEnd() }

  if ($rc -eq 0) {
    Write-Host ("    {0}{1}{2} {3} {4}({5}){6}" -f $script:GREEN, $script:GlyphOk, $script:R, $Description, $script:DIM, (Format-Duration $elapsedTotal), $script:R)
  }
  else {
    Write-Host ("    {0}{1}{2} {3} {4}(exit {5} after {6}){7}" -f $script:RED, $script:GlyphFail, $script:R, $Description, $script:DIM, $rc, (Format-Duration $elapsedTotal), $script:R)
    if ($chunkContent) {
      Write-Host ("    {0}| last output:{1}" -f $script:DIM, $script:R)
      ($chunkContent -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 10) | ForEach-Object { Write-Host ("      " + $_) }
      Write-Host ("    {0}| full log: {1}{2}" -f $script:DIM, $script:LogFile, $script:R)
    }
  }
  Remove-Item $chunk -Force -ErrorAction SilentlyContinue
  return $rc
}

# --- summary ----------------------------------------------------------------------
function Print-Summary {
  if ($script:SummaryPrinted) { return }
  $script:SummaryPrinted = $true
  Write-Host ""
  Write-Host ("  {0}{1}{2}" -f $script:DIM, ("-" * 58), $script:R)
  Write-Host ("  {0}Install summary{1}" -f $script:BOLD, $script:R)
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
  Write-Host ("  {0}Log:{1} {2}" -f $script:DIM, $script:R, $script:LogFile)
  Write-Host ""
  if ($script:CriticalFailed) {
    Write-Host ("  {0}{1}Install did not complete.{2} Fix the failed step above and re-run - completed steps are skipped on re-runs." -f $script:RED, $script:BOLD, $script:R)
  }
  else {
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

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  try {
    $v = (& $node.Source --version) 2>$null
    if ($v -match "^v(\d+)\.") { return [int]$Matches[1] }
  }
  catch {}
  return 0
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
  return ((Get-Item $pkg).LastWriteTime -le (Get-Item $lock).LastWriteTime)
}

function Test-ImageMagick {
  return (Test-Cmd "magick") -or (Test-Cmd "convert")
}

# =============================================================================
# steps
# =============================================================================

function Step-Packages {
  Step-Begin "packages"

  $tools = @(
    [PSCustomObject]@{ Label = "ripgrep";       Test = { Test-Cmd "rg" };        WingetIds = @("BurntSushi.ripgrep.MSVC"); Reason = "deterministic search" },
    [PSCustomObject]@{ Label = "Tesseract OCR"; Test = { Test-Cmd "tesseract" }; WingetIds = @("UB-Mannheim.TesseractOCR"); Reason = "image OCR extraction" },
    [PSCustomObject]@{ Label = "ImageMagick";   Test = { Test-ImageMagick };     WingetIds = @("ImageMagick.ImageMagick", "ImageMagick.Q16-HDRI", "ImageMagick.Q16"); Reason = "image conversion" },
    [PSCustomObject]@{ Label = "FFmpeg";        Test = { Test-Cmd "ffmpeg" };    WingetIds = @("Gyan.FFmpeg"); Reason = "media conversion" },
    [PSCustomObject]@{ Label = "Python 3";      Test = { $null -ne (Get-PythonRunner) }; WingetIds = @("Python.Python.3.13", "Python.Python.3.12"); Reason = "Python helpers + managed venvs" },
    [PSCustomObject]@{ Label = "PHP";           Test = { Test-Cmd "php" };       WingetIds = @("PHP.PHP.8.4", "PHP.PHP.8.3"); Reason = "php -l + SCIP PHP indexing" }
  )

  $missing = @($tools | Where-Object { -not (& $_.Test) })
  if ($missing.Count -eq 0) {
    Step-End "ok" "all helper CLIs present (rg, tesseract, ImageMagick, ffmpeg, python, php)"
    return
  }

  foreach ($tool in $missing) { Write-Info ("missing: {0} ({1})" -f $tool.Label, $tool.Reason) }

  if ($SkipHostTools) {
    Step-End "skipped" ("-SkipHostTools; missing: " + (($missing | ForEach-Object { $_.Label }) -join ", "))
    return
  }
  if (-not (Test-Cmd "winget")) {
    Write-Warn2 "winget is not available; install the missing tools manually (App Installer from the Microsoft Store provides winget)"
    Step-End "partial" "winget unavailable; tools not installed"
    return
  }
  if ($DryRun) {
    foreach ($tool in $missing) {
      Write-Host ("    {0}{1} (dry-run) would winget install {2}{3}" -f $script:DIM, $script:GlyphDot, ($tool.WingetIds[0]), $script:R)
    }
    Step-End "dry-run" "would install missing tools via winget"
    return
  }

  $failed = @()
  foreach ($tool in $missing) {
    $installed = $false
    foreach ($id in $tool.WingetIds) {
      $rc = Invoke-Logged -Description ("install {0} ({1})" -f $tool.Label, $id) -Command @(
        "winget", "install", "--id", $id, "--exact", "--source", "winget", "--silent",
        "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
      )
      if ($rc -eq 0) { $installed = $true; break }
    }
    if (-not $installed) { $failed += $tool.Label }
  }

  Update-SessionPath

  # Tesseract's installer does not reliably add itself to PATH.
  if (-not (Test-Cmd "tesseract")) {
    foreach ($dir in @("$env:ProgramFiles\Tesseract-OCR", "${env:ProgramFiles(x86)}\Tesseract-OCR", "$env:LOCALAPPDATA\Programs\Tesseract-OCR")) {
      if ($dir -and (Test-Path (Join-Path $dir "tesseract.exe"))) {
        $env:Path = "$dir;$env:Path"
        if (-not $NoPersistEnv) {
          $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
          if (-not (($userPath -split ";") -contains $dir)) {
            [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $dir), "User")
          }
        }
        Write-Info "added Tesseract to PATH: $dir"
        break
      }
    }
  }

  $stillMissing = @($tools | Where-Object { -not (& $_.Test) } | ForEach-Object { $_.Label })
  if ($failed.Count -eq 0 -and $stillMissing.Count -eq 0) {
    Step-End "ok" "helper CLIs installed"
  }
  elseif ($stillMissing.Count -gt 0 -and $failed.Count -eq 0) {
    Write-Warn2 ("installed, but not visible on PATH yet (a new terminal may be needed): " + ($stillMissing -join ", "))
    Step-End "partial" ("PATH not refreshed for: " + ($stillMissing -join ", "))
  }
  else {
    Write-Warn2 ("could not install: " + ($failed -join ", ") + " (Posse degrades gracefully; related helpers stay disabled)")
    Step-End "partial" ("installed with gaps: " + ($failed -join ", "))
  }
}

function Step-Node {
  Step-Begin "node"
  $major = Get-NodeMajor
  if ($major -ge $NodeMinMajor) {
    $script:NodeBin = (Get-Command node).Source
    Step-End "ok" ("node v{0}.x at {1}" -f $major, $script:NodeBin)
    return
  }
  if ($major -gt 0) { Write-Info ("found node v{0}.x, but {1}+ is required" -f $major, $NodeMinMajor) }
  else { Write-Info "node is not installed" }

  if ($NoInstallNode) {
    Step-FailCritical "Node $NodeMinMajor+ required (-NoInstallNode was passed). Install it and re-run."
    return
  }
  if (-not (Test-Cmd "winget")) {
    Step-FailCritical "Node $NodeMinMajor+ required and winget is unavailable to install it. Install Node from https://nodejs.org and re-run."
    return
  }
  if ($DryRun) {
    Step-End "dry-run" "would install Node via winget (OpenJS.NodeJS.LTS)"
    return
  }

  $installed = $false
  foreach ($id in @("OpenJS.NodeJS.LTS", "OpenJS.NodeJS")) {
    $rc = Invoke-Logged -Description ("install Node.js ({0})" -f $id) -Command @(
      "winget", "install", "--id", $id, "--exact", "--source", "winget", "--silent",
      "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity"
    )
    if ($rc -eq 0) { $installed = $true; break }
  }
  if (-not $installed) {
    Step-FailCritical "Node install via winget failed; install Node $NodeMinMajor+ from https://nodejs.org and re-run"
    return
  }

  Update-SessionPath
  $major = Get-NodeMajor
  if ($major -ge $NodeMinMajor) {
    $script:NodeBin = (Get-Command node).Source
    Step-End "ok" ("node v{0}.x installed at {1}" -f $major, $script:NodeBin)
  }
  else {
    Step-FailCritical "node still not usable in this session after install (found major: $major); open a new terminal and re-run"
  }
}

function Step-Checkout {
  Step-Begin "checkout"
  if ($script:CriticalFailed) { Step-End "blocked"; return }

  if (-not $script:PosseDirResolved) {
    $detected = Get-InstallerPosseDir
    if ($detected) {
      $script:PosseDirResolved = $detected
      Write-Info "using the Posse checkout containing this installer"
    }
    else {
      $script:PosseDirResolved = Join-Path $InstallRoot "posse"
    }
  }
  $script:PosseDirResolved = Resolve-FullPath $script:PosseDirResolved

  if (Test-Path $script:PosseDirResolved) {
    if (Test-Path (Join-Path $script:PosseDirResolved "orchestrator.js")) {
      Step-End "ok" ("existing checkout: {0}" -f $script:PosseDirResolved)
    }
    else {
      Step-FailCritical ("{0} exists but has no orchestrator.js (not a Posse repo root?)" -f $script:PosseDirResolved)
    }
    return
  }

  if (-not (Test-Cmd "git")) {
    Step-FailCritical "git is required to clone Posse but is not installed (winget install Git.Git)"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" ("would clone {0} into {1}" -f $PosseRepoUrl, $script:PosseDirResolved)
    return
  }
  $parent = Split-Path $script:PosseDirResolved -Parent
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $rc = Invoke-Logged -Description ("clone {0}" -f $PosseRepoUrl) -Command @("git", "clone", $PosseRepoUrl, $script:PosseDirResolved)
  if ($rc -eq 0 -and (Test-Path (Join-Path $script:PosseDirResolved "orchestrator.js"))) {
    Step-End "ok" ("cloned into {0}" -f $script:PosseDirResolved)
  }
  else {
    Step-FailCritical "git clone failed (or orchestrator.js missing after clone); see log"
  }
}

function Step-Composer {
  Step-Begin "composer"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  $pharPath = Join-Path $script:PosseDirResolved "scip\bin\composer.phar"
  if (Test-Cmd "composer") { Step-End "ok" "composer on PATH"; return }
  if (Test-Path $pharPath) { Step-End "ok" "composer.phar already present in scip\bin"; return }
  $php = Get-Command php -ErrorAction SilentlyContinue
  if (-not $php) {
    Write-Warn2 "PHP is not installed, so Composer was skipped - SCIP PHP indexing stays disabled until both exist"
    Step-End "skipped" "php not available"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" "would download signature-verified composer.phar into scip\bin"
    return
  }

  $binDir = Split-Path $pharPath -Parent
  $setupPath = Join-Path ([System.IO.Path]::GetTempPath()) ("composer-setup-" + [Guid]::NewGuid().ToString("N") + ".php")
  try {
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
    Write-Info "downloading Composer installer (signature-verified)"
    $expected = (Invoke-RestMethod -Uri "https://composer.github.io/installer.sig").Trim()
    Invoke-WebRequest -Uri "https://getcomposer.org/installer" -OutFile $setupPath -UseBasicParsing
    $env:POSSE_COMPOSER_SETUP = $setupPath
    $actual = ""
    try { $actual = (& $php.Source -r 'echo hash_file("sha384", getenv("POSSE_COMPOSER_SETUP"));') } catch {}
    if ([string]::IsNullOrWhiteSpace($actual) -or ($actual.Trim().ToLowerInvariant() -ne $expected.ToLowerInvariant())) {
      Write-Warn2 "Composer installer signature verification failed"
      Step-End "partial" "composer unavailable (signature mismatch)"
      return
    }
    $rc = Invoke-Logged -Description "run Composer installer" -Command @($php.Source, $setupPath, "--install-dir=$binDir", "--filename=composer.phar", "--quiet")
    if ($rc -eq 0 -and (Test-Path $pharPath)) {
      Step-End "ok" "composer.phar installed into scip\bin"
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
    Remove-Item Env:\POSSE_COMPOSER_SETUP -ErrorAction SilentlyContinue
  }
}

function Step-Npm {
  Step-Begin "npm"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if (-not $Force -and (Test-DepsFresh $script:PosseDirResolved)) {
    Step-End "skipped" "node_modules is fresh (pass -Force to reinstall)"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" ("would run npm install --include=optional in {0}" -f $script:PosseDirResolved)
    return
  }
  $npmArgs = @("npm", "install", "--include=optional", "--no-fund", "--no-audit")
  $rc = Invoke-Logged -Description "npm install (includes native module builds)" -Command $npmArgs -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "npm dependencies installed"; return }

  Write-Info "retrying once (transient network/registry failures are common)"
  $rc = Invoke-Logged -Description "npm install (retry)" -Command $npmArgs -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "npm dependencies installed on retry"; return }

  Step-FailCritical "npm install failed twice - if the log shows node-gyp/MSBuild errors, install 'Visual Studio Build Tools' (C++ workload) and re-run"
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
    'if (($env:PATH -split '';'') -notcontains $env:POSSE_BIN_DIR) { $env:PATH = "$env:POSSE_BIN_DIR;$env:PATH" }'
  ) -join "`r`n"
  Set-Content -Path $script:EnvFile -Value $contents -Encoding UTF8

  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $cmdShim = Join-Path $binDir "posse.cmd"
  $psShim = Join-Path $binDir "posse.ps1"
  $orchestrator = Join-Path $script:PosseDirResolved "orchestrator.js"
  Set-Content -Path $cmdShim -Value ("@echo off`r`n""{0}"" ""{1}"" %*" -f $script:NodeBin, $orchestrator) -Encoding ASCII
  $psLines = @(
    ('$node = ' + "'" + ($script:NodeBin -replace "'", "''") + "'"),
    ('$entry = ' + "'" + ($orchestrator -replace "'", "''") + "'"),
    '& $node $entry @args',
    'exit $LASTEXITCODE'
  ) -join "`r`n"
  Set-Content -Path $psShim -Value $psLines -Encoding UTF8

  # Persist ~\.local\bin on the user PATH and pick it up in this session.
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @($userPath -split ";" | Where-Object { $_ })
  if (-not ($parts | Where-Object { $_ -ieq $binDir })) {
    $newUserPath = if ($userPath) { $userPath.TrimEnd(";") + ";" + $binDir } else { $binDir }
    if (-not $NoPersistEnv) { [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User") }
  }
  if (-not (($env:Path -split ";") | Where-Object { $_ -ieq $binDir })) { $env:Path = "$binDir;$env:Path" }

  if (-not $NoPersistEnv -and $PROFILE) {
    $profileDir = Split-Path $PROFILE -Parent
    if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    $existing = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($null -eq $existing -or -not $existing.Contains($script:EnvFile)) {
      Add-Content -Path $PROFILE -Value ("`n# Posse ATLAS integration`n. '" + ($script:EnvFile -replace "'", "''") + "'")
      Write-Info "updated $PROFILE"
    }
  }

  $note = "env file + posse shims installed"
  if (-not (Test-Cmd "posse")) { $note += " (open a new terminal to pick up PATH)" }
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
  atlas_mode: process.env.POSSE_SEED_MODE,
  atlas_phases: process.env.POSSE_SEED_PHASES,
  atlas_live_funnel: process.env.POSSE_SEED_FUNNEL,
  atlas_scip_mode: process.env.POSSE_SEED_SCIP_MODE,
  atlas_scip_languages: process.env.POSSE_SEED_SCIP_LANGUAGES,
};
let added = 0, kept = 0, skipped = 0;
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
    } else {
      kept++;
    }
  }
});
tx(Object.entries(seed));
db.close();
console.log(`[seed-settings] wrote ${settingsPath} -- added ${added}, kept ${kept} existing, skipped ${skipped} empty`);
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
  try {
    $rc = Invoke-Logged -Description "seed ~/.posse/account.db (merge-only, existing values kept)" -Command @($script:NodeBin, $seedFile) -WorkingDirectory $script:PosseDirResolved
    if ($rc -eq 0) { Step-End "ok" "account settings seeded" }
    else {
      Write-Warn2 "settings seed failed; run 'posse admin' to configure ATLAS settings manually"
      Step-End "failed" "seed script failed; see log"
    }
  }
  finally {
    Remove-Item $seedFile -Force -ErrorAction SilentlyContinue
    Remove-Item Env:\POSSE_SEED_MODE, Env:\POSSE_SEED_PHASES, Env:\POSSE_SEED_FUNNEL, Env:\POSSE_SEED_SCIP_MODE, Env:\POSSE_SEED_SCIP_LANGUAGES -ErrorAction SilentlyContinue
  }
}

function Step-Doctor {
  Step-Begin "doctor"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would run 'posse doctor' (Python venv + SCIP language environments)"
    return
  }
  Write-Info "delegating to Posse's own dependency engine (managed Python venv, SCIP indexer environments)"
  $rc = Invoke-Logged -Description "posse doctor (first run builds Python venv + SCIP envs; this can take a few minutes)" -Command @($script:NodeBin, "orchestrator.js", "doctor") -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "runtime dependencies ready" }
  else {
    Write-Warn2 "posse doctor reported unresolved dependencies - run 'posse doctor' after fixing the tools it names (log has details)"
    Step-End "partial" "some runtime dependencies unresolved"
  }
}

function Step-AdminInit {
  Step-Begin "admin"
  if ($script:CriticalFailed) { Step-End "blocked"; return }
  if ($DryRun) {
    Step-End "dry-run" "would run posse admin init --non-interactive"
    return
  }
  $rc = Invoke-Logged -Description "detect provider CLIs (admin init)" -Command @($script:NodeBin, "orchestrator.js", "admin", "init", "--non-interactive") -WorkingDirectory $script:PosseDirResolved
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
    Step-End "dry-run" "would run node orchestrator.js status"
    return
  }
  $rc = Invoke-Logged -Description "boot posse (orchestrator.js status)" -Command @($script:NodeBin, "orchestrator.js", "status") -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "posse boots cleanly" }
  else {
    Write-Warn2 ("posse failed to boot - run 'posse status' in {0} to see the error" -f $script:PosseDirResolved)
    Step-End "failed" "status returned non-zero; see log"
  }
}

# --- provider keys (interactive; no spinner) --------------------------------------
$script:ConfiguredKeys = @()

function Prompt-ForKey {
  param([string]$Label, [string]$VarName)
  $existing = [Environment]::GetEnvironmentVariable($VarName, "Process")
  if ($existing) {
    Write-Info "$VarName already set (length $($existing.Length)) - skipping"
    return $false
  }
  $secure = Read-Host -Prompt "      Enter $Label (press Enter to skip)" -AsSecureString
  if ($secure.Length -eq 0) { Write-Info "skipped $Label"; return $false }
  $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if (-not $plain) { Write-Info "skipped $Label"; return $false }
  [Environment]::SetEnvironmentVariable($VarName, $plain, "Process")
  $script:ConfiguredKeys += [PSCustomObject]@{ Name = $VarName; Value = $plain }
  return $true
}

function Step-Keys {
  Step-Begin "keys"
  $providersFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") "providers.env.ps1"
  if (-not $ConfigureKeys) {
    Step-End "skipped" "pass -ConfigureKeys to set provider API keys interactively"
    return
  }
  if ($DryRun) {
    Step-End "dry-run" "would prompt for POSSE_KEY / OPENAI_API_KEY / XAI_API_KEY / CODEX_API_KEY"
    return
  }

  if (Test-Path $providersFile) { . $providersFile }

  Write-Info "input is hidden; press Enter to skip any key"
  [void](Prompt-ForKey "Posse remote key" "POSSE_KEY")
  [void](Prompt-ForKey "OpenAI API key" "OPENAI_API_KEY")
  [void](Prompt-ForKey "xAI (Grok) key" "XAI_API_KEY")
  [void](Prompt-ForKey "Codex API key (optional - skip if you prefer 'codex login')" "CODEX_API_KEY")

  if (Test-Cmd "claude") {
    $ans = Read-Host "      Run 'claude' now to log in to Claude? [y/N]"
    if ($ans -match '^[Yy]$') {
      try { & claude } catch { Write-Warn2 "claude login command did not exit cleanly: $_" }
    }
  }
  if ((Test-Cmd "codex") -and -not $env:CODEX_API_KEY) {
    $ans = Read-Host "      Run 'codex login' now? [y/N]"
    if ($ans -match '^[Yy]$') {
      try { & codex login } catch { Write-Warn2 "codex login command did not exit cleanly: $_" }
    }
  }

  if ($script:ConfiguredKeys.Count -eq 0) {
    Step-End "ok" "no new keys captured"
    return
  }

  # Merge with existing file: keep $env: lines for vars we didn't touch.
  $capturedNames = @($script:ConfiguredKeys | ForEach-Object { $_.Name })
  $preserved = @()
  if (Test-Path $providersFile) {
    $preserved = Get-Content $providersFile | Where-Object {
      $line = $_
      $keep = $true
      foreach ($n in $capturedNames) {
        if ($line -match "^\s*\`$env:$([regex]::Escape($n))\s*=") { $keep = $false; break }
      }
      $keep -and $line -notmatch '^\s*#\s*Posse provider API keys'
    }
  }
  $lines = @("# Posse provider API keys -- generated by install-posse-atlas.ps1")
  $lines += $preserved | Where-Object { $_ }
  foreach ($k in $script:ConfiguredKeys) {
    $lines += ('$env:{0} = ''{1}''' -f $k.Name, ($k.Value -replace "'", "''"))
  }
  $dir = Split-Path $providersFile -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -Path $providersFile -Value ($lines -join "`r`n") -Encoding UTF8

  # Tighten ACL so only the current user (and admins/system) can read it.
  try {
    $acl = Get-Acl $providersFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, "FullControl", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -Path $providersFile -AclObject $acl
  }
  catch {
    Write-Warn2 "could not tighten ACL on $providersFile - file keeps default NTFS permissions. $_"
  }

  if (-not $NoPersistEnv -and $PROFILE) {
    $profileContent = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
    if ($null -eq $profileContent -or -not $profileContent.Contains($providersFile)) {
      Add-Content -Path $PROFILE -Value ("`n# Posse provider keys`n. '" + ($providersFile -replace "'", "''") + "'")
      Write-Info "updated $PROFILE"
    }
  }
  Step-End "ok" ("wrote {0} key(s) to {1} (user-only ACL)" -f $script:ConfiguredKeys.Count, $providersFile)
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
  $rc = Invoke-Logged -Description ("atlas-smoke {0} (query: {1})" -f $repoLabel, $SmokeQuery) -Command @($script:NodeBin, "orchestrator.js", "atlas-smoke", $RepoPath, $SmokeQuery, $SmokeProvider) -WorkingDirectory $script:PosseDirResolved
  if ($rc -eq 0) { Step-End "ok" "smoke test passed" }
  else {
    Write-Warn2 ("atlas-smoke failed - run it manually: node orchestrator.js atlas-smoke {0} {1} {2}" -f $RepoPath, $SmokeQuery, $SmokeProvider)
    Step-End "failed" "smoke test failed; see log"
  }
}

# --- soft preflight checks (warnings only) ------------------------------------------
function Test-ProviderCredentials {
  $found = @()
  if (Test-Cmd "claude") { $found += "claude-cli" }
  if ($env:OPENAI_API_KEY) { $found += "OPENAI_API_KEY" }
  if ($env:XAI_API_KEY) { $found += "XAI_API_KEY" }
  $codexAuth = Join-Path $env:USERPROFILE ".codex\auth.json"
  if ($env:CODEX_API_KEY -or (Test-Path $codexAuth)) { $found += "codex" }
  if ($found.Count -eq 0) {
    if ($ConfigureKeys) { Write-Info "no provider credentials detected yet - the keys step below will prompt for them" }
    else { Write-Warn2 "no provider credentials detected (claude CLI / OPENAI_API_KEY / XAI_API_KEY / codex). Re-run with -ConfigureKeys, or set one before dispatching jobs." }
  }
  else {
    Write-Info ("provider credentials detected: " + ($found -join ", "))
  }
  if (-not $env:POSSE_KEY -and -not $ConfigureKeys) {
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

function Step-Preflight {
  Step-Begin "preflight"
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
  Test-GitConfig
  Test-ProviderCredentials
  Step-End "ok" "preflight complete"
  return $true
}

# =============================================================================
# main
# =============================================================================

$script:NodeBin = ""
$script:EnvFile = Join-Path (Join-Path $env:USERPROFILE ".config\posse") "atlas.env.ps1"
$script:PosseDirResolved = $PosseDir

try {
  Initialize-Ui
  Write-Splash

  Write-LogOnly ("install-posse-atlas started {0}" -f (Get-Date -Format "o"))
  Write-LogOnly ("dry_run={0} force={1} host_tools={2} install_node={3}" -f $DryRun, $Force, (-not $SkipHostTools), (-not $NoInstallNode))

  if ($DryRun) {
    Write-Host ("  {0}{1}DRY RUN{2} {3}- no changes will be made{2}" -f $script:BOLD, $script:YELLOW, $script:R, $script:DIM)
  }
  Write-Host ("  {0}Log: {1}{2}" -f $script:DIM, $script:LogFile, $script:R)

  if (-not (Step-ScipLanguages)) {
    Block-PendingSteps "language selection failed"
  }

  if (-not $script:CriticalFailed -and -not (Step-Preflight)) {
    Block-PendingSteps "preflight failed"
  }

  if (-not $script:CriticalFailed) {
    Step-Packages
    Step-Node
    Step-Checkout
    Step-Composer
    Step-Npm
    Step-ShellWiring
    Step-SeedSettings
    Step-Doctor
    Step-AdminInit
    Step-Validate
    Step-Keys
    Step-Smoke
  }
}
finally {
  Print-Summary
}

if ($script:CriticalFailed) { exit 1 }
exit 0
