; Posse setup for Windows.
;
; A per-user installer (no administrator rights) that registers Posse in Apps &
; features, asks for the Posse key and indexing languages, then runs the bundled
; setup engine (install-posse-atlas.ps1) with those choices. The engine installs
; Git, Node.js, the Posse checkout, and each selected language's toolchain;
; `posse update` keeps the checkout current afterwards.
;
; The engine runs hidden. It reports plain-language progress to a file
; (-ProgressFile), which the "Setting up Posse" page polls to drive its progress
; bar and step list; the engine's full output goes only to its log.
;
; Built by scripts/package-windows-installer.mjs, which defines VERSION (x.y.z),
; PAYLOAD_DIR (engine + icon), OUTFILE, and optionally SIGN_COMMAND.
; TEST_ENGINE_CMDLINE (test builds only) replaces the engine command; the
; progress file path is appended as its last argument.

Unicode true
Target amd64-unicode
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WordFunc.nsh"
!include "TextFunc.nsh"
!include "WinMessages.nsh"

!ifndef VERSION
  !error "define VERSION (x.y.z)"
!endif
!ifndef PAYLOAD_DIR
  !error "define PAYLOAD_DIR"
!endif
!ifndef OUTFILE
  !define OUTFILE "PosseSetup-${VERSION}.exe"
!endif

!define PRODUCT "Posse"
!define ENGINE "install-posse-atlas.ps1"
!define APP_KEY "Software\Posse"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Posse"
!define DEFAULT_LANGUAGES "typescript,python"

!define CREATE_NO_WINDOW 0x08000000
!define PBS_MARQUEE 0x08
!define STARTF_USESTDHANDLES 0x100
; PowerShell's own console output, kept even when the engine dies before it
; can write its log (a parse error, a crash at startup).
!define OUTPUT_LOG "$INSTDIR\setup\setup-output.log"
!define WAIT_TIMEOUT 258
; The progress bar runs 0..1000; the engine reports whole percents.
!define BAR_MAX 1000
; Within a step the bar eases toward the step's end: span * t / (t + EASE_SECONDS).
!define EASE_SECONDS 45

Name "${PRODUCT}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\Posse"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
BrandingText "${PRODUCT} ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "FileDescription" "${PRODUCT} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "${PRODUCT}"
VIAddVersionKey "LegalCopyright" "${PRODUCT}"

; Code signing hook: SIGN_COMMAND signs the file named by its last argument in place.
!ifdef SIGN_COMMAND
  !finalize '${SIGN_COMMAND} "%1"' = 0
  !uninstfinalize '${SIGN_COMMAND} "%1"' = 0
!endif

Var PowerShellExe
Var HasSavedKey
Var PosseKey
Var KeyInput
Var KeyArg
Var Languages
Var LangTs
Var LangPy
Var LangPhp
Var LangGo
Var LangRust
Var SelTs
Var SelPy
Var SelPhp
Var SelGo
Var SelRust
Var EngineStarted
Var EngineRunning
Var EngineFailed
Var EngineProcess
Var EngineExit
Var ProgressFile
Var ProgressLines
Var LogPath
Var StepLabel
Var ActivityLabel
Var ProgressBar
Var StepList
Var StepStart
Var StepEnd
Var StepTick
Var Activity
Var BarPos
Var FinishTitle
Var FinishText
Var DesktopShortcut
Var RemoveData
Var DataCheck
Var KeySource
Var WelcomeText
Var FailNote
Var LogButton
Var PercentLabel
Var TimeLabel
Var ItemBar
Var ItemBusyBar
Var NoteLabel
Var DetailsButton
Var DetailsShown
Var SetupNotes
Var ActTick
Var ItemPct
Var OutputLog

!define MUI_ICON "${PAYLOAD_DIR}\posse.ico"
!define MUI_UNICON "${PAYLOAD_DIR}\posse.ico"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${PAYLOAD_DIR}\posse-sidebar.bmp"
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_ABORT OnUserAbort

!define MUI_WELCOMEPAGE_TITLE "Set up Posse"
!define MUI_WELCOMEPAGE_TEXT "$WelcomeText"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom KeyPageShow KeyPageLeave
Page custom LanguagesPageShow LanguagesPageLeave
!define MUI_PAGE_HEADER_TEXT "Preparing setup"
!define MUI_PAGE_HEADER_SUBTEXT "Copying Posse Setup's files."
!insertmacro MUI_PAGE_INSTFILES
Page custom SetupPageShow SetupPageLeave

!define MUI_PAGE_CUSTOMFUNCTION_PRE FinishPagePre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FinishPageShow
!define MUI_FINISHPAGE_TITLE "$FinishTitle"
!define MUI_FINISHPAGE_TEXT "$FinishText"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Posse's fleet view"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenPosse
; The "show readme" checkbox is the standard MUI slot for an extra finish-page
; choice; here it asks whether to put a Posse shortcut on the desktop.
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Put a Posse shortcut on the desktop"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateDesktopShortcut
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
UninstPage custom un.DataPageShow un.DataPageLeave
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------------
; shared helpers
; ---------------------------------------------------------------------------

!macro ResolvePowerShell
  ; A 64-bit installer sees the native System32, so this is 64-bit PowerShell.
  StrCpy $PowerShellExe "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!macroend

; The posse.cmd launcher the engine writes (Step-ShellWiring).
!define POSSE_CMD "$PROFILE\.local\bin\posse.cmd"

; cmd.exe arguments that open Bossy, the fleet view, through `posse --bossy`
; (which always picks the newest verified Bossy build) and keep the window
; open only when it fails, so an error is readable.
!macro BossyArgs OUT
  StrCpy ${OUT} '/d /s /c ""${POSSE_CMD}" --bossy || pause"'
!macroend

; ---------------------------------------------------------------------------
; install
; ---------------------------------------------------------------------------

Function .onInit
  !insertmacro ResolvePowerShell
!ifndef TEST_ENGINE_CMDLINE
  UserInfo::GetAccountType
  Pop $0
  ; With UAC on, an "Admin" token here means the installer was elevated, which
  ; would install Posse into the administrator's profile instead of yours.
  ${If} $0 == "Admin"
    MessageBox MB_ICONSTOP|MB_OK "Run Posse Setup normally, not with 'Run as administrator'. Posse installs into your own account and asks for approval only when a tool needs it." /SD IDOK
    Abort
  ${EndIf}
!endif

  StrCpy $SelTs ${BST_CHECKED}
  StrCpy $SelPy ${BST_CHECKED}
  StrCpy $SelPhp ${BST_UNCHECKED}
  StrCpy $SelGo ${BST_UNCHECKED}
  StrCpy $SelRust ${BST_UNCHECKED}
  StrCpy $Languages "${DEFAULT_LANGUAGES}"
  StrCpy $DesktopShortcut 0
  StrCpy $EngineStarted 0
  StrCpy $EngineRunning 0
  StrCpy $EngineFailed 0

  ; Unattended installs: PosseSetup.exe /S [/LANGUAGES=typescript,go] [/DESKTOPSHORTCUT]
  ; The key comes from the saved .env or a POSSE_KEY environment variable.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/LANGUAGES=" $R1
  ${IfNot} ${Errors}
  ${AndIf} $R1 != ""
    StrCpy $Languages $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DESKTOPSHORTCUT" $R1
  ${IfNot} ${Errors}
    StrCpy $DesktopShortcut 1
  ${EndIf}

  Call DetectSavedKey
  StrCpy $WelcomeText "Setup installs Posse for your Windows account. It does not need administrator rights.$\r$\n$\r$\n"
  ${If} $HasSavedKey == 1
    StrCpy $WelcomeText "$WelcomeTextSetup found your Posse key in $KeySource and will use it. "
  ${Else}
    StrCpy $WelcomeText "$WelcomeTextYou will paste your Posse key. "
  ${EndIf}
  StrCpy $WelcomeText "$WelcomeTextPick the languages your projects use, and setup downloads whatever is missing: Git, Node.js, Posse itself, and the code-indexing tools for those languages.$\r$\n$\r$\nThe download step can take several minutes."
FunctionEnd

; While the engine runs, closing setup would leave it running unseen.
Function OnUserAbort
  ${If} $EngineRunning == 1
    MessageBox MB_ICONINFORMATION|MB_OK "Posse is still being set up. Please wait for it to finish."
    Abort
  ${EndIf}
FunctionEnd

; Look for a Posse key before asking for one: this process's environment, the
; user and system environment variables in the registry (set after sign-in,
; so this process may not have inherited them), the private .env, and the
; older providers.env.ps1. A registry key is passed on to the engine through
; this process's environment rather than copied anywhere.
Function DetectSavedKey
  StrCpy $HasSavedKey 0
  ReadEnvStr $0 "POSSE_KEY"
  ${If} $0 != ""
    StrCpy $HasSavedKey 1
    StrCpy $KeySource "your environment variables"
    Return
  ${EndIf}
  ReadRegStr $0 HKCU "Environment" "POSSE_KEY"
  StrCpy $KeySource "your user environment variables"
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "POSSE_KEY"
    StrCpy $KeySource "the system environment variables"
  ${EndIf}
  ${If} $0 != ""
    System::Call 'kernel32::SetEnvironmentVariableW(w "POSSE_KEY", w r0)'
    StrCpy $HasSavedKey 1
    Return
  ${EndIf}
  Push "$PROFILE\.config\posse\.env"
  Push "POSSE_KEY="
  Call FileHasLinePrefix
  Pop $0
  ${If} $0 == 1
    StrCpy $HasSavedKey 1
    StrCpy $KeySource "your saved Posse settings"
    Return
  ${EndIf}
  Push "$PROFILE\.config\posse\providers.env.ps1"
  Push "$$env:POSSE_KEY"
  Call FileHasLinePrefix
  Pop $0
  ${If} $0 == 1
    StrCpy $HasSavedKey 1
    StrCpy $KeySource "your saved Posse settings"
  ${EndIf}
FunctionEnd

; Push 1 when a line of FILE starts with PREFIX (after leading whitespace and an
; optional "export "), else 0. Usage: Push FILE, Push PREFIX, Call, Pop result.
Function FileHasLinePrefix
  Exch $R1
  Exch
  Exch $R0
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  StrLen $R4 $R1
  StrCpy $R3 0
  ClearErrors
  FileOpen $R0 $R0 r
  ${IfNot} ${Errors}
    ${Do}
      ClearErrors
      FileRead $R0 $R2
      ${If} ${Errors}
        ${Break}
      ${EndIf}
      Push $R2
      Call TrimWhitespace
      Pop $R2
      StrCpy $R5 $R2 7
      ${If} $R5 == "export "
        StrCpy $R2 $R2 "" 7
      ${EndIf}
      StrCpy $R5 $R2 $R4
      ${If} $R5 == $R1
        StrCpy $R3 1
        ${Break}
      ${EndIf}
    ${Loop}
    FileClose $R0
  ${EndIf}
  StrCpy $R0 $R3
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

Function KeyPageShow
  ; A key already on this PC is used as-is; the welcome page says where it was found.
  ${If} $HasSavedKey == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Posse key" "Paste the key your Posse administrator gave you."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "Paste your Posse key below. It is saved in .config\posse\.env in your user folder, readable only by your account."
  Pop $0
  ${NSD_CreatePassword} 0 34u 100% 13u "$PosseKey"
  Pop $KeyInput
  ${NSD_CreateLabel} 0 58u 100% 40u "No key yet? Ask the administrator who gave you access to Posse.$\r$\n$\r$\nModel providers (OpenAI, Claude, Codex) are set up after install with: posse admin"
  Pop $0
  ${NSD_SetFocus} $KeyInput
  nsDialogs::Show
FunctionEnd

Function KeyPageLeave
  ${NSD_GetText} $KeyInput $PosseKey
  Push $PosseKey
  Call TrimWhitespace
  Pop $PosseKey
  ${If} $PosseKey == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Posse needs a key to finish setup. Paste the key you were given."
    Abort
  ${EndIf}
  Push $PosseKey
  Call HasWhitespace
  Pop $0
  ${If} $0 == 1
    MessageBox MB_ICONEXCLAMATION|MB_OK "That key contains a space or line break. Paste just the key."
    Abort
  ${EndIf}
FunctionEnd

Function LanguagesPageShow
  !insertmacro MUI_HEADER_TEXT "Code indexing" "Pick the languages your projects use."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 22u "Posse indexes your code to find the right files for each task. Setup installs the indexer and toolchain for every language you pick."
  Pop $0
  ${NSD_CreateCheckbox} 0 26u 100% 12u "TypeScript / JavaScript"
  Pop $LangTs
  ${NSD_SetState} $LangTs $SelTs
  ${NSD_CreateCheckbox} 0 40u 100% 12u "Python"
  Pop $LangPy
  ${NSD_SetState} $LangPy $SelPy
  ${NSD_CreateCheckbox} 0 54u 100% 12u "PHP  (installs PHP and Composer)"
  Pop $LangPhp
  ${NSD_SetState} $LangPhp $SelPhp
  ${NSD_CreateCheckbox} 0 68u 100% 12u "Go  (installs Go)"
  Pop $LangGo
  ${NSD_SetState} $LangGo $SelGo
  ${NSD_CreateCheckbox} 0 82u 100% 12u "Rust  (installs Rust and rust-analyzer with rustup)"
  Pop $LangRust
  ${NSD_SetState} $LangRust $SelRust
  ${NSD_CreateLabel} 0 102u 100% 30u "C and C++ indexing is not available on Windows. To add a language later, turn it on in posse admin, then run this setup again to install its tools."
  Pop $0
  nsDialogs::Show
FunctionEnd

Function LanguagesPageLeave
  ${NSD_GetState} $LangTs $SelTs
  ${NSD_GetState} $LangPy $SelPy
  ${NSD_GetState} $LangPhp $SelPhp
  ${NSD_GetState} $LangGo $SelGo
  ${NSD_GetState} $LangRust $SelRust
  StrCpy $Languages ""
  ${If} $SelTs == ${BST_CHECKED}
    StrCpy $Languages "$Languages,typescript"
  ${EndIf}
  ${If} $SelPy == ${BST_CHECKED}
    StrCpy $Languages "$Languages,python"
  ${EndIf}
  ${If} $SelPhp == ${BST_CHECKED}
    StrCpy $Languages "$Languages,php"
  ${EndIf}
  ${If} $SelGo == ${BST_CHECKED}
    StrCpy $Languages "$Languages,go"
  ${EndIf}
  ${If} $SelRust == ${BST_CHECKED}
    StrCpy $Languages "$Languages,rust"
  ${EndIf}
  ${If} $Languages == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Pick at least one language."
    Abort
  ${EndIf}
  StrCpy $Languages $Languages "" 1
FunctionEnd

; Copies setup's files and registers Posse. The engine itself runs on the next
; page (or right here for an unattended install, which shows no pages).
Section "Posse" SecPosse
  SectionIn RO
  SetOutPath "$INSTDIR\setup"
  File "${PAYLOAD_DIR}\${ENGINE}"
  File "${PAYLOAD_DIR}\posse.ico"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Register before the long engine run, so an interrupted or failed setup can
  ; still be removed from Apps & features (or finished by running setup again).
  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${PRODUCT}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\setup\posse.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://yourposseai.com/"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1

  ${If} ${Silent}
    Call RunEngineUnattended
    Call CompleteInstall
  ${EndIf}
SectionEnd

; The key travels in a private temp file, never on a command line; the engine
; deletes it after reading and setup deletes it again regardless.
Function WriteKeyFile
  InitPluginsDir
  StrCpy $KeyArg ""
  ${If} $PosseKey != ""
    FileOpen $0 "$PLUGINSDIR\posse-keys.env" w
    FileWrite $0 "POSSE_KEY=$PosseKey$\r$\n"
    FileClose $0
    StrCpy $KeyArg '-KeyFile "$PLUGINSDIR\posse-keys.env"'
  ${EndIf}
FunctionEnd

!macro EngineCommand OUT
  StrCpy ${OUT} '"$PowerShellExe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\${ENGINE}" -NonInteractive -Plain -PosseDir "$INSTDIR\posse-client" -ScipLanguages "$Languages" -ProgressFile "$ProgressFile" $KeyArg'
!ifdef TEST_ENGINE_CMDLINE
  StrCpy ${OUT} '${TEST_ENGINE_CMDLINE} "$ProgressFile"'
!endif
!macroend

; Starts the engine hidden with its stdout and stderr going to OUTPUT_LOG.
; Sets $EngineProcess and pushes 1 on success, 0 when it could not start.
; CreateProcess (not nsExec) lets the setup page keep updating while it runs.
Function LaunchEngine
  !insertmacro EngineCommand $R0
  StrCpy $OutputLog "${OUTPUT_LOG}"
  ; SECURITY_ATTRIBUTES (x64, 24 bytes) with bInheritHandle, so the child
  ; inherits the output file. Alloc zero-fills.
  System::Alloc 24
  Pop $R1
  System::Call '*$R1(i 24, i 0, p 0, i 1)'
  System::Call 'kernel32::CreateFileW(w "$OutputLog", i 0x40000000, i 3, p R1, i 2, i 0x80, p 0) p .R2'
  System::Call 'kernel32::CreateFileW(w "NUL", i 0x80000000, i 3, p R1, i 3, i 0, p 0) p .R3'
  ; STARTUPINFOW (x64, 104 bytes): cb at 0, dwFlags at 60, hStdInput at 80,
  ; hStdOutput at 88, hStdError at 96.
  System::Alloc 104
  Pop $R4
  System::Call '*$R4(i 104)'
  StrCpy $R6 0
  ${If} $R2 != -1
  ${AndIf} $R3 != -1
    IntPtrOp $R5 $R4 + 60
    System::Call '*$R5(i ${STARTF_USESTDHANDLES})'
    IntPtrOp $R5 $R4 + 80
    System::Call '*$R5(p R3, p R2, p R2)'
    StrCpy $R6 1
  ${Else}
    StrCpy $OutputLog ""
  ${EndIf}
  System::Alloc 24
  Pop $R7
  System::Call 'kernel32::CreateProcessW(p 0, w R0, p 0, p 0, i R6, i ${CREATE_NO_WINDOW}, p 0, p 0, p R4, p R7) i .R8'
  ; The child holds its own copies of the inherited handles.
  ${If} $R2 != -1
    System::Call 'kernel32::CloseHandle(p R2)'
  ${EndIf}
  ${If} $R3 != -1
    System::Call 'kernel32::CloseHandle(p R3)'
  ${EndIf}
  ${If} $R8 != 0
    System::Call '*$R7(p .R5, p .R9)'
    StrCpy $EngineProcess $R5
    System::Call 'kernel32::CloseHandle(p R9)'
    StrCpy $R8 1
  ${EndIf}
  System::Free $R1
  System::Free $R4
  System::Free $R7
  Push $R8
FunctionEnd

Function RunEngineUnattended
  Call WriteKeyFile
  StrCpy $ProgressFile "$PLUGINSDIR\progress.txt"
  Call LaunchEngine
  Pop $0
  ${If} $0 == 1
    System::Call 'kernel32::WaitForSingleObject(p $EngineProcess, i -1)'
    System::Call 'kernel32::GetExitCodeProcess(p $EngineProcess, *i .r1)'
    System::Call 'kernel32::CloseHandle(p $EngineProcess)'
    StrCpy $EngineExit $1
  ${Else}
    StrCpy $EngineExit 1
  ${EndIf}
  Delete "$PLUGINSDIR\posse-keys.env"
  ${If} $EngineExit != 0
    StrCpy $EngineFailed 1
    SetErrorLevel 2
  ${EndIf}
FunctionEnd

; Shortcuts and the installed size, once the engine has succeeded.
Function CompleteInstall
  ${If} $EngineFailed != 1
    ; Shortcuts start in your user folder; posse works on the project you cd into.
    SetOutPath "$PROFILE"
    CreateDirectory "$SMPROGRAMS\Posse"
    !insertmacro BossyArgs $0
    CreateShortCut "$SMPROGRAMS\Posse\Posse.lnk" "$SYSDIR\cmd.exe" $0 "$INSTDIR\setup\posse.ico" 0
    ${WordReplace} "${POSSE_CMD}" "'" "''" "+" $1
    CreateShortCut "$SMPROGRAMS\Posse\Posse Terminal.lnk" "$PowerShellExe" "-NoExit -NoLogo -Command $\"& '$1' help$\"" "$INSTDIR\setup\posse.ico" 0
    ${If} $DesktopShortcut == 1
      Call CreateDesktopShortcut
    ${EndIf}
  ${EndIf}
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
FunctionEnd

; ---------------------------------------------------------------------------
; "Setting up Posse" page: runs the engine hidden and shows its progress
; ---------------------------------------------------------------------------

Function SetupPageShow
  ${If} $EngineStarted == 1
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Setting up Posse" "Setup downloads and installs what Posse needs. This can take several minutes."
  nsDialogs::Create 1018
  Pop $0
  CreateFont $1 "$(^Font)" "$(^FontSize)" 700

  ; Overall: the current step and how far setup is.
  ${NSD_CreateLabel} 0 0 78% 11u "Starting setup"
  Pop $StepLabel
  SendMessage $StepLabel ${WM_SETFONT} $1 0
  nsDialogs::CreateControl ${__NSD_Label_CLASS} ${__NSD_Label_STYLE}|${SS_RIGHT} ${__NSD_Label_EXSTYLE} 78% 0 22% 11u "0%"
  Pop $PercentLabel
  SendMessage $PercentLabel ${WM_SETFONT} $1 0
  ${NSD_CreateProgressBar} 0 13u 100% 11u ""
  Pop $ProgressBar
  SendMessage $ProgressBar ${PBM_SETRANGE32} 0 ${BAR_MAX}

  ; Current item: what is being installed right now, with its own bar. Real
  ; percentages where setup can measure them (downloads), animated otherwise.
  nsDialogs::CreateControl ${__NSD_Label_CLASS} ${__NSD_Label_STYLE}|${SS_ENDELLIPSIS} ${__NSD_Label_EXSTYLE} 0 33u 80% 10u ""
  Pop $ActivityLabel
  nsDialogs::CreateControl ${__NSD_Label_CLASS} ${__NSD_Label_STYLE}|${SS_RIGHT} ${__NSD_Label_EXSTYLE} 80% 33u 20% 10u ""
  Pop $TimeLabel
  ${NSD_CreateProgressBar} 0 45u 100% 7u ""
  Pop $ItemBar
  SendMessage $ItemBar ${PBM_SETRANGE32} 0 100
  ShowWindow $ItemBar ${SW_HIDE}
  nsDialogs::CreateControl ${__NSD_ProgressBar_CLASS} ${__NSD_ProgressBar_STYLE}|${PBS_MARQUEE} ${__NSD_ProgressBar_EXSTYLE} 0 45u 100% 7u ""
  Pop $ItemBusyBar
  SendMessage $ItemBusyBar ${PBM_SETMARQUEE} 1 30

  ; Warnings, or why setup stopped. The finished-step list replaces it on request.
  ${NSD_CreateLabel} 0 60u 100% 52u ""
  Pop $NoteLabel
  ${NSD_CreateListBox} 0 60u 100% 56u ""
  Pop $StepList
  ShowWindow $StepList ${SW_HIDE}
  StrCpy $DetailsShown 0
  ${NSD_CreateButton} 0 121u 66u 14u "Show details"
  Pop $DetailsButton
  ${NSD_OnClick} $DetailsButton ToggleDetails
  ${NSD_CreateButton} 70u 121u 60u 14u "Open log"
  Pop $LogButton
  ${NSD_OnClick} $LogButton OpenLog
  ShowWindow $LogButton ${SW_HIDE}

  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0

  Call StartEngine
  ${If} $EngineRunning == 1
    ${NSD_CreateTimer} OnEngineTick 400
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ToggleDetails
  ${If} $DetailsShown == 1
    StrCpy $DetailsShown 0
    ShowWindow $StepList ${SW_HIDE}
    ShowWindow $NoteLabel ${SW_SHOW}
    ${NSD_SetText} $DetailsButton "Show details"
  ${Else}
    StrCpy $DetailsShown 1
    ShowWindow $NoteLabel ${SW_HIDE}
    ShowWindow $StepList ${SW_SHOW}
    ${NSD_SetText} $DetailsButton "Hide details"
  ${EndIf}
FunctionEnd

; Shows the current item's bar: a percentage (0-100), or "" for an animated
; "busy" bar when the item cannot report progress.
!macro ShowItemProgress PCT
  StrCpy $ItemPct "${PCT}"
  ${If} $ItemPct == ""
    ShowWindow $ItemBar ${SW_HIDE}
    ShowWindow $ItemBusyBar ${SW_SHOW}
  ${Else}
    ShowWindow $ItemBusyBar ${SW_HIDE}
    ShowWindow $ItemBar ${SW_SHOW}
    SendMessage $ItemBar ${PBM_SETPOS} $ItemPct 0
  ${EndIf}
!macroend

Function SetupPageLeave
  ${If} $EngineRunning == 1
    Abort
  ${EndIf}
FunctionEnd

Function StartEngine
  StrCpy $EngineStarted 1
  Call WriteKeyFile
  StrCpy $ProgressFile "$PLUGINSDIR\progress.txt"
  Delete $ProgressFile
  StrCpy $ProgressLines 0
  StrCpy $BarPos 0
  StrCpy $StepStart 0
  StrCpy $StepEnd 2
  StrCpy $Activity ""
  StrCpy $SetupNotes ""
  StrCpy $FailNote ""
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $StepTick $0
  StrCpy $ActTick $0

  Call LaunchEngine
  Pop $3
  ${If} $3 != 1
    StrCpy $EngineFailed 1
    StrCpy $EngineExit 1
    ${NSD_SetText} $StepLabel "Setup could not start Windows PowerShell"
    ${NSD_SetText} $ActivityLabel "Posse Setup needs Windows PowerShell, which is part of Windows."
    Call EnableNext
  ${Else}
    StrCpy $EngineRunning 1
    GetDlgItem $0 $HWNDPARENT 2
    EnableWindow $0 0
  ${EndIf}
FunctionEnd

Function OnEngineTick
  Call ReadProgress

  ; Time on the current item, and an overall bar that eases toward the step's
  ; end so it keeps moving during long steps without claiming the step is done.
  System::Call 'kernel32::GetTickCount() i .r0'
  IntOp $1 $0 - $ActTick
  IntOp $1 $1 / 1000
  IntOp $2 $1 / 60
  IntOp $1 $1 % 60
  IntFmt $1 "%02d" $1
  ${NSD_SetText} $TimeLabel "$2:$1"
  ${NSD_SetText} $ActivityLabel "$Activity"
  IntOp $0 $0 - $StepTick
  IntOp $0 $0 / 1000
  IntOp $3 $StepEnd - $StepStart
  IntOp $3 $3 * 10
  IntOp $4 $0 + ${EASE_SECONDS}
  IntOp $5 $3 * $0
  IntOp $5 $5 / $4
  IntOp $6 $StepStart * 10
  IntOp $6 $6 + $5
  ${If} $6 > $BarPos
    StrCpy $BarPos $6
    SendMessage $ProgressBar ${PBM_SETPOS} $BarPos 0
  ${EndIf}
  IntOp $6 $BarPos / 10
  ${NSD_SetText} $PercentLabel "$6%"

  System::Call 'kernel32::WaitForSingleObject(p $EngineProcess, i 0) i .r7'
  ${If} $7 != ${WAIT_TIMEOUT}
    ${NSD_KillTimer} OnEngineTick
    Call ReadProgress
    System::Call 'kernel32::GetExitCodeProcess(p $EngineProcess, *i .r8)'
    System::Call 'kernel32::CloseHandle(p $EngineProcess)'
    StrCpy $EngineExit $8
    StrCpy $EngineRunning 0
    Delete "$PLUGINSDIR\posse-keys.env"
    Call EngineFinished
  ${EndIf}
FunctionEnd

; Reads the progress lines added since the last tick. A line still being
; written (no line break yet) is left for the next tick.
Function ReadProgress
  ClearErrors
  FileOpen $R0 $ProgressFile r
  ${If} ${Errors}
    Return
  ${EndIf}
  StrCpy $R1 0
  ${Do}
    ClearErrors
    FileRead $R0 $R2
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    StrCpy $R3 $R2 1 -1
    ${If} $R3 != "$\n"
      ${Break}
    ${EndIf}
    IntOp $R1 $R1 + 1
    ${If} $R1 > $ProgressLines
      StrCpy $ProgressLines $R1
      ${TrimNewLines} $R2 $R2
      Push $R2
      Call HandleProgressLine
    ${EndIf}
  ${Loop}
  FileClose $R0
FunctionEnd

; Field N (1-based) of a TAB-separated progress line; "-" means empty.
!macro ProgressField LINE N OUT
  ClearErrors
  ${WordFind} "${LINE}" "$\t" "E+${N}" ${OUT}
  ${If} ${Errors}
  ${OrIf} ${OUT} == "-"
    StrCpy ${OUT} ""
  ${EndIf}
!macroend

Function HandleProgressLine
  Exch $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  !insertmacro ProgressField $R4 1 $R5
  ${If} $R5 == "step"
    !insertmacro ProgressField $R4 2 $StepStart
    !insertmacro ProgressField $R4 3 $StepEnd
    !insertmacro ProgressField $R4 4 $R6
    ${NSD_SetText} $StepLabel $R6
    StrCpy $Activity "Getting started"
    !insertmacro ShowItemProgress ""
    System::Call 'kernel32::GetTickCount() i .r19'
    StrCpy $StepTick $R9
    StrCpy $ActTick $R9
    IntOp $R7 $StepStart * 10
    ${If} $R7 > $BarPos
      StrCpy $BarPos $R7
      SendMessage $ProgressBar ${PBM_SETPOS} $BarPos 0
    ${EndIf}
  ${ElseIf} $R5 == "act"
    !insertmacro ProgressField $R4 2 $Activity
    !insertmacro ProgressField $R4 3 $R6
    !insertmacro ShowItemProgress $R6
    System::Call 'kernel32::GetTickCount() i .r19'
    StrCpy $ActTick $R9
  ${ElseIf} $R5 == "actpct"
    !insertmacro ProgressField $R4 2 $R6
    !insertmacro ShowItemProgress $R6
  ${ElseIf} $R5 == "end"
    !insertmacro ProgressField $R4 2 $R6
    !insertmacro ProgressField $R4 3 $R7
    !insertmacro ProgressField $R4 4 $R8
    !insertmacro ProgressField $R4 5 $R9
    ${If} $R6 == "ok"
    ${OrIf} $R6 == "done"
      ${NSD_LB_AddString} $StepList "$R7"
    ${ElseIf} $R6 == "partial"
      ${If} $R9 != ""
        ${NSD_LB_AddString} $StepList "$R7 ($R9)"
        ${If} $SetupNotes == ""
          StrCpy $SetupNotes "$R9"
        ${Else}
          StrCpy $SetupNotes "$SetupNotes$\r$\n$R9"
        ${EndIf}
      ${Else}
        ${NSD_LB_AddString} $StepList "$R7 (with warnings)"
      ${EndIf}
      ${NSD_SetText} $NoteLabel "Notes so far:$\r$\n$SetupNotes"
    ${ElseIf} $R6 == "failed"
      ${NSD_LB_AddString} $StepList "Stopped at: $R8"
      ${If} $R9 != ""
        StrCpy $FailNote "Stopped at: $R8$\r$\n$R9"
      ${Else}
        StrCpy $FailNote "Stopped at: $R8"
      ${EndIf}
    ${EndIf}
    ; Keep the newest entry in view.
    SendMessage $StepList ${LB_GETCOUNT} 0 0 $R6
    IntOp $R6 $R6 - 1
    SendMessage $StepList ${LB_SETTOPINDEX} $R6 0
    IntOp $R7 $StepEnd * 10
    ${If} $R7 > $BarPos
      StrCpy $BarPos $R7
      SendMessage $ProgressBar ${PBM_SETPOS} $BarPos 0
    ${EndIf}
  ${ElseIf} $R5 == "log"
    !insertmacro ProgressField $R4 2 $LogPath
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
FunctionEnd

Function EngineFinished
  ; An engine that died before it could log still left PowerShell's output.
  ${If} $LogPath == ""
  ${OrIfNot} ${FileExists} "$LogPath"
    StrCpy $LogPath $OutputLog
  ${EndIf}
  ShowWindow $ItemBusyBar ${SW_HIDE}
  ShowWindow $ItemBar ${SW_HIDE}
  ${NSD_SetText} $TimeLabel ""
  ${If} $LogPath != ""
  ${AndIf} ${FileExists} "$LogPath"
    ShowWindow $LogButton ${SW_SHOW}
  ${EndIf}
  ${If} $EngineExit == 0
    StrCpy $EngineFailed 0
    StrCpy $BarPos ${BAR_MAX}
    SendMessage $ProgressBar ${PBM_SETPOS} $BarPos 0
    ${NSD_SetText} $PercentLabel "100%"
    ${NSD_SetText} $StepLabel "Posse is installed"
    Call CompleteInstall
    Call EnableNext
    ${If} $SetupNotes == ""
      ${NSD_SetText} $ActivityLabel ""
      ; Nothing to read here; move on to the finish page by itself.
      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $HWNDPARENT ${WM_COMMAND} 1 $0
    ${Else}
      ; Stay so the notes are seen; Next continues.
      ${NSD_SetText} $ActivityLabel "Finished, with notes. Click Next to continue."
      ${NSD_SetText} $NoteLabel "Notes:$\r$\n$SetupNotes"
    ${EndIf}
  ${Else}
    StrCpy $EngineFailed 1
    ${NSD_SetText} $StepLabel "Setup did not finish"
    ${NSD_SetText} $PercentLabel ""
    ${NSD_SetText} $ActivityLabel "Fix the problem below, then run Posse Setup again."
    ${If} $FailNote != ""
      ${NSD_SetText} $NoteLabel "$FailNote"
    ${Else}
      ${NSD_SetText} $NoteLabel "Setup stopped before it could report a step. Open the log to see PowerShell's output."
    ${EndIf}
    Call EnableNext
  ${EndIf}
FunctionEnd

Function OpenLog
  ExecShell "open" "$LogPath"
FunctionEnd

Function EnableNext
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  GetDlgItem $0 $HWNDPARENT 2
  EnableWindow $0 1
FunctionEnd

; Splits a log path into a short folder (with %LOCALAPPDATA% or %USERPROFILE%
; in place of the long prefix, so it fits and pastes into Explorer) and a name.
; Usage: Push PATH, Call SplitLogPath, Pop FOLDER, Pop NAME.
Function SplitLogPath
  Exch $R0
  Push $R1
  Push $R2
  Push $R3
  ${GetFileName} $R0 $R1
  ${GetParent} $R0 $R2
  StrLen $R3 $LOCALAPPDATA
  StrCpy $R0 $R2 $R3
  ${If} $R0 == $LOCALAPPDATA
    StrCpy $R2 $R2 "" $R3
    StrCpy $R2 "%LOCALAPPDATA%$R2"
  ${Else}
    StrLen $R3 $PROFILE
    StrCpy $R0 $R2 $R3
    ${If} $R0 == $PROFILE
      StrCpy $R2 $R2 "" $R3
      StrCpy $R2 "%USERPROFILE%$R2"
    ${EndIf}
  ${EndIf}
  StrCpy $R0 $R1
  Pop $R3
  Exch $R2
  Exch 2
  Exch $R0
  Exch
  Pop $R1
  Exch
FunctionEnd

Function FinishPagePre
  ${If} $EngineFailed == 1
    StrCpy $FinishTitle "Posse setup did not finish"
    ${If} $LogPath != ""
      Push $LogPath
      Call SplitLogPath
      Pop $0
      Pop $1
      StrCpy $FinishText "A setup step failed. Its log, $1, is in:$\r$\n$0$\r$\n$\r$\nFix the problem it reports, then run Posse Setup again."
    ${Else}
      StrCpy $FinishText "A setup step failed. Its log is the newest file in:$\r$\n%USERPROFILE%\.posse\logs$\r$\n$\r$\nFix the problem it reports, then run Posse Setup again."
    ${EndIf}
  ${Else}
    StrCpy $FinishTitle "Posse is ready"
    StrCpy $FinishText "Open a new terminal in a project folder and run:$\r$\n    posse admin$\r$\n    posse add $\"Describe a task$\"$\r$\n    posse go"
  ${EndIf}
FunctionEnd

Function FinishPageShow
  ; Setup has already run; there is nothing to go back to.
  GetDlgItem $0 $HWNDPARENT 3
  ShowWindow $0 ${SW_HIDE}
  ${If} $EngineFailed == 1
    ${NSD_Uncheck} $mui.FinishPage.Run
    ShowWindow $mui.FinishPage.Run ${SW_HIDE}
    ${NSD_Uncheck} $mui.FinishPage.ShowReadme
    ShowWindow $mui.FinishPage.ShowReadme ${SW_HIDE}
  ${EndIf}
FunctionEnd

Function OpenPosse
  !insertmacro BossyArgs $0
  Exec '"$SYSDIR\cmd.exe" $0'
FunctionEnd

Function CreateDesktopShortcut
  SetOutPath "$PROFILE"
  !insertmacro BossyArgs $0
  CreateShortCut "$DESKTOP\Posse.lnk" "$SYSDIR\cmd.exe" $0 "$INSTDIR\setup\posse.ico" 0
FunctionEnd

; Trim leading/trailing spaces, tabs, and line breaks from the value on the stack.
Function TrimWhitespace
  Exch $R0
  Push $R1
  ${Do}
    StrCpy $R1 $R0 1
    ${If} $R1 == " "
    ${OrIf} $R1 == "$\t"
    ${OrIf} $R1 == "$\r"
    ${OrIf} $R1 == "$\n"
      StrCpy $R0 $R0 "" 1
    ${Else}
      ${Break}
    ${EndIf}
  ${Loop}
  ${Do}
    StrCpy $R1 $R0 1 -1
    ${If} $R1 == " "
    ${OrIf} $R1 == "$\t"
    ${OrIf} $R1 == "$\r"
    ${OrIf} $R1 == "$\n"
      StrCpy $R0 $R0 -1
    ${Else}
      ${Break}
    ${EndIf}
  ${Loop}
  Pop $R1
  Exch $R0
FunctionEnd

; Push 1 when the value on the stack contains a space, tab, or line break.
Function HasWhitespace
  Exch $R0
  Push $R1
  Push $R2
  StrCpy $R2 0
  ${Do}
    StrCpy $R1 $R0 1 $R2
    ${If} $R1 == ""
      StrCpy $R0 0
      ${Break}
    ${EndIf}
    ${If} $R1 == " "
    ${OrIf} $R1 == "$\t"
    ${OrIf} $R1 == "$\r"
    ${OrIf} $R1 == "$\n"
      StrCpy $R0 1
      ${Break}
    ${EndIf}
    IntOp $R2 $R2 + 1
  ${Loop}
  Pop $R2
  Pop $R1
  Exch $R0
FunctionEnd

; ---------------------------------------------------------------------------
; uninstall
; ---------------------------------------------------------------------------

Function un.onInit
  !insertmacro ResolvePowerShell
  StrCpy $RemoveData 0
  ; Unattended: uninstall.exe /S [/REMOVEDATA]
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/REMOVEDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $RemoveData 1
  ${EndIf}
FunctionEnd

Function un.DataPageShow
  !insertmacro MUI_HEADER_TEXT "Remove Posse" "Choose what to remove."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 30u "Posse, its posse command, its shortcuts, and its startup task will be removed. Your projects are not touched."
  Pop $0
  ${NSD_CreateCheckbox} 0 36u 100% 24u "Also delete my Posse settings, saved keys, logs, and downloaded runtimes"
  Pop $DataCheck
  ${If} $RemoveData == 1
    ${NSD_Check} $DataCheck
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function un.DataPageLeave
  ${NSD_GetState} $DataCheck $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $RemoveData 1
  ${Else}
    StrCpy $RemoveData 0
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; The engine undoes what it set up: the automation startup task, the posse
  ; command and its PATH entry, profile lines, and (if chosen) your data. Its
  ; output goes to its log; this page shows one line per stage.
  StrCpy $1 ""
  ${If} $RemoveData == 1
    StrCpy $1 "-RemoveUserData"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\setup\${ENGINE}"
    DetailPrint "Removing the posse command, its startup task, and your profile settings..."
    nsExec::Exec '"$PowerShellExe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\setup\${ENGINE}" -Uninstall -NonInteractive -Plain -PosseDir "$INSTDIR\posse-client" $1'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Some Posse settings could not be removed. The posse-uninstall log in your Temp folder lists them."
    ${EndIf}
  ${EndIf}

  DetailPrint "Removing shortcuts..."
  SetDetailsPrint none
  Delete "$DESKTOP\Posse.lnk"
  Delete "$SMPROGRAMS\Posse\Posse.lnk"
  Delete "$SMPROGRAMS\Posse\Posse Terminal.lnk"
  RMDir "$SMPROGRAMS\Posse"
  SetDetailsPrint both

  DetailPrint "Removing Posse's files (this can take a minute)..."
  SetDetailsPrint none
  RMDir /r "$INSTDIR\posse-client"
  RMDir /r "$INSTDIR\setup"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  SetDetailsPrint both
  ${If} ${FileExists} "$INSTDIR\*.*"
    DetailPrint "Some files are still in use and were left in $INSTDIR. Close Posse windows, then delete that folder."
  ${Else}
    DetailPrint "Posse has been removed."
  ${EndIf}

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
SectionEnd
