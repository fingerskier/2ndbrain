/**
 * Build MCP server configuration objects for the Claude SDK (spec section 7).
 *
 * With the SDK migration, MCP config is passed as JavaScript objects directly
 * to the SDK's query() options instead of written to a JSON file.
 *
 * @param {object} config - Application configuration object.
 *   Required: DATABASE_URL.
 *   Optional: EMBEDDING_PROVIDER (enables embed server entry),
 *             _embedServerUrl (runtime URL set by createEmbedTool).
 * @returns {object} MCP servers configuration object for the SDK
 */
function buildMcpServers(config) {
  const mcpServers = {};

  if (config.DATABASE_URL) {
    mcpServers.pg = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', config.DATABASE_URL],
    };
  }

  // Include the embed_query MCP server when embedding is enabled and the
  // runtime HTTP server URL is available (set by createEmbedTool at startup).
  if (config.EMBEDDING_PROVIDER && config._embedServerUrl) {
    mcpServers.embed = {
      type: 'url',
      url: config._embedServerUrl,
    };
  }

  return mcpServers;
}

export { buildMcpServers };
export default buildMcpServers;
