# Run with Windows PowerShell 5.1 after the fresh-start integration check.
param(
    [Parameter(Mandatory = $true)][string]$Python,
    [Parameter(Mandatory = $true)][string]$WorkRoot,
    [Parameter(Mandatory = $true)][string]$PreparedCache
)
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path $PSScriptRoot -Parent) 'python-bootstrap.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
    Write-Host ('PASS: ' + $Message)
}

Assert-True (Test-SupportedPython -Executable $Python) 'A complete supported Python is accepted.'
Assert-True (-not (Test-SupportedPython -Executable (Join-Path $WorkRoot 'missing-python.exe'))) 'A missing interpreter is rejected.'
$taskOriginalPath = $env:PATH
try {
    $env:PATH = (Split-Path $Python -Parent) + ';' + $env:SystemRoot + '\System32'
    $taskFound = Find-InstalledPython
    Assert-True ($taskFound.Executable -eq $Python) 'An installed Python is found without downloading.'
} finally {
    $env:PATH = $taskOriginalPath
}

$taskNoDownloadCache = Join-Path $WorkRoot 'no-download-cache'
$taskFailure = ''
try { Get-ManagedPython -CacheRoot $taskNoDownloadCache -NoDownload | Out-Null } catch { $taskFailure = $_.Exception.Message }
Assert-True ($taskFailure -like '*automatic download is disabled*') 'NoDownload fails clearly when Python is absent.'
Assert-True (-not (Test-Path -LiteralPath $taskNoDownloadCache)) 'NoDownload creates no runtime directory.'

$taskRealDownload = (Get-Item Function:Receive-PythonArchive).ScriptBlock
$taskTempRoot = [IO.Path]::GetTempPath()
$taskStagesBefore = @(Get-ChildItem -LiteralPath $taskTempRoot -Directory -Filter 'mrpy-*' | ForEach-Object FullName)
try {
    function Receive-PythonArchive {
        param([string]$Url, [string]$Destination)
        [IO.File]::WriteAllText($Destination, 'deliberately corrupt download')
    }
    $taskBadHashCache = Join-Path $WorkRoot 'bad-hash-cache'
    $taskFailure = ''
    try { Get-ManagedPython -CacheRoot $taskBadHashCache | Out-Null } catch { $taskFailure = $_.Exception.Message }
    Assert-True ($taskFailure -like '*failed SHA256 verification*') 'A corrupt download is rejected before extraction or execution.'
    Assert-True (@(Get-ChildItem -LiteralPath $taskBadHashCache -Force).Count -eq 0) 'A corrupt download leaves no installed runtime.'

    function Receive-PythonArchive {
        param([string]$Url, [string]$Destination)
        throw 'simulated network interruption'
    }
    $taskFailure = ''
    try { Get-ManagedPython -CacheRoot (Join-Path $WorkRoot 'network-failure-cache') | Out-Null } catch { $taskFailure = $_.Exception.Message }
    Assert-True ($taskFailure -like '*simulated network interruption*retry start.bat*') 'A network failure explains how to retry.'

    $taskCachedPython = Get-ManagedPython -CacheRoot $PreparedCache -NoDownload
    Assert-True (Test-Path -LiteralPath $taskCachedPython) 'A prepared cache is reused without a download.'

    $taskBrokenCache = Join-Path $WorkRoot 'broken-cache'
    $taskBrokenVersion = Join-Path $taskBrokenCache (Split-Path (Split-Path $taskCachedPython -Parent) -Leaf)
    New-Item -ItemType Directory -Path $taskBrokenVersion | Out-Null
    $taskKeepFile = Join-Path $taskBrokenVersion 'keep.txt'
    [IO.File]::WriteAllText($taskKeepFile, 'keep existing data')
    $taskFailure = ''
    try { Get-ManagedPython -CacheRoot $taskBrokenCache | Out-Null } catch { $taskFailure = $_.Exception.Message }
    Assert-True ($taskFailure -like '*cached Python is unavailable*') 'An invalid existing cache reports a repair action.'
    Assert-True (Test-Path -LiteralPath $taskKeepFile) 'An existing invalid cache is preserved.'
} finally {
    Set-Item Function:Receive-PythonArchive -Value $taskRealDownload
}
$taskNewStages = @(Get-ChildItem -LiteralPath $taskTempRoot -Directory -Filter 'mrpy-*' | Where-Object { $_.FullName -notin $taskStagesBefore })
Assert-True ($taskNewStages.Count -eq 0) 'Failed downloads clean up their temporary staging folders.'
Write-Host 'Windows Python bootstrap checks passed.'
