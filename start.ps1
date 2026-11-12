param(
    [string]$Python = "",
    [string]$Models = "",
    [string]$Port = "",
    [switch]$NoBrowser,
    [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Set-Location -LiteralPath $PSScriptRoot
$taskVenvPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'

function Test-SupportedPython {
    param([string]$Executable, [string[]]$PrefixArguments = @())
    try {
        & $Executable @PrefixArguments -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $taskVenvPython)) {
    $taskInterpreter = ''
    $taskInterpreterArguments = @()
    if ($Python) {
        if (-not (Test-SupportedPython -Executable $Python)) {
            throw 'The specified Python cannot run or is older than 3.10. See the startup dependency checklist.'
        }
        $taskInterpreter = $Python
    } else {
        foreach ($taskCandidate in @('py', 'python', 'python3')) {
            $taskCommand = Get-Command $taskCandidate -ErrorAction SilentlyContinue
            if (-not $taskCommand) { continue }
            $taskPrefix = @()
            if ($taskCandidate -eq 'py') { $taskPrefix = @('-3') }
            if (Test-SupportedPython -Executable $taskCommand.Source -PrefixArguments $taskPrefix) {
                $taskInterpreter = $taskCommand.Source
                $taskInterpreterArguments = $taskPrefix
                break
            }
        }
    }
    if (-not $taskInterpreter) {
        throw 'Python 3.10+ was not found. Install Python with pip and venv, or pass -Python C:\path\to\python.exe. See the startup dependency checklist.'
    }
    & $taskInterpreter @taskInterpreterArguments -m venv .venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $taskVenvPython)) {
        throw 'Cannot create .venv. Install a full Python 3.10+ distribution with pip and venv.'
    }
}

if (-not (Test-SupportedPython -Executable $taskVenvPython)) {
    throw 'The existing .venv is unavailable or uses Python older than 3.10. Move .venv aside and rerun with -Python C:\path\to\python.exe.'
}

# Check imports and pinned versions, including when an existing environment is reused.
$taskRequirementFile = Join-Path $PSScriptRoot 'requirements.txt'
$taskHasher = [System.Security.Cryptography.SHA256]::Create()
try {
    $taskRequirementHash = [System.BitConverter]::ToString(
        $taskHasher.ComputeHash([System.IO.File]::ReadAllBytes($taskRequirementFile))
    ).Replace('-', '')
} finally {
    $taskHasher.Dispose()
}
$taskMarkerFile = Join-Path $PSScriptRoot '.venv\requirements.sha256'
$taskInstalledHash = if (Test-Path -LiteralPath $taskMarkerFile) { (Get-Content -LiteralPath $taskMarkerFile -Raw).Trim() } else { '' }
$taskRuntimeCheck = @'
import sys
try:
    import sqlite3, sqlalchemy, openpyxl
    from importlib.metadata import version
    from pathlib import Path
    for line in Path(sys.argv[1]).read_text(encoding='utf-8-sig').splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        name, expected = line.split('==', 1)
        if version(name.strip()) != expected.strip():
            raise ValueError('Dependency version mismatch')
except Exception:
    sys.exit(1)
'@
& $taskVenvPython -c $taskRuntimeCheck $taskRequirementFile
$taskRuntimeReady = $LASTEXITCODE -eq 0
if ($taskInstalledHash -ne $taskRequirementHash -or -not $taskRuntimeReady) {
    & $taskVenvPython -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('pip') else 1)"
    if ($LASTEXITCODE -ne 0) {
        & $taskVenvPython -m ensurepip --upgrade
        if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare pip. See the startup dependency checklist.' }
    }
    & $taskVenvPython -m pip install -r $taskRequirementFile
    if ($LASTEXITCODE -ne 0) { throw 'Cannot install requirements. Check the network and retry.' }
    & $taskVenvPython -c $taskRuntimeCheck $taskRequirementFile
    if ($LASTEXITCODE -ne 0) { throw 'Dependency verification failed. See requirements.txt and the startup dependency checklist.' }
    Set-Content -LiteralPath $taskMarkerFile -Value $taskRequirementHash -Encoding ascii
}

& $taskVenvPython -c "import sys, sqlalchemy, openpyxl; print('Python ' + sys.version.split()[0]); print('SQLAlchemy ' + sqlalchemy.__version__ + ', openpyxl ' + openpyxl.__version__)"
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the prepared runtime.' }
if ($CheckOnly) {
    Write-Host 'Environment ready. Run start.bat to launch the application.'
    exit 0
}

$taskArguments = @((Join-Path $PSScriptRoot 'app.py'))
if ($Models) { $taskArguments += @('--models', $Models) }
if ($Port) { $taskArguments += @('--port', $Port) }
if ($NoBrowser) { $taskArguments += '--no-browser' }
& $taskVenvPython -X utf8 @taskArguments
exit $LASTEXITCODE
