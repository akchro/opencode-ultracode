#!/usr/bin/env sh
# Installs opencode-ultracode into your global OpenCode config (~/.config/opencode). See install.ps1 for the details.
#   ./install.sh [--default-agent] [--uninstall]
set -eu
repo=$(cd "$(dirname "$0")" && pwd)
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
default_agent=0; uninstall=0
for a in "$@"; do case "$a" in --default-agent) default_agent=1 ;; --uninstall) uninstall=1 ;; esac; done
agents="ultra.md wf-worker.md wf-reviewer.md wf-operator.md"

if [ "$uninstall" = 1 ]; then
  rm -rf "$cfg/ultracode" "$cfg/plugins/ultracode.ts"
  for a in $agents; do rm -f "$cfg/agents/$a"; done
  for w in "$repo"/workflows/*.js; do rm -f "$cfg/workflows/$(basename "$w")"; done
  [ -f "$cfg/opencode.json" ] && sed -i.bak -E 's/[[:space:]]*"default_agent"[[:space:]]*:[[:space:]]*"ultra"[[:space:]]*,?//' "$cfg/opencode.json" && rm -f "$cfg/opencode.json.bak"
  echo "Removed opencode-ultracode from $cfg. Restart the OpenCode service: opencode service restart"
  exit 0
fi

mkdir -p "$cfg/ultracode" "$cfg/plugins" "$cfg/agents" "$cfg/workflows"
rm -rf "$cfg/ultracode/src" && cp -R "$repo/src" "$cfg/ultracode/src"
printf '// opencode-ultracode: the workflow engine plugin (%s)\nexport { default } from "../ultracode/src/plugin.ts"\n' "$repo" > "$cfg/plugins/ultracode.ts"
for a in $agents; do cp "$repo/agents/$a" "$cfg/agents/$a"; done
cp "$repo"/workflows/*.js "$cfg/workflows/"
if [ "$default_agent" = 1 ]; then
  if [ ! -f "$cfg/opencode.json" ]; then printf '{\n  "default_agent": "ultra"\n}\n' > "$cfg/opencode.json"
  elif grep -q '"default_agent"' "$cfg/opencode.json"; then sed -i.bak -E 's/"default_agent"[[:space:]]*:[[:space:]]*"[^"]*"/"default_agent": "ultra"/' "$cfg/opencode.json" && rm -f "$cfg/opencode.json.bak"
  else sed -i.bak '0,/{/s//{\n  "default_agent": "ultra",/' "$cfg/opencode.json" && rm -f "$cfg/opencode.json.bak"; fi
fi
echo "Installed opencode-ultracode into $cfg. Restart the OpenCode service so it loads the plugin: opencode service restart"
