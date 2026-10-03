' AI Hub 서버를 창 없이 백그라운드로 시작한다. 로그: logs\server.log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
If Not fso.FolderExists(dir & "\logs") Then fso.CreateFolder(dir & "\logs")
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.mjs >> ""logs\server.log"" 2>&1", 0, False
