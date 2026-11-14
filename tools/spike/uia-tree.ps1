# Windows UI Automation tree for the installed Mona build.
#
# Narrator and other assistive technology read the app through UI Automation,
# not through the DOM. This probe records what that layer actually exposes, so a
# DOM-only accessibility pass cannot be mistaken for a Narrator pass.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/spike/uia-tree.ps1 -Out docs/evidence/W20-uia.json
#
# It launches the installed executable with a throwaway profile, reads the tree,
# then stops only the process it started. It does not change display or audio
# settings and does not start Narrator.
param(
  [string]$Exe = (Join-Path $env:LOCALAPPDATA 'Programs\Mona\Mona.exe'),
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ExtraArgument = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not (Test-Path $Exe)) { throw "executable not found: $Exe" }
$OutPath = [System.IO.Path]::GetFullPath($Out)
$OutDir = Split-Path -Parent $OutPath
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }

$profileDir = Join-Path $env:TEMP ("mona-uia-" + [guid]::NewGuid().ToString('N'))
$env:MONA_USER_DATA = $profileDir
$arguments = @()
if ($ExtraArgument) { $arguments += $ExtraArgument }
$proc = if ($arguments.Count -gt 0) {
  Start-Process -FilePath $Exe -ArgumentList $arguments -PassThru
} else {
  Start-Process -FilePath $Exe -PassThru
}
try {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $window = $null
  for ($attempt = 0; $attempt -lt 30 -and -not $window; $attempt++) {
    Start-Sleep -Milliseconds 500
    $children = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
      if ($child.Current.Name -eq 'Mona') { $window = $child; break }
    }
  }
  if (-not $window) { throw 'the Mona window never appeared' }
  # Chromium builds the tree asynchronously after the first UIA query; a short
  # settle keeps a first-attempt empty result from being recorded as empty.
  Start-Sleep -Seconds 2
  $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $elements = foreach ($element in $all) {
    $current = $element.Current
    [ordered]@{
      type = $current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      name = $current.Name
      automationId = $current.AutomationId
      focusable = [bool]$current.IsKeyboardFocusable
      enabled = [bool]$current.IsEnabled
    }
  }
  $dpi = (Get-ItemProperty 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction SilentlyContinue).AppliedDPI
  Add-Type -AssemblyName System.Windows.Forms
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
      [ordered]@{ device = $_.DeviceName; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = [bool]$_.Primary }
    })
  $report = [ordered]@{
    capturedUtc = (Get-Date).ToUniversalTime().ToString('o')
    executable = $Exe
    extraArgument = $ExtraArgument
    osScaling = [ordered]@{
      appliedDpi = $dpi
      scalePercent = if ($dpi) { [math]::Round($dpi / 96 * 100) } else { $null }
      note = 'AppliedDPI is the real Windows scaling setting; browser zoom is not this'
    }
    screens = $screens
    windowName = $window.Current.Name
    windowClass = $window.Current.ClassName
    descendantCount = $all.Count
    namedElements = @($elements | Where-Object { $_.name -or $_.automationId })
    elements = @($elements)
  }
  $report | ConvertTo-Json -Depth 6 | Set-Content -Path $OutPath -Encoding utf8
  "wrote $($all.Count) UIA elements to $OutPath"
} finally {
  if (-not $proc.HasExited) { $proc | Stop-Process -Force }
  Remove-Item $profileDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:MONA_USER_DATA -ErrorAction SilentlyContinue
}
