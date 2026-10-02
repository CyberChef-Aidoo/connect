# Allows the portal port on Private networks only.
# It does not turn the firewall off, does not allow Public networks,
# and does not open any port on your router.
# Run this in an Administrator PowerShell window.

$ErrorActionPreference = "Stop"
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $admin) {
    throw "Open PowerShell with 'Run as administrator' and run this script again."
}

$port = 8443
$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) ".env"
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') {
            $port = [int]$Matches[1]
        }
    }
}

Get-NetFirewallRule -DisplayName "Shared File Portal" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule `
    -DisplayName "Shared File Portal" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $port `
    -Profile Private | Out-Null

Write-Host "Allowed inbound TCP $port on the Private firewall profile only."
Write-Host "Confirm this PC's network is Private, not Public:"
Write-Host "Get-NetConnectionProfile"
Write-Host "A home or office network should be Private. Leave a cafe or guest network Public; the rule will not apply there."
