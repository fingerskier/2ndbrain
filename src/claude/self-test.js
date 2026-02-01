import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Run a lightweight self-test of Claude CLI and MCP server connectivity.
 *
 * Tests are run sequentially:
 *   1. Bare Claude CLI (no MCP) — validates API connectivity
 *   2. Claude CLI with MCP config — validates full integration
 *
 * Results are logged and returned for use by the /health endpoint.
 * This function is non-blocking to startup — callers should fire-and-forget.
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

  logger.info('self-test', 'Starting Claude CLI self-test...');

  // --- Test 1: Bare Claude CLI (no MCP) ---
  try {
    const start = Date.now();
    await spawnTest({
      args: ['-p', '--output-format', 'stream-json', '--model', config.CLAUDE_MODEL],
      message: 'respond with just the word ok',
      cwd: runtimeDir,
      timeout: 30_000,
    });
    results.cliResponseMs = Date.now() - start;
    results.cliOk = true;
    logger.info('self-test', `Claude CLI (no MCP): OK in ${results.cliResponseMs}ms`);
  } catch (err) {
    results.cliResponseMs = 0;
    logger.error('self-test', `Claude CLI (no MCP): FAILED -- ${err.message}`);
  }

  // --- Test 2: Individual MCP server probes ---
  if (config.MCP_CONFIG_PATH) {
    try {
      const raw = fs.readFileSync(config.MCP_CONFIG_PATH, 'utf-8');
      const mcpConfig = JSON.parse(raw);
      const servers = mcpConfig.mcpServers || {};

      for (const [name, server] of Object.entries(servers)) {
        const start = Date.now();
        try {
          if (server.command) {
            // Command-based server: check if the process starts and produces output
            await spawnTest({
              command: server.command,
              args: server.args || [],
              cwd: runtimeDir,
              timeout: 15_000,
              expectOutput: false, // just check if it starts without crashing
            });
            results.mcpServers[name] = {
              ok: true,
              responseMs: Date.now() - start,
            };
            logger.info('self-test', `MCP server "${name}": started in ${Date.now() - start}ms`);
          } else if (server.type === 'url' && server.url) {
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
    } catch (err) {
      logger.warn('self-test', `Could not read MCP config for server probes: ${err.message}`);
    }
  }

  // --- Test 3: Full integration (Claude + MCP) ---
  if (results.cliOk && config.MCP_CONFIG_PATH) {
    try {
      const start = Date.now();
      const args = [
        '-p', '--output-format', 'stream-json',
        '--model', config.CLAUDE_MODEL,
        '--mcp-config', config.MCP_CONFIG_PATH,
        '--permission-mode', 'bypassPermissions',
      ];
      await spawnTest({
        args,
        message: 'respond with just the word ok',
        cwd: runtimeDir,
        timeout: 45_000,
      });
      results.fullIntegrationMs = Date.now() - start;
      results.fullIntegrationOk = true;
      logger.info('self-test', `Claude CLI (with MCP): OK in ${results.fullIntegrationMs}ms`);
    } catch (err) {
      results.fullIntegrationMs = 0;
      logger.warn('self-test', `Claude CLI (with MCP): FAILED -- ${err.message}`);

      if (results.cliOk) {
        logger.warn(
          'self-test',
          'Claude CLI works WITHOUT MCP servers but FAILS with MCP config. ' +
          'The MCP servers are the problem. Consider pre-installing: ' +
          'npm install -g @modelcontextprotocol/server-postgres',
        );
      }
    }
  }

  logger.info('self-test', `Self-test complete: cli=${results.cliOk}, mcp_integration=${results.fullIntegrationOk}`);
  return results;
}

/**
 * Spawn a process and wait for first stdout or completion.
 *
 * @param {object} options
 * @param {string} [options.command='claude'] - Command to run
 * @param {string[]} options.args - Arguments
 * @param {string} [options.message] - Message to pipe via stdin
 * @param {string} options.cwd - Working directory
 * @param {number} options.timeout - Timeout in ms
 * @param {boolean} [options.expectOutput=true] - Whether to wait for stdout
 * @returns {Promise<string>} First stdout output
 */
function spawnTest({ command = 'claude', args, message, cwd, timeout, expectOutput = true }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        proc.kill('SIGTERM');
        reject(new Error(`Timed out after ${timeout}ms (no output)`));
      }
    }, timeout);

    if (message) {
      proc.stdin.write(message);
      proc.stdin.end();
    } else {
      proc.stdin.end();
    }

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (expectOutput && !done) {
        done = true;
        clearTimeout(timer);
        // Got output — kill the process (we don't need the full response)
        proc.kill('SIGTERM');
        resolve(stdout);
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        if (code === 0 || stdout) {
          resolve(stdout);
        } else {
          reject(new Error(
            `Process exited with code ${code}${stderr ? ': ' + stderr.trim().slice(-200) : ''}`,
          ));
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

export { runSelfTest };
export default runSelfTest;
