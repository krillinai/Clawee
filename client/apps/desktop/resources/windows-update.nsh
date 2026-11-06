!ifndef BUILD_UNINSTALLER
Var claweeUpdateTracked
Var claweeUpdateStartedTick

!macro claweeWriteUpdateState STATE
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  System::Call 'kernel32::GetTickCount() i .r2'
  IntOp $2 $2 - $claweeUpdateStartedTick
  ClearErrors
  FileOpen $1 "$INSTDIR.clawee-update.json.tmp" w
  IfErrors clawee_update_state_failed
  FileWrite $1 '{"schemaVersion":1,"state":"${STATE}","installerPid":$0,"targetVersion":"${VERSION}","elapsedMs":$2}'
  FileClose $1
  IfErrors clawee_update_state_failed
  System::Call 'kernel32::MoveFileExW(w "$INSTDIR.clawee-update.json.tmp", w "$INSTDIR.clawee-update.json", i 9) i .r0'
  IntCmp $0 0 clawee_update_state_failed
  Goto clawee_update_state_written
  clawee_update_state_failed:
    SetErrorLevel 1
    Abort "无法保存客户端更新安装状态"
  clawee_update_state_written:
!macroend

!macro customInit
  StrCpy $claweeUpdateTracked "false"
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $claweeUpdateStartedTick $0
  ${If} ${isUpdated}
  ${AndIf} ${Silent}
    ; 全用户安装先由外层进程提权，再由内层进程写入受保护目录。
    ${If} $installMode != "all"
    ${OrIf} ${UAC_IsAdmin}
      StrCpy $claweeUpdateTracked "true"
      !insertmacro claweeWriteUpdateState "installing"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ${If} $claweeUpdateTracked == "true"
  ${OrIf} ${FileExists} "$INSTDIR.clawee-update.json"
    !insertmacro claweeWriteUpdateState "complete"
  ${EndIf}
!macroend
!endif
