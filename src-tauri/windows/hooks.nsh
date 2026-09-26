; Explorer integration: right-click a file > Send to > Cinderpaw attaches it to
; the chat. Explorer launches the app with the file paths as arguments; the app
; picks them up at start (take_launch_files) or, when it is already running,
; through the single-instance handler. Per-user, like the install itself, and
; removed again on uninstall so no dead entry is left in the menu.

!macro NSIS_HOOK_POSTINSTALL
  CreateShortCut "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$APPDATA\Microsoft\Windows\SendTo\${PRODUCTNAME}.lnk"
!macroend
