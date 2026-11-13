param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('directory', 'file')]
    [string]$Kind,
    [AllowEmptyString()]
    [string]$InitialPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type -Path (Join-Path $PSScriptRoot 'common_item_dialog.cs')

$taskOwner = New-Object System.Windows.Forms.Form
$taskOwner.TopMost = $true
$taskOwner.ShowInTaskbar = $false
$taskOwner.StartPosition = 'CenterScreen'
$taskOwner.Size = New-Object System.Drawing.Size(1, 1)
$taskOwner.Opacity = 0

try {
    # Use one modern Explorer-style dialog for both folders and DB files.
    $taskOwner.Show()
    $taskOwner.Activate()
    $taskPath = [ModelRating.CommonItemDialog]::Choose($Kind, $InitialPath, $taskOwner.Handle)
    if ($taskPath) {
        @{path = $taskPath; kind = $Kind} | ConvertTo-Json -Compress
    } else {
        @{cancelled = $true} | ConvertTo-Json -Compress
    }
} finally {
    $taskOwner.Close()
    $taskOwner.Dispose()
}
