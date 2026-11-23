[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath ".venv/Scripts/python.exe")) {
        throw "Python environment is missing. Run npm run setup first."
    }
    if (-not (Test-Path -LiteralPath "node_modules")) {
        throw "Node dependencies are missing. Run npm run setup first."
    }
    & ".venv/Scripts/python.exe" -X utf8 "$PSScriptRoot/dev.py"
    $resultCode = $LASTEXITCODE
}
finally {
    Pop-Location
}
exit $resultCode
