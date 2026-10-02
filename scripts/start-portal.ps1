$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path ".\server\dist\index.js")) {
    throw "The portal is not built yet. From this folder run: npm run build"
}
if (-not (Test-Path ".\.env")) {
    throw "Copy .env.example to .env and edit it before starting."
}
npm start
