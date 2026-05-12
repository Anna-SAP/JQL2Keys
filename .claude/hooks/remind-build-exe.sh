#!/usr/bin/env bash
# Remind Claude to rebuild dist/JQL2Keys.exe after editing JQL2Keys source files.
# Reads PostToolUse hook input on stdin (JSON), emits a hookSpecificOutput
# reminder when a tracked source file was just modified.

set -euo pipefail

# Tracked files (basename match)
TRACKED='(jira-l10n-key-extractor\.html|JQL2Keys\.js|jira-cors-proxy\.js|package\.json)$'

input="$(cat)"
file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // ""')"

if [ -z "$file_path" ] || ! printf '%s' "$file_path" | grep -Eq "$TRACKED"; then
    exit 0
fi

# Only fire for files inside this repo
case "$file_path" in
    /home/user/JQL2Keys/*) ;;
    *) exit 0 ;;
esac

jq -nc --arg msg "You just edited a JQL2Keys source file ($file_path). Before ending this turn, rebuild the distributable EXE: \`cd /home/user/JQL2Keys && npm run build\` (outputs dist/JQL2Keys.exe). If you have several pending edits in the same turn, run it once at the end after all edits are complete." \
    '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$msg}}'
