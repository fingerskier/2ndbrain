#!/bin/bash
# validate-command.sh -- PreToolUse hook for Bash command whitelist enforcement
# Spec reference: section 13.2 Claude Subprocess Hooks - Command Whitelist Enforcement
#
# Invoked by claude-cli as a PreToolUse hook when the Bash tool is used.
# Reads JSON from stdin, extracts tool_input.command, and decides whether to
# allow or block the command.
#
# Exit codes:
#   0 = allow the command
#   2 = block the command (stdout contains JSON: { "reason": "..." })
#
# Environment variables:
#   COMMANDS_WHITELIST  - Comma-separated glob-style patterns of allowed commands
#   FILE_EDIT_PATHS     - Comma-separated absolute paths where file writes are allowed
#   HOME                - User home directory (writes always allowed here)
#   DATABASE_URL        - If set, blocked attempts are logged to system_logs via psql

set -uo pipefail

###############################################################################
# Read JSON input from stdin
###############################################################################
INPUT=$(cat)

###############################################################################
# Extract the command string from tool_input.command
#
# Primary: use jq for reliable JSON parsing.
# Fallback: sed-based extraction when jq is not available.
###############################################################################
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
else
  # Fallback: sed-based extraction. Handles basic JSON escaping (\" and \\).
  # Complex multi-line or deeply nested JSON values are not expected from
  # claude-cli's Bash tool_input.
  COMMAND=$(printf '%s' "$INPUT" \
    | tr '\n' ' ' \
    | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//' \
    | sed 's/"[[:space:]]*[,}].*//' \
    | sed 's/\\"/"/g; s/\\\\/\\/g')
fi

if [ -z "$COMMAND" ]; then
  printf '{"reason":"Could not extract command from hook input"}\n'
  exit 2
fi

###############################################################################
# Helper: log a blocked command to system_logs via psql
#
# Only runs when DATABASE_URL is set. Failures are silent -- logging must
# never prevent the block decision from being communicated to the caller.
###############################################################################
log_blocked() {
  local reason="$1"

  if [ -z "${DATABASE_URL:-}" ]; then
    return
  fi

  # Sanitize for SQL string literals (escape single quotes)
  local safe_cmd
  safe_cmd=$(printf '%s' "$COMMAND" | sed "s/'/''/g" | tr -d '\000-\037')
  local safe_reason
  safe_reason=$(printf '%s' "$reason" | sed "s/'/''/g" | tr -d '\000-\037')

  psql "$DATABASE_URL" -q -c \
    "INSERT INTO system_logs (level, source, content) VALUES ('warn', 'validate-command', 'BLOCKED: ${safe_reason} | command: ${safe_cmd}')" \
    >/dev/null 2>&1 || true
}

###############################################################################
# Helper: block a command with a reason
#   - Outputs JSON reason to stdout (for claude-cli)
#   - Outputs structured log entry to stderr (for parent process capture)
#   - Logs to system_logs via psql if DATABASE_URL is set
###############################################################################
block() {
  local reason="$1"

  # Sanitize the command for safe JSON embedding (escape backslashes, quotes,
  # and control characters to prevent injection into the JSON output).
  local safe_cmd
  safe_cmd=$(printf '%s' "$COMMAND" \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | tr -d '\000-\037')
  local safe_reason
  safe_reason=$(printf '%s' "$reason" \
    | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | tr -d '\000-\037')

  # stdout: JSON for claude-cli to read
  printf '{"reason":"%s"}\n' "$safe_reason"

  # stderr: structured log for the parent Node.js process
  printf '{"event":"command_blocked","command":"%s","reason":"%s"}\n' \
    "$safe_cmd" "$safe_reason" >&2

  # Persist to database (fire-and-forget)
  log_blocked "$reason" &

  exit 2
}

###############################################################################
# Helper: check if command matches any COMMANDS_WHITELIST pattern
#
# Patterns are glob-style. A pattern matches if the full command string starts
# with the pattern (or the pattern equals the first word of the command).
###############################################################################
matches_whitelist() {
  local cmd="$1"

  if [ -z "${COMMANDS_WHITELIST:-}" ]; then
    return 1
  fi

  # Save and restore IFS
  local old_ifs="$IFS"
  IFS=','
  # shellcheck disable=SC2086
  set -- $COMMANDS_WHITELIST
  IFS="$old_ifs"

  for pattern in "$@"; do
    # Trim leading/trailing whitespace
    pattern=$(printf '%s' "$pattern" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$pattern" ] && continue

    # Glob-style match: pattern matches the whole command or its prefix
    # shellcheck disable=SC2254
    case "$cmd" in
      $pattern) return 0 ;;
      $pattern\ *) return 0 ;;
      $pattern\;*) return 0 ;;
      $pattern\|*) return 0 ;;
      $pattern\&*) return 0 ;;
    esac
  done

  return 1
}

###############################################################################
# Helper: check if an absolute path falls within a system directory
#   /etc, /usr, /boot, /sys, /proc -- always blocked per spec section 14.5
###############################################################################
is_system_dir() {
  local p="$1"
  case "$p" in
    /etc|/etc/*) return 0 ;;
    /usr|/usr/*) return 0 ;;
    /boot|/boot/*) return 0 ;;
    /sys|/sys/*) return 0 ;;
    /proc|/proc/*) return 0 ;;
    *) return 1 ;;
  esac
}

###############################################################################
# Helper: check if a path is within allowed write directories
#   - Home directory (~, $HOME) is always allowed
#   - Paths listed in FILE_EDIT_PATHS are allowed
#   - System directories are never allowed (checked separately)
###############################################################################
path_is_allowed() {
  local target_path="$1"
  local home_dir="${HOME:-/home/$(whoami)}"

  # Always allow writes within home directory
  case "$target_path" in
    "$home_dir"|"$home_dir"/*) return 0 ;;
    "~"|"~/"*) return 0 ;;
    "."*|[^/]*) return 0 ;;  # Relative paths resolve under cwd (within home)
  esac

  # Check FILE_EDIT_PATHS
  if [ -n "${FILE_EDIT_PATHS:-}" ]; then
    local old_ifs="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    set -- $FILE_EDIT_PATHS
    IFS="$old_ifs"

    for allowed_path in "$@"; do
      allowed_path=$(printf '%s' "$allowed_path" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
      [ -z "$allowed_path" ] && continue
      case "$target_path" in
        "$allowed_path"|"$allowed_path"/*) return 0 ;;
      esac
    done
  fi

  return 1
}

###############################################################################
# Helper: detect file-write targets in a command and validate paths
#
# Inspects output redirection (>, >>), and common write commands (cp, mv, tee,
# dd, rsync, mkdir, touch) for absolute-path targets. Blocks if the target is
# a system directory or outside allowed paths.
###############################################################################
check_write_targets() {
  local cmd="$1"

  # -- Output redirection targets (> /path, >> /path) --
  local redirect_targets
  redirect_targets=$(printf '%s' "$cmd" | grep -oE '>>?\s*/[^ ;|&)]+' | sed 's/>>*[[:space:]]*//' || true)

  for target in $redirect_targets; do
    [ -z "$target" ] && continue
    case "$target" in
      /dev/null|/dev/stdout|/dev/stderr) continue ;;
    esac
    if is_system_dir "$target"; then
      block "Writing to system directory is not allowed: ${target}"
    fi
    if ! path_is_allowed "$target"; then
      block "File write to ${target} is outside allowed paths (home directory and FILE_EDIT_PATHS)"
    fi
  done

  # -- tee targets --
  if printf '%s' "$cmd" | grep -qE '(^|[|;&])\s*tee\s'; then
    local tee_targets
    tee_targets=$(printf '%s' "$cmd" \
      | grep -oE 'tee\s+(-[a-zA-Z]*\s+)*/?[^ ;|&)]+' \
      | grep -oE '/[^ ;|&)]+$' || true)
    for target in $tee_targets; do
      [ -z "$target" ] && continue
      if is_system_dir "$target"; then
        block "Writing to system directory is not allowed: ${target}"
      fi
      if ! path_is_allowed "$target"; then
        block "File write to ${target} is outside allowed paths (home directory and FILE_EDIT_PATHS)"
      fi
    done
  fi

  # -- cp, mv, install, rsync destinations (last absolute-path argument) --
  if printf '%s' "$cmd" | grep -qE '(^|[;&|])\s*(cp|mv|install|rsync)\s'; then
    local abs_paths
    abs_paths=$(printf '%s' "$cmd" | grep -oE '\s/[^ ;|&>)]+' | sed 's/^[[:space:]]*//' || true)
    # The last absolute path is typically the destination
    local last_path=""
    for p in $abs_paths; do
      last_path="$p"
    done
    if [ -n "$last_path" ]; then
      if is_system_dir "$last_path"; then
        block "Writing to system directory is not allowed: ${last_path}"
      fi
      if ! path_is_allowed "$last_path"; then
        block "File write to ${last_path} is outside allowed paths (home directory and FILE_EDIT_PATHS)"
      fi
    fi
  fi

  # -- mkdir, touch, chmod, chown, chgrp on system dirs --
  if printf '%s' "$cmd" | grep -qE '(^|[;&|])\s*(mkdir|touch|chmod|chown|chgrp)\s'; then
    local mod_paths
    mod_paths=$(printf '%s' "$cmd" | grep -oE '\s/[^ ;|&>)]+' | sed 's/^[[:space:]]*//' || true)
    for target in $mod_paths; do
      [ -z "$target" ] && continue
      if is_system_dir "$target"; then
        block "Modifying system directory is not allowed: ${target}"
      fi
    done
  fi
}

###############################################################################
# RULE 1: Explicit whitelist match -- allow immediately
###############################################################################
if matches_whitelist "$COMMAND"; then
  exit 0
fi

###############################################################################
# RULE 2: Block dangerous commands unconditionally
###############################################################################

# -- sudo (unless whitelisted above) --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*sudo\b'; then
  block "sudo commands are not allowed"
fi

# -- rm -rf (rm with both -r and -f flags in any order) --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*rm\s'; then
  # Check for combined flags like -rf, -fr, -rfi, etc.
  if printf '%s' "$COMMAND" | grep -qE '\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b'; then
    block "rm -rf is not allowed"
  fi
  # Check for separate flags: rm -r -f, rm -f -r, rm --recursive --force, etc.
  if printf '%s' "$COMMAND" | grep -qE '\brm\s.*\s-r\b.*\s-f\b|\brm\s.*\s-f\b.*\s-r\b'; then
    block "rm -rf is not allowed"
  fi
  if printf '%s' "$COMMAND" | grep -qE '\brm\s.*--recursive.*--force|\brm\s.*--force.*--recursive'; then
    block "rm -rf is not allowed"
  fi
fi

# -- shutdown, reboot, poweroff --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*(shutdown|reboot|poweroff)\b'; then
  block "System shutdown/reboot/poweroff commands are not allowed"
fi

# -- kill, pkill, killall --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*(kill|pkill|killall)\b'; then
  block "Process termination commands (kill/pkill/killall) are not allowed"
fi

# -- Network configuration changes --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*(ifconfig|ip\s+(addr|link|route|rule)|iptables|ip6tables|nft\b|nftables|route\s|nmcli|netplan|iwconfig|wpa_supplicant)\b'; then
  block "Network configuration changes are not allowed"
fi

# -- Package installation / removal --
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*(apt|apt-get|aptitude)\s+(install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b'; then
  block "Package management (apt) is not allowed"
fi
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*(yum|dnf)\s+(install|remove|erase|upgrade|update)\b'; then
  block "Package management (yum/dnf) is not allowed"
fi
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*pip[23]?\s+install\b'; then
  block "pip install is not allowed"
fi
if printf '%s' "$COMMAND" | grep -qE '(^|[;&|`(])\s*npm\s+install\s+(-g|--global)\b'; then
  block "Global npm install is not allowed"
fi

###############################################################################
# RULE 3: Check file-write targets against allowed paths
#
# Runs BEFORE the read-only allowance so that commands like
# "echo x > /etc/passwd" are caught by write-target inspection even though
# "echo" would otherwise be considered read-only.
#
# Detects output redirection and common write commands. Blocks writes to
# system directories unconditionally, and blocks writes outside HOME and
# FILE_EDIT_PATHS.
###############################################################################
check_write_targets "$COMMAND"

###############################################################################
# RULE 4: Allow read-only system queries
###############################################################################
READONLY_CMDS='uptime|free|df|du|ps|top|htop|who|whoami|id|hostname|uname'
READONLY_CMDS="${READONLY_CMDS}|date|cal|cat|less|more|head|tail|ls|ll|stat|file"
READONLY_CMDS="${READONLY_CMDS}|wc|grep|egrep|fgrep|rg|find|locate|which|whereis|type"
READONLY_CMDS="${READONLY_CMDS}|pg_isready|lsblk|lscpu|lsusb|lspci|lsof|mount"
READONLY_CMDS="${READONLY_CMDS}|env|printenv|echo|printf|test|true|false|pwd|realpath"
READONLY_CMDS="${READONLY_CMDS}|dig|nslookup|host|ping|traceroute|curl|wget|ss|netstat"
READONLY_CMDS="${READONLY_CMDS}|git\s+(status|log|diff|show|branch|tag|remote|rev-parse)"
READONLY_CMDS="${READONLY_CMDS}|node\s+--version|npm\s+(ls|list|view|info|outdated|search)"
READONLY_CMDS="${READONLY_CMDS}|claude\s+--version|systemctl\s+(status|is-active|is-enabled)"
READONLY_CMDS="${READONLY_CMDS}|journalctl|dmesg|timedatectl\s+status"

if printf '%s' "$COMMAND" | grep -qE "^\s*(${READONLY_CMDS})\b"; then
  exit 0
fi

###############################################################################
# RULE 5: Default -- allow
#
# Commands not explicitly blocked by rules 2-4 and not matched by the
# whitelist (rule 1) are allowed. The layered checks above provide the
# primary security enforcement. Additional patterns can be added to the
# block list as needed.
###############################################################################
exit 0
