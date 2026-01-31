import fs from 'node:fs';
import path from 'node:path';

/**
 * Generate the MCP configuration JSON for claude-cli and the runtime
 * .claude/settings.json with subprocess hooks (spec sections 7 and 13.2).
 *
 * Writes:
 *   $DATA_DIR/claude-runtime/mcp-config.json   -- MCP server definitions
 *   $DATA_DIR/claude-runtime/.claude/settings.json -- subprocess hooks
 *
 * @param {object} config - Application configuration object.
 *   Required: DATA_DIR, DATABASE_URL.
 *   Optional: EMBEDDING_PROVIDER (enables embed server entry),
 *             _embedServerUrl (runtime URL set by createEmbedTool).
 * @returns {string} Absolute path to the written MCP config file.
 */
function generateMcpConfig(config) {
  const runtimeDir = path.join(config.DATA_DIR, 'claude-runtime');
  const claudeDir = path.join(runtimeDir, '.claude');
  const hooksDir = path.join(runtimeDir, 'hooks');
  const mcpConfigPath = path.join(runtimeDir, 'mcp-config.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Ensure the full directory tree exists
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(hooksDir, { recursive: true });

  // ---- MCP server configuration ----

  const mcpConfig = {
    mcpServers: {
      pg: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', config.DATABASE_URL],
      },
    },
  };

  // Include the embed_query MCP server when embedding is enabled and the
  // runtime HTTP server URL is available (set by createEmbedTool at startup).
  if (config.EMBEDDING_PROVIDER && config._embedServerUrl) {
    mcpConfig.mcpServers.embed = {
      type: 'url',
      url: config._embedServerUrl,
    };
  }

  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');

  // ---- Runtime .claude/settings.json with subprocess hooks (section 13.2) ----

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: path.join(hooksDir, 'validate-command.sh'),
            },
          ],
        },
      ],
    },
  };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  return mcpConfigPath;
}

export { generateMcpConfig };
export default generateMcpConfig;
