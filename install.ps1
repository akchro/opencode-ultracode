<#
.SYNOPSIS
  Installs opencode-ultracode into your global OpenCode config (~/.config/opencode).
.DESCRIPTION
  Copies src/ to <config>/ultracode/src, writes the plugin shim <config>/plugins/ultracode.ts, copies the agents
  (ultra, wf-worker, wf-reviewer) to <config>/agents and the saved workflows to <config>/workflows.
  -DefaultAgent also sets "default_agent": "ultra" in <config>/opencode.json (every new session starts in ultracode).
  -Uninstall removes everything this script installed (and the default_agent line if it is "ultra").
  Restart the OpenCode background service afterwards (opencode service restart) so it loads the plugin.
#>
param([switch]$DefaultAgent, [switch]$Uninstall)
$ErrorActionPreference = "Stop"
$repo = $PSScriptRoot
$base = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
$cfg = Join-Path $base "opencode"
$agents = "ultra.md", "wf-worker.md", "wf-reviewer.md", "wf-operator.md"
$workflows = Get-ChildItem (Join-Path $repo "workflows") -Filter *.js | ForEach-Object Name

function Write-Lf($path, $text) {
  New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
  [System.IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"), (New-Object System.Text.UTF8Encoding $false))
}

function Set-DefaultAgent($on) {
  $json = Join-Path $cfg "opencode.json"
  if (-not (Test-Path $json)) { if ($on) { Write-Lf $json "{`n  `"default_agent`": `"ultra`"`n}`n" }; return }
  $text = [System.IO.File]::ReadAllText($json)
  if ($on) {
    if ($text -match '"default_agent"\s*:') { $text = $text -replace '"default_agent"\s*:\s*"[^"]*"', '"default_agent": "ultra"' }
    else { $text = $text -replace '^\s*\{', "{`n  `"default_agent`": `"ultra`"," }
  } else {
    $text = $text -replace '\s*"default_agent"\s*:\s*"ultra"\s*,?', ''
  }
  Write-Lf $json $text
}

if ($Uninstall) {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $cfg "ultracode"), (Join-Path $cfg "plugins\ultracode.ts")
  foreach ($a in $agents) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $cfg "agents\$a") }
  foreach ($w in $workflows) { Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $cfg "workflows\$w") }
  Set-DefaultAgent $false
  Write-Host "Removed opencode-ultracode from $cfg. Restart the OpenCode service: opencode service restart"
  return
}

$dest = Join-Path $cfg "ultracode"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $dest "src")
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item -Recurse (Join-Path $repo "src") $dest
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $dest "tools")
Copy-Item -Recurse (Join-Path $repo "tools") $dest
Write-Lf (Join-Path $cfg "plugins\ultracode.ts") "// opencode-ultracode: the workflow engine plugin ($repo)`nexport { default } from `"../ultracode/src/plugin.ts`"`n"
foreach ($a in $agents) { Write-Lf (Join-Path $cfg "agents\$a") ([System.IO.File]::ReadAllText((Join-Path $repo "agents\$a"))) }
foreach ($w in $workflows) { Write-Lf (Join-Path $cfg "workflows\$w") ([System.IO.File]::ReadAllText((Join-Path $repo "workflows\$w"))) }
if ($DefaultAgent) { Set-DefaultAgent $true }

Write-Host "Installed opencode-ultracode into $cfg"
Write-Host "  plugin    plugins\ultracode.ts -> ultracode\src\plugin.ts"
Write-Host "  agents    $($agents -join ', ')"
Write-Host "  workflows $($workflows -join ', ')"
if ($DefaultAgent) { Write-Host "  default_agent = ultra" } else { Write-Host "  (use /ultracode in a session, Tab to the ultra agent, or re-run with -DefaultAgent)" }
Write-Host "Restart the OpenCode service so it loads the plugin: opencode service restart"
