/**
 * PreToolUse hook callback for Bash command whitelist enforcement.
 *
 * This is the SDK equivalent of hooks/validate-command.sh (spec section 13.2).
 * It receives the hook input from the SDK, inspects the Bash command, and
 * returns allow/deny decisions.
 *
 * Rules (evaluated in order):
 *   1. Explicit COMMANDS_WHITELIST match -> allow
 *   2. Block dangerous commands (sudo, rm -rf, shutdown, kill, etc.)
 *   3. Check file-write targets against allowed paths
 *   4. Allow read-only system queries
 *   5. Default -> allow
 */

/**
 * Create a PreToolUse hook callback bound to the given application config.
 *
 * @param {object} options
 * @param {object} options.config - Application configuration (COMMANDS_WHITELIST, FILE_EDIT_PATHS, DATA_DIR)
 * @param {object} [options.logger] - Optional logger for recording blocked commands
 * @param {object} [options.db] - Optional database interface for persisting blocked attempts
 * @returns {Function} SDK-compatible HookCallback
 */
function createValidateCommandHook({ config, logger = null, db = null }) {
  const home = process.env.HOME || `/home/${process.env.USER || 'user'}`;

  /**
   * Parse a comma-separated string into trimmed, non-empty entries.
   */
  function parseList(str) {
    if (!str) return [];
    return str.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const whitelistPatterns = parseList(config.COMMANDS_WHITELIST);
  const allowedWritePaths = parseList(config.FILE_EDIT_PATHS);

  // ---- Helpers ----

  function matchesWhitelist(command) {
    for (const pattern of whitelistPatterns) {
      // Simple glob-style prefix matching (same semantics as the bash version)
      if (command === pattern) return true;
      if (command.startsWith(pattern + ' ')) return true;
      if (command.startsWith(pattern + ';')) return true;
      if (command.startsWith(pattern + '|')) return true;
      if (command.startsWith(pattern + '&')) return true;

      // Support trailing wildcard: "git *" matches "git status"
      if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        if (command.startsWith(prefix)) return true;
      }
    }
    return false;
  }

  function isSystemDir(p) {
    return /^\/(?:etc|usr|boot|sys|proc)(\/|$)/.test(p);
  }

  function pathIsAllowed(targetPath) {
    // Home directory: always allowed
    if (targetPath === home || targetPath.startsWith(home + '/')) return true;
    if (targetPath === '~' || targetPath.startsWith('~/')) return true;
    // Relative paths resolve under cwd (assumed to be within home)
    if (!targetPath.startsWith('/')) return true;

    // FILE_EDIT_PATHS
    for (const allowed of allowedWritePaths) {
      if (targetPath === allowed || targetPath.startsWith(allowed + '/')) return true;
    }

    return false;
  }

  function checkWriteTargets(command) {
    // Output redirection targets (> /path, >> /path)
    const redirectMatches = command.matchAll(/>>?\s*(\/[^\s;|&)]+)/g);
    for (const m of redirectMatches) {
      const target = m[1];
      if (target === '/dev/null' || target === '/dev/stdout' || target === '/dev/stderr') continue;
      if (isSystemDir(target)) return `Writing to system directory is not allowed: ${target}`;
      if (!pathIsAllowed(target)) return `File write to ${target} is outside allowed paths (home directory and FILE_EDIT_PATHS)`;
    }

    // tee targets
    if (/(?:^|[|;&])\s*tee\s/.test(command)) {
      const teeMatches = command.matchAll(/tee\s+(?:-[a-zA-Z]*\s+)*(\/?[^\s;|&)]+)/g);
      for (const m of teeMatches) {
        const target = m[1];
        if (target.startsWith('/')) {
          if (isSystemDir(target)) return `Writing to system directory is not allowed: ${target}`;
          if (!pathIsAllowed(target)) return `File write to ${target} is outside allowed paths (home directory and FILE_EDIT_PATHS)`;
        }
      }
    }

    // cp, mv, install, rsync destinations
    if (/(?:^|[;&|])\s*(?:cp|mv|install|rsync)\s/.test(command)) {
      const absPaths = [...command.matchAll(/\s(\/[^\s;|&>)]+)/g)].map((m) => m[1]);
      const lastPath = absPaths[absPaths.length - 1];
      if (lastPath) {
        if (isSystemDir(lastPath)) return `Writing to system directory is not allowed: ${lastPath}`;
        if (!pathIsAllowed(lastPath)) return `File write to ${lastPath} is outside allowed paths (home directory and FILE_EDIT_PATHS)`;
      }
    }

    // mkdir, touch, chmod, chown, chgrp on system dirs
    if (/(?:^|[;&|])\s*(?:mkdir|touch|chmod|chown|chgrp)\s/.test(command)) {
      const modPaths = [...command.matchAll(/\s(\/[^\s;|&>)]+)/g)].map((m) => m[1]);
      for (const target of modPaths) {
        if (isSystemDir(target)) return `Modifying system directory is not allowed: ${target}`;
      }
    }

    return null; // no violation
  }

  // Read-only command patterns (matches the bash READONLY_CMDS list)
  const readonlyPattern = new RegExp(
    '^\\s*(?:' +
    'uptime|free|df|du|ps|top|htop|who|whoami|id|hostname|uname' +
    '|date|cal|cat|less|more|head|tail|ls|ll|stat|file' +
    '|wc|grep|egrep|fgrep|rg|find|locate|which|whereis|type' +
    '|pg_isready|lsblk|lscpu|lsusb|lspci|lsof|mount' +
    '|env|printenv|echo|printf|test|true|false|pwd|realpath' +
    '|dig|nslookup|host|ping|traceroute|curl|wget|ss|netstat' +
    '|git\\s+(?:status|log|diff|show|branch|tag|remote|rev-parse)' +
    '|node\\s+--version|npm\\s+(?:ls|list|view|info|outdated|search)' +
    '|claude\\s+--version|systemctl\\s+(?:status|is-active|is-enabled)' +
    '|journalctl|dmesg|timedatectl\\s+status' +
    ')\\b',
  );

  /**
   * Log a blocked command attempt to the database (fire-and-forget).
   */
  function logBlocked(command, reason) {
    if (logger) {
      logger.warn('validate-command', `BLOCKED: ${reason} | command: ${command}`);
    }
    if (db) {
      db.query(
        "INSERT INTO system_logs (level, source, content) VALUES ('warn', 'validate-command', $1)",
        [`BLOCKED: ${reason} | command: ${command}`],
      ).catch(() => { /* fire-and-forget */ });
    }
  }

  // ---- The actual hook callback ----

  return async function validateCommandHook(input) {
    const command = input.tool_input?.command;
    if (!command || typeof command !== 'string') {
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Could not extract command from hook input',
        },
      };
    }

    // RULE 1: Explicit whitelist match -> allow
    if (matchesWhitelist(command)) {
      return {};
    }

    // RULE 2: Block dangerous commands

    // sudo
    if (/(?:^|[;&|`(])\s*sudo\b/.test(command)) {
      logBlocked(command, 'sudo commands are not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'sudo commands are not allowed',
        },
      };
    }

    // rm -rf
    if (/(?:^|[;&|`(])\s*rm\s/.test(command)) {
      const hasRf = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/.test(command) ||
        /\brm\s.*\s-r\b.*\s-f\b|\brm\s.*\s-f\b.*\s-r\b/.test(command) ||
        /\brm\s.*--recursive.*--force|\brm\s.*--force.*--recursive/.test(command);
      if (hasRf) {
        logBlocked(command, 'rm -rf is not allowed');
        return {
          hookSpecificOutput: {
            hookEventName: input.hook_event_name,
            permissionDecision: 'deny',
            permissionDecisionReason: 'rm -rf is not allowed',
          },
        };
      }
    }

    // shutdown, reboot, poweroff
    if (/(?:^|[;&|`(])\s*(?:shutdown|reboot|poweroff)\b/.test(command)) {
      logBlocked(command, 'System shutdown/reboot/poweroff commands are not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'System shutdown/reboot/poweroff commands are not allowed',
        },
      };
    }

    // kill, pkill, killall
    if (/(?:^|[;&|`(])\s*(?:kill|pkill|killall)\b/.test(command)) {
      logBlocked(command, 'Process termination commands (kill/pkill/killall) are not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Process termination commands (kill/pkill/killall) are not allowed',
        },
      };
    }

    // Network configuration
    if (/(?:^|[;&|`(])\s*(?:ifconfig|ip\s+(?:addr|link|route|rule)|iptables|ip6tables|nft\b|nftables|route\s|nmcli|netplan|iwconfig|wpa_supplicant)\b/.test(command)) {
      logBlocked(command, 'Network configuration changes are not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Network configuration changes are not allowed',
        },
      };
    }

    // Package management
    if (/(?:^|[;&|`(])\s*(?:apt|apt-get|aptitude)\s+(?:install|remove|purge|upgrade|dist-upgrade|full-upgrade)\b/.test(command)) {
      logBlocked(command, 'Package management (apt) is not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Package management (apt) is not allowed',
        },
      };
    }
    if (/(?:^|[;&|`(])\s*(?:yum|dnf)\s+(?:install|remove|erase|upgrade|update)\b/.test(command)) {
      logBlocked(command, 'Package management (yum/dnf) is not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Package management (yum/dnf) is not allowed',
        },
      };
    }
    if (/(?:^|[;&|`(])\s*pip[23]?\s+install\b/.test(command)) {
      logBlocked(command, 'pip install is not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'pip install is not allowed',
        },
      };
    }
    if (/(?:^|[;&|`(])\s*npm\s+install\s+(?:-g|--global)\b/.test(command)) {
      logBlocked(command, 'Global npm install is not allowed');
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: 'Global npm install is not allowed',
        },
      };
    }

    // RULE 3: Check file-write targets
    const writeViolation = checkWriteTargets(command);
    if (writeViolation) {
      logBlocked(command, writeViolation);
      return {
        hookSpecificOutput: {
          hookEventName: input.hook_event_name,
          permissionDecision: 'deny',
          permissionDecisionReason: writeViolation,
        },
      };
    }

    // RULE 4: Allow read-only system queries (explicit allow)
    if (readonlyPattern.test(command)) {
      return {};
    }

    // RULE 5: Default -> allow
    return {};
  };
}

export { createValidateCommandHook };
export default createValidateCommandHook;
