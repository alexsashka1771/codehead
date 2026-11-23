[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    # npm ci replaces the embedded binaries; Windows locks their DLLs while PostgreSQL runs.
    $localData = Join-Path $projectRoot ".data/postgres"
    $pgCtl = Join-Path $projectRoot "node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe"
    if (Test-Path -LiteralPath (Join-Path $localData "PG_VERSION")) {
        if (Test-Path -LiteralPath $pgCtl) {
            & $pgCtl status -D $localData
            $postgresStatus = $LASTEXITCODE
            if ($postgresStatus -eq 0) {
                & $pgCtl stop -D $localData -m fast -w -t 30
                if ($LASTEXITCODE -ne 0) { throw "Could not stop the project's PostgreSQL cluster. Data was retained." }
            }
            elseif ($postgresStatus -ne 3) {
                throw "Could not inspect the project's PostgreSQL cluster. Stop it before setup."
            }
        }
        elseif (Test-Path -LiteralPath (Join-Path $localData "postmaster.pid")) {
            throw "Local PostgreSQL may be running but pg_ctl is missing. Restore its pinned binaries before setup; do not delete the data folder."
        }
    }
    if (-not (Test-Path -LiteralPath ".venv/Scripts/python.exe")) {
        & python -m venv ".venv"
        if ($LASTEXITCODE -ne 0) { throw "Could not create the Python environment." }
    }
    & ".venv/Scripts/python.exe" -m pip install --cache-dir ".data/pip-cache" -r "requirements.lock"
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed." }
    & ".venv/Scripts/python.exe" -m pip install --no-deps --no-build-isolation -e "."
    if ($LASTEXITCODE -ne 0) { throw "CodeHead package installation failed." }
    & npm.cmd ci --cache ".data/npm-cache" --prefer-offline
    if ($LASTEXITCODE -ne 0) { throw "Node dependency installation failed." }
    & node "tools/contracts.mjs" --check
    if ($LASTEXITCODE -ne 0) { throw "Contract verification failed." }
    & node "node_modules/@playwright/test/cli.js" install chromium
    if ($LASTEXITCODE -ne 0) { throw "Browser installation failed." }
    Write-Output "Setup complete. Start CodeHead with npm run dev."
}
finally {
    Pop-Location
}
