# Starts the portal when Windows starts, including before anyone signs in to the desktop.
# S4U runs as this user without storing a password. The task can read local files.
# It does not receive network credentials, and it does not run as SYSTEM.
# Use scripts/register-logon-task.ps1 instead when the portal should wait for a sign-in.

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $repo "server\dist\index.js"))) {
    throw "Build the portal first: npm run build"
}
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "server\dist\index.js" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT30S"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask `
    -TaskName "SharedFilePortalService" `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the shared file portal at Windows startup, without a desktop sign-in." `
    -Force | Out-Null
Write-Host "SharedFilePortalService will start 30 seconds after Windows starts, as $env:USERDOMAIN\$env:USERNAME."
Write-Host "Remove it later with: Unregister-ScheduledTask -TaskName SharedFilePortalService -Confirm:`$false"
