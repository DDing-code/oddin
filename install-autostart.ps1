# 로그온 시 AI Hub 를 숨김 창으로 자동 시작하는 예약 작업 등록 / 해제
#   등록: powershell -ExecutionPolicy Bypass -File install-autostart.ps1
#   해제: powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Remove
param([switch]$Remove)
$name = 'AI Hub (Claude+Codex)'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue; Write-Host "해제됨: $name"; exit }
$vbs = Join-Path $PSScriptRoot 'start-hub-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`"" -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "등록됨: $name (로그온 시 숨김 실행). 지금 시작하려면: wscript `"$vbs`""
