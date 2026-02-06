import { query } from '@anthropic-ai/claude-code';
import os from 'node:os';
import path from 'node:path';

/**
 * Run a lightweight self-test of the Claude SDK and MCP server connectivity.
 *
 * Tests are run sequentially:
 *   1. Bare SDK query (no MCP) -- validates API connectivity
 *   2. Individual MCP server probes -- validates server reachability
 *   3. SDK query with MCP config -- validates full integration
 *
 * Results are logged and returned for use by the /health endpoint.
 * This function is non-blocking to startup -- callers should fire-and-forget.
 *
 * @param {object} options
 * @param {object} options.config - Application configuration
 * @param {object} options.logger - Structured logger
 * @returns {Promise<object>} Self-test results
 */
async function runSelfTest({ config, logger }) {
  const results = {
    timestamp: new Date().toISOString(),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      freeMem: Math.round(os.freemem() / 1048576),
      totalMem: Math.round(os.totalmem() / 1048576),
    },
    cliOk: false,
    cliResponseMs: 0,
    mcpServers: {},
    fullIntegrationOk: false,
    fullIntegrationMs: 0,
  };

  const runtimeDir = path.join(config.DATA_DIR, 'claude-runtime');

  logger.info('self-test', 'Starting Claude SDK self-test...');

  // --- Test 1: Bare SDK query (no MCP) ---
  try {
    const start = Date.now();
    await sdkTest({
      model: config.CLAUDE_MODEL,
      message: 'respond with just the word ok',
      cwd: runtimeDir,
      timeout: 30_000,
    });
    results.cliResponseMs = Date.now() - start;
    results.cliOk = true;
    logger.info('self-test', `Claude SDK (no MCP): OK in ${results.cliResponseMs}ms`);
  } catch (err) {
    results.cliResponseMs = 0;
    logger.error('self-test', `Claude SDK (no MCP): FAILED -- ${err.message}`);
  }

  // --- Test 2: Individual MCP server probes ---
  // Build the MCP servers config the same way the bridge does
  const mcpServers = {};
  if (config.DATABASE_URL) {
    mcpServers.pg = {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', config.DATABASE_URL],
    };
  }
  if (config.EMBEDDING_PROVIDER && config._embedServerUrl) {
    mcpServers.embed = {
      type: 'url',
      url: config._embedServerUrl,
    };
  }

  for (const [name, server] of Object.entries(mcpServers)) {
    const start = Date.now();
    try {
      if (server.type === 'url' && server.url) {
        // URL-based server: check if it responds to HTTP
        const response = await fetch(server.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
          signal: AbortSignal.timeout(5_000),
        });
        results.mcpServers[name] = {
          ok: response.ok,
          responseMs: Date.now() - start,
        };
        logger.info('self-test', `MCP server "${name}" (url): ${response.ok ? 'OK' : 'FAILED'} in ${Date.now() - start}ms`);
      } else if (server.command) {
        // Command-based server: just record that it's configured
        // (The SDK manages server lifecycle; we can't probe it in isolation
        // without spawning it, which is what Test 3 validates)
        results.mcpServers[name] = {
          ok: true,
          responseMs: 0,
          note: 'command-based server; validated via full integration test',
        };
        logger.info('self-test', `MCP server "${name}": command-based, will validate in integration test`);
      }
    } catch (err) {
      results.mcpServers[name] = {
        ok: false,
        responseMs: Date.now() - start,
        error: err.message,
      };
      logger.warn('self-test', `MCP server "${name}": FAILED -- ${err.message}`);
    }
  }

  // --- Test 3: Full integration (SDK + MCP) ---
  if (results.cliOk && Object.keys(mcpServers).length > 0) {
    try {
      const start = Date.now();
      await sdkTest({
        model: config.CLAUDE_MODEL,
        message: 'respond with just the word ok',
        cwd: runtimeDir,
        timeout: 45_000,
        mcpServers,
      });
      results.fullIntegrationMs = Date.now() - start;
      results.fullIntegrationOk = true;
      logger.info('self-test', `Claude SDK (with MCP): OK in ${results.fullIntegrationMs}ms`);
    } catch (err) {
      results.fullIntegrationMs = 0;
      logger.warn('self-test', `Claude SDK (with MCP): FAILED -- ${err.message}`);

      if (results.cliOk) {
        logger.warn(
          'self-test',
          'Claude SDK works WITHOUT MCP servers but FAILS with MCP config. ' +
          'The MCP servers are the problem. Consider pre-installing: ' +
          'npm install -g @modelcontextprotocol/server-postgres',
        );
      }
    }
  }

  logger.info('self-test', `Self-test complete: sdk=${results.cliOk}, mcp_integration=${results.fullIntegrationOk}`);
  return results;
}

/**
 * Run a minimal SDK query and wait for any response.
 *
 * @param {object} options
 * @param {string} options.model - Claude model to use
 * @param {string} options.message - Message to send
 * @param {string} options.cwd - Working directory
 * @param {number} options.timeout - Timeout in ms
 * @param {object} [options.mcpServers] - Optional MCP server config
 * @returns {Promise<string>} First text response
 */
async function sdkTest({ model, message, cwd, timeout, mcpServers }) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const options = {
      model,
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      abortController,
      maxTurns: 1,
    };

    if (mcpServers) {
      options.mcpServers = mcpServers;
    }

    for await (const msg of query({ prompt: message, options })) {
      if (msg.type === 'assistant' || msg.type === 'result') {
        clearTimeout(timer);
        // Got a response -- test passed
        const text = msg.type === 'result'
          ? (msg.result || '')
          : JSON.stringify(msg.message?.content || '');
        return text;
      }
    }

    clearTimeout(timer);
    return '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export { runSelfTest };
export default runSelfTest;
