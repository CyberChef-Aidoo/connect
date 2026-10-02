# Starts the portal about 30 seconds after this Windows user signs in.
# The task runs as this user, so it can read the storage folder.
# It does not run as SYSTEM and it does not start while nobody is signed in.
# Sign in once after a reboot, or leave this account signed in.

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not (Test-Path (Join-Path $repo "server\dist\index.js"))) {
    throw "Build the portal first: npm run build"
}
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "server\dist\index.js" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = "PT30S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask `
    -TaskName "SharedFilePortal" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Starts the shared file portal when this user signs in." `
    -Force | Out-Null
Write-Host "SharedFilePortal will start 30 seconds after $env:USERDOMAIN\$env:USERNAME signs in."
Write-Host "Remove it later with: Unregister-ScheduledTask -TaskName SharedFilePortal -Confirm:`$false"
