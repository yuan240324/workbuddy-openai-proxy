' Hidden-window launcher for the WorkBuddy proxy (called by the desktop shortcut).
' Server output goes to server.log in this folder.
Option Explicit
Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.mjs >> server.log 2>&1", 0, False
