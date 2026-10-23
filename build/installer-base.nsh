!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!ifndef BUILD_UNINSTALLER

Var GWBaseChoice
Var GWBaseSuggested
Var GWBaseExisting
Var GWBaseInput
Var GWBaseBrowse
Var GWBaseKeep
Var GWBaseNote

!macro customInit
  Call GWDetectBasePackage
!macroend

!macro customPageAfterChangeDir
  Page custom GWBasePageCreate GWBasePageLeave
!macroend

!macro customInstall
  ${If} $GWBaseChoice == "__existing__"
    Delete "$LOCALAPPDATA\GenshinWords\installer-base-selection.ini"
  ${Else}
    ${If} $GWBaseChoice == ""
      DetailPrint "没有选择基础素材包。"
      SetErrorLevel 3
      Abort
    ${EndIf}
    CreateDirectory "$LOCALAPPDATA\GenshinWords"
    ; The native INI writer preserves Chinese and other Unicode paths.
    FileOpen $0 "$LOCALAPPDATA\GenshinWords\installer-base-selection.ini" w
    ${If} ${Errors}
      DetailPrint "无法保存基础素材包位置。"
      SetErrorLevel 3
      Abort
    ${EndIf}
    FileWriteWord $0 0xFEFF
    FileClose $0
    WriteINIStr "$LOCALAPPDATA\GenshinWords\installer-base-selection.ini" "Base" "Path" "$GWBaseChoice"
    ${If} ${Errors}
      DetailPrint "无法保存基础素材包位置。"
      SetErrorLevel 3
      Abort
    ${EndIf}
  ${EndIf}
!macroend

Function GWDetectBasePackage
  StrCpy $GWBaseChoice ""
  StrCpy $GWBaseSuggested ""
  StrCpy $GWBaseExisting "0"
  ${If} ${FileExists} "$LOCALAPPDATA\GenshinWords\resource-directory-raw.json"
    StrCpy $GWBaseExisting "1"
  ${ElseIf} ${FileExists} "$LOCALAPPDATA\GenshinWords\content-packages\registry.json"
    StrCpy $GWBaseExisting "1"
  ${EndIf}

  ; Prefer the published base package name. An ambiguous set needs an explicit choice.
  FindFirst $0 $1 "$EXEDIR\genshinwords-base*.gwcontent"
  ${IfNot} ${Errors}
    StrCpy $GWBaseSuggested "$EXEDIR\$1"
    FindNext $0 $1
    ${IfNot} ${Errors}
      StrCpy $GWBaseSuggested ""
    ${EndIf}
    FindClose $0
  ${Else}
    FindFirst $0 $1 "$EXEDIR\*.gwcontent"
    ${IfNot} ${Errors}
      StrCpy $GWBaseSuggested "$EXEDIR\$1"
      FindNext $0 $1
      ${IfNot} ${Errors}
        StrCpy $GWBaseSuggested ""
      ${EndIf}
      FindClose $0
    ${EndIf}
  ${EndIf}

  ${If} $GWBaseExisting == "1"
    StrCpy $GWBaseChoice "__existing__"
  ${Else}
    StrCpy $GWBaseChoice $GWBaseSuggested
  ${EndIf}
FunctionEnd

Function GWBasePageCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 42u "选择完整基础素材包（.gwcontent）。安装程序会先查找同目录文件，首次启动时检查并载入。"
  Pop $0
  ${NSD_CreateText} 0 47u 76% 16u "$GWBaseSuggested"
  Pop $GWBaseInput
  ${NSD_CreateButton} 79% 46u 21% 18u "浏览…"
  Pop $GWBaseBrowse
  ${NSD_OnClick} $GWBaseBrowse GWBaseBrowseClick
  ${NSD_CreateLabel} 0 72u 100% 44u "把基础素材包和安装程序放在同一文件夹，或点击浏览选择其他位置。安装过程不会下载资源。"
  Pop $GWBaseNote
  ${If} $GWBaseExisting == "1"
    ${NSD_CreateCheckbox} 0 124u 100% 20u "沿用这台电脑已有的基础资源配置"
    Pop $GWBaseKeep
    ${NSD_Check} $GWBaseKeep
  ${Else}
    StrCpy $GWBaseKeep ""
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function GWBaseBrowseClick
  nsDialogs::SelectFileDialog open "$EXEDIR\*.gwcontent" "基础素材包 (*.gwcontent)|*.gwcontent"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $GWBaseInput $0
    ${If} $GWBaseKeep != ""
      ${NSD_Uncheck} $GWBaseKeep
    ${EndIf}
  ${EndIf}
FunctionEnd

Function GWBasePageLeave
  ${If} $GWBaseKeep != ""
    ${NSD_GetState} $GWBaseKeep $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $GWBaseChoice "__existing__"
      Return
    ${EndIf}
  ${EndIf}
  ${NSD_GetText} $GWBaseInput $GWBaseChoice
  StrCpy $0 $GWBaseChoice 10 -10
  ${If} $GWBaseChoice == ""
  ${OrIf} $0 != ".gwcontent"
    MessageBox MB_ICONEXCLAMATION "请选择完整的 .gwcontent 基础素材包。"
    Abort
  ${EndIf}
  FileOpen $0 "$GWBaseChoice" r
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "所选素材包无法读取，请重新选择。"
    Abort
  ${EndIf}
  FileRead $0 $1
  FileClose $0
  ${If} $1 != "GWCONTENT1$\n"
    MessageBox MB_ICONEXCLAMATION "所选文件不是可识别的素材包，请重新选择。"
    Abort
  ${EndIf}
FunctionEnd
!endif
