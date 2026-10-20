<#
.SYNOPSIS
  Brings a Roblox Studio window to the front so its viewport renders (real input and screen captures need that).
.DESCRIPTION
  Windows refuses SetForegroundWindow to a background process unless the last input came from it, so the script first
  presses and releases Alt (the trick that worked for the ac-combat sessions), then restores, raises and focuses the
  first Studio window whose title contains -Title. A game that binds Alt (ac-combat frees its cursor on an Alt tap)
  sees that tap: undo what it toggled.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File studio-front.ps1 -Title "brick-building.rbxl"
#>
param([string]$Title = "Roblox Studio")
$ErrorActionPreference = "Stop"
Add-Type -Namespace UC -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@
$win = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" -and $_.MainWindowTitle -like "*Roblox Studio*" } | Select-Object -First 1
if (-not $win) { Write-Output "NOT FOUND: no Roblox Studio window titled like '*$Title*'"; exit 2 }
$h = $win.MainWindowHandle
[UC.Win]::keybd_event(0x12, 0, 0, [System.UIntPtr]::Zero)   # Alt down
[UC.Win]::keybd_event(0x12, 0, 2, [System.UIntPtr]::Zero)   # Alt up
if ([UC.Win]::IsIconic($h)) { [void][UC.Win]::ShowWindow($h, 9) } else { [void][UC.Win]::ShowWindow($h, 5) }
[void][UC.Win]::BringWindowToTop($h)
$ok = [UC.Win]::SetForegroundWindow($h)
Write-Output ("FRONT: '{0}' (pid {1}) foreground={2}" -f $win.MainWindowTitle, $win.Id, $ok)
