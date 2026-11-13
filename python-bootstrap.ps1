# Windows runtime discovery and private, verified Python download. No admin rights required.

function Test-SupportedPython {
    param([string]$Executable, [string[]]$PrefixArguments = @())
    $taskProbe = $null
    try {
        $taskProbeInfo = New-Object System.Diagnostics.ProcessStartInfo
        $taskProbeInfo.FileName = $Executable
        $taskProbeInfo.Arguments = (@($PrefixArguments) + @('-c', '"import sys, sqlite3, venv, ensurepip; sys.exit(0 if (3, 10) <= sys.version_info < (4,) else 1)"')) -join ' '
        $taskProbeInfo.UseShellExecute = $false
        $taskProbeInfo.CreateNoWindow = $true
        $taskProbeInfo.RedirectStandardOutput = $true
        $taskProbeInfo.RedirectStandardError = $true
        # The launcher must only discover installed runtimes during this probe.
        $taskProbeInfo.EnvironmentVariables.Remove('PYLAUNCHER_ALLOW_INSTALL')
        $taskProbeInfo.EnvironmentVariables.Remove('PYLAUNCHER_ALWAYS_INSTALL')
        $taskProbeInfo.EnvironmentVariables.Remove('PYLAUNCHER_DRYRUN')
        $taskProbeInfo.EnvironmentVariables['PYTHON_MANAGER_AUTOMATIC_INSTALL'] = 'false'
        $taskProbe = [System.Diagnostics.Process]::Start($taskProbeInfo)
        if (-not $taskProbe.WaitForExit(10000)) {
            $taskProbe.Kill()
            return $false
        }
        return ($taskProbe.ExitCode -eq 0)
    } catch {
        return $false
    } finally {
        if ($taskProbe) { $taskProbe.Dispose() }
    }
}

function Find-InstalledPython {
    # Inspect all PATH entries; skip Store aliases that can open an installer UI.
    foreach ($taskName in @('python.exe', 'python3.exe')) {
        foreach ($taskCommand in @(Get-Command $taskName -CommandType Application -All -ErrorAction SilentlyContinue)) {
            if ($taskCommand.Source -match '\\Microsoft\\WindowsApps\\') { continue }
            if (Test-SupportedPython -Executable $taskCommand.Source) {
                return [pscustomobject]@{ Executable = $taskCommand.Source; Arguments = @() }
            }
        }
    }
    # Standard installers register Python even when it was not added to PATH.
    foreach ($taskRegistryRoot in @('HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore', 'HKLM:\Software\WOW6432Node\Python\PythonCore')) {
        foreach ($taskVersionKey in @(Get-ChildItem -LiteralPath $taskRegistryRoot -ErrorAction SilentlyContinue)) {
            $taskInstallKey = Get-Item -LiteralPath ($taskVersionKey.PSPath + '\InstallPath') -ErrorAction SilentlyContinue
            if (-not $taskInstallKey) { continue }
            $taskExecutable = $taskInstallKey.GetValue('ExecutablePath')
            if (-not $taskExecutable) {
                $taskInstallDirectory = $taskInstallKey.GetValue('')
                if ($taskInstallDirectory) { $taskExecutable = Join-Path $taskInstallDirectory 'python.exe' }
            }
            if ($taskExecutable -and (Test-SupportedPython -Executable $taskExecutable)) {
                return [pscustomobject]@{ Executable = $taskExecutable; Arguments = @() }
            }
        }
    }
    foreach ($taskLauncher in @(Get-Command 'py.exe' -CommandType Application -All -ErrorAction SilentlyContinue)) {
        if ($taskLauncher.Source -match '\\Microsoft\\WindowsApps\\') { continue }
        if (Test-SupportedPython -Executable $taskLauncher.Source -PrefixArguments @('-3')) {
            return [pscustomobject]@{ Executable = $taskLauncher.Source; Arguments = @('-3') }
        }
    }
    return $null
}

function Receive-PythonArchive {
    param([string]$Url, [string]$Destination)
    $taskResponse = $null
    $taskInputStream = $null
    $taskOutputStream = $null
    try {
        $taskRequest = [Net.WebRequest]::Create($Url)
        $taskRequest.Timeout = 30000
        $taskRequest.ReadWriteTimeout = 120000
        $taskRequest.UserAgent = 'ModelRatingSystem/1.0'
        $taskRequest.KeepAlive = $false
        $taskResponse = $taskRequest.GetResponse()
        $taskInputStream = $taskResponse.GetResponseStream()
        $taskOutputStream = [IO.File]::Create($Destination)
        $taskInputStream.CopyTo($taskOutputStream)
    } finally {
        if ($taskOutputStream) { $taskOutputStream.Dispose() }
        if ($taskInputStream) { $taskInputStream.Dispose() }
        if ($taskResponse) { $taskResponse.Dispose() }
    }
}

function Get-ManagedPython {
    param(
        [string]$CacheRoot = (Join-Path $env:LOCALAPPDATA 'ModelRatingSystem\python'),
        [switch]$NoDownload
    )
    # Pinned full runtime ZIPs from the official Python install-manager index:
    # https://www.python.org/ftp/python/index-windows.json
    # Includes sqlite3, venv, ensurepip and VC runtime DLLs; this is not the embeddable ZIP.
    $taskVersion = '3.14.10'
    $taskArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($taskArchitecture.ToUpperInvariant()) {
        'AMD64' {
            $taskPlatform = 'amd64'
            $taskExpectedHash = 'cc28026a650970cc1570bb127312f1f9634eb67abfe157ae6ca1acbbc627d091'
        }
        'ARM64' {
            $taskPlatform = 'arm64'
            $taskExpectedHash = 'a7dae9a65d9ffb674d6f3c6d0476cdd10adc77876bb4426007684f8886ac2f77'
        }
        'X86' {
            $taskPlatform = 'win32'
            $taskExpectedHash = 'e1686e7cc076a53675510bba7ed715899f9bdbc6490d9bc238a8ed78f68d377d'
        }
        default { throw 'Automatic Python download is not supported for this CPU. Install a full Python 3.10+ and pass -Python C:\path\to\python.exe.' }
    }
    $taskRuntimeDirectory = Join-Path $CacheRoot ($taskVersion + '-' + $taskPlatform)
    $taskRuntimePython = Join-Path $taskRuntimeDirectory 'python.exe'
    if (Test-Path -LiteralPath $taskRuntimeDirectory) {
        if (Test-SupportedPython -Executable $taskRuntimePython) {
            Write-Host ('Using cached Python: ' + $taskRuntimePython)
            return $taskRuntimePython
        }
        throw ('The cached Python is unavailable. Move this folder aside and retry: ' + $taskRuntimeDirectory)
    }
    if ($NoDownload) {
        throw 'Python 3.10+ was not found and automatic download is disabled. Install Python or pass -Python C:\path\to\python.exe.'
    }
    if ([Environment]::OSVersion.Version -lt [Version]'10.0') {
        throw 'Automatic Python preparation requires Windows 10 or newer. Install a Python version compatible with this system manually.'
    }
    New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
    # A short temporary path also works with Windows PowerShell 5.1's ZIP APIs.
    $taskTempRoot = [IO.Path]::GetTempPath()
    $taskStageDirectory = Join-Path $taskTempRoot ('mrpy-' + [guid]::NewGuid().ToString('N').Substring(0, 12))
    New-Item -ItemType Directory -Path $taskStageDirectory | Out-Null
    $taskZipPath = Join-Path $taskStageDirectory 'python.zip'
    $taskExtractDirectory = Join-Path $taskStageDirectory 'runtime'
    $taskUrl = 'https://www.python.org/ftp/python/' + $taskVersion + '/python-' + $taskVersion + '-' + $taskPlatform + '.zip'
    $taskOldSecurityProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        Write-Host 'No usable Python 3.10+ found. Preparing a private Python runtime for this user.'
        Write-Host ('Downloading Python ' + $taskVersion + ' from python.org (about 32 MB)...')
        Write-Host ('Runtime cache: ' + $taskRuntimeDirectory)
        [Net.ServicePointManager]::SecurityProtocol = $taskOldSecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        for ($taskAttempt = 1; $taskAttempt -le 3; $taskAttempt++) {
            try {
                Receive-PythonArchive -Url $taskUrl -Destination $taskZipPath
                break
            } catch {
                if ($taskAttempt -eq 3) { throw }
                Write-Host ('Download interrupted. Retrying (' + ($taskAttempt + 1) + '/3)...')
                Start-Sleep -Seconds 1
            }
        }
        Write-Host 'Verifying the Python download (SHA256)...'
        $taskHasher = [Security.Cryptography.SHA256]::Create()
        $taskZipStream = [IO.File]::OpenRead($taskZipPath)
        try {
            $taskActualHash = [BitConverter]::ToString($taskHasher.ComputeHash($taskZipStream)).Replace('-', '').ToLowerInvariant()
        } finally {
            $taskZipStream.Dispose()
            $taskHasher.Dispose()
        }
        if ($taskActualHash -ne $taskExpectedHash) { throw 'The Python download failed SHA256 verification. It will not be used.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($taskZipPath, $taskExtractDirectory)
        if (-not (Test-SupportedPython -Executable (Join-Path $taskExtractDirectory 'python.exe'))) {
            throw 'The downloaded Python cannot run or is missing required standard-library components.'
        }
        if (Test-Path -LiteralPath $taskRuntimeDirectory) {
            if (-not (Test-SupportedPython -Executable $taskRuntimePython)) { throw 'Another startup created an incomplete runtime. Close other startup windows and retry.' }
        } else {
            Move-Item -LiteralPath $taskExtractDirectory -Destination $taskRuntimeDirectory
        }
        Write-Host 'Python runtime ready.'
        return $taskRuntimePython
    } catch {
        throw ('Cannot prepare Python automatically: ' + $_.Exception.Message + ' Check access to https://www.python.org and retry start.bat, or install a full Python 3.10+ and pass -Python C:\path\to\python.exe.')
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $taskOldSecurityProtocol
        # Only remove the unique staging folder created by this invocation.
        $taskTempPrefix = [IO.Path]::GetFullPath($taskTempRoot).TrimEnd('\') + '\'
        $taskStageFullPath = [IO.Path]::GetFullPath($taskStageDirectory)
        if ($taskStageFullPath.StartsWith($taskTempPrefix, [StringComparison]::OrdinalIgnoreCase) -and
            ([IO.Path]::GetFileName($taskStageFullPath) -match '^mrpy-[a-f0-9]{12}$') -and
            (Test-Path -LiteralPath $taskStageFullPath)) {
            Remove-Item -LiteralPath $taskStageFullPath -Recurse -Force
        }
    }
}
