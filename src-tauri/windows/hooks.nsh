; Explorer integration: right-click a file > Send to > Cinderpaw attaches it to
; the chat. Explorer launches the app with the file paths as arguments; the app
; picks them up at start (take_launch_files) or, when it is already running,
; through the single-instance handler. Per-user, like the install itself, and
; removed again on uninstall so no dead entry is left in the menu.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Feral was renamed Cinderpaw. Feral's updater runs this installer as an
  ; update, an update makes no shortcuts, and the new name is a new folder: the
  ; person got Cinderpaw with nothing that opens it, while their Feral shortcut
  ; kept opening the old app. So take Feral's place: the same shortcuts under
  ; the new name, then remove the old app. Their data stays: a silent uninstall
  ; keeps app data (that needs a box ticked by hand) and ~/.feral is not its to
  ; touch. $R9, because SetLnkAppUserModelId uses $0-$5.
  ReadRegStr $R9 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Feral" "UninstallString"
  ${If} $R9 != ""
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\Feral.lnk"
    ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
    Exec '$R9 /S'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk"
!macroend
