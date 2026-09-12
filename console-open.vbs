' 供桌面快捷方式调用：隐藏窗口运行 console-open.mjs（避免闪黑框）
Option Explicit
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node console-open.mjs >> console.log 2>&1", 0, False
