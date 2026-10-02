# Creates a certificate for the file portal on this computer.
# Other computers trust the .cer file. They do not get a copy of the private key.
# Run from a normal PowerShell window. Do not email the .pfx file.

param(
    [Parameter(Mandatory = $true)]
    [string]$LanIp,
    [string]$DnsName = "fileportal.local",
    [string]$OutDir = "data\certs"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cert = New-SelfSignedCertificate `
    -Type SSLServerAuthentication `
    -Subject "CN=$DnsName" `
    -DnsName $DnsName, "localhost", $LanIp `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddYears(2) `
    -FriendlyName "Shared File Portal ($DnsName)"

$passphrase = Read-Host "Certificate passphrase" -AsSecureString
if ($passphrase.Length -lt 1) {
    throw "A passphrase is required. It goes in HTTPS_PFX_PASSPHRASE and is not a user password."
}

$pfx = Join-Path $OutDir "portal.pfx"
$cer = Join-Path $OutDir "portal.cer"
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $passphrase | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null

Write-Host ""
Write-Host "Private key (keep this on the server only): $pfx"
Write-Host "Public certificate (copy this to each other computer): $cer"
Write-Host "Put these lines in .env:"
Write-Host "HOST=0.0.0.0"
Write-Host "PORT=8443"
Write-Host "HTTPS_PFX_PATH=$pfx"
Write-Host "HTTPS_PFX_PASSPHRASE=<the passphrase you just typed>"
Write-Host ""
Write-Host "Trust the certificate on THIS computer:"
Write-Host "Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root"
Write-Host ""
Write-Host "On each other computer, copy only portal.cer and run that same import."
Write-Host "Then open https://${LanIp}:8443"
Write-Host "If the browser warns you, stop. Do not click through the warning."
