import { query } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/**
 * Claude SDK bridge (spec section 5).
 *
 * Uses the @anthropic-ai/claude-code SDK instead of spawning a CLI subprocess.
 * Emits 'typing' events during streaming (for refreshing the Telegram typing
 * indicator) and 'error' events on failures.
 *
 * The public interface is unchanged from the subprocess version:
 *   - invoke(message, sessionId, systemPrompt, options) -> { text, sessionId, cost, duration, toolCalls }
 *   - isActive() -> boolean
 *   - kill() -> void
 */
class ClaudeBridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.config - Application configuration object
   * @param {object} options.logger - Structured logger instance
   * @param {object} [options.hooks] - Optional lifecycle hooks (app-level, not SDK hooks)
   * @param {Function} [options.validateCommandHook] - SDK PreToolUse hook for Bash command validation
   * @param {object} [options.db] - Optional database interface for hook logging
   */
  constructor({ config, logger, hooks = {}, validateCommandHook = null, db = null }) {
    super();
    this.config = config;
    this.logger = logger;
    this.hooks = hooks;
    this.validateCommandHook = validateCommandHook;
    this.db = db;

    /** @type {AbortController|null} Active query abort controller */
    this._abortController = null;

    /** Whether a query is currently in progress */
    this._active = false;
  }

  /**
   * Build the MCP servers configuration object from application config.
   * @returns {object} mcpServers config for the SDK
   * @private
   */
  _buildMcpServers() {
    const mcpServers = {};

    if (this.config.DATABASE_URL) {
      mcpServers.pg = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres', this.config.DATABASE_URL],
      };
    }

    if (this.config.EMBEDDING_PROVIDER && this.config._embedServerUrl) {
      mcpServers.embed = {
        type: 'url',
        url: this.config._embedServerUrl,
      };
    }

    return mcpServers;
  }

  /**
   * Build the SDK hooks configuration.
   * @returns {object} hooks config for the SDK
   * @private
   */
  _buildHooks() {
    if (!this.validateCommandHook) return {};

    return {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [this.validateCommandHook],
        },
      ],
    };
  }

  /**
   * Build allowed tools list from config.
   * @param {boolean} skipMcp - Whether to exclude MCP tools
   * @returns {string[]|undefined} Allowed tools list, or undefined to allow all
   * @private
   */
  _buildAllowedTools(skipMcp) {
    const whitelist = this.config.MCP_TOOLS_WHITELIST;
    if (!whitelist || whitelist === '*') return undefined; // allow all

    const tools = whitelist.split(',').map((t) => t.trim()).filter(Boolean);
    if (skipMcp) {
      // Remove MCP tool entries (mcp__*) when skipping MCP
      return tools.filter((t) => !t.startsWith('mcp__'));
    }
    return tools;
  }

  /**
   * Invoke Claude with a user message using the SDK.
   *
   * For new sessions (no sessionId), starts with full configuration.
   * For continuations, resumes the existing session.
   *
   * If MCP servers fail to respond within MCP_INIT_TIMEOUT, automatically
   * retries without MCP servers so the user still gets a response.
   *
   * @param {string} message - The user message to send
   * @param {string|null} [sessionId=null] - Existing session ID for continuation
   * @param {string} [systemPrompt=''] - System prompt for new sessions
   * @param {object} [options={}]
   * @param {boolean} [options.skipMcp=false] - Skip MCP server configuration
   * @param {number} [options.timeout] - Override CLAUDE_TIMEOUT for this invocation
   * @returns {Promise<{ text: string, sessionId: string, cost: number, duration: number, toolCalls: Array, _mcpFallback?: boolean }>}
   */
  async invoke(message, sessionId = null, systemPrompt = '', { skipMcp = false, timeout: overrideTimeout } = {}) {
    try {
      return await this._runQuery(message, sessionId, systemPrompt, { skipMcp, timeout: overrideTimeout });
    } catch (err) {
      // If MCP initialization caused the failure, retry without MCP
      if (err.mcpTimeout && !sessionId && !skipMcp) {
        this.logger.warn('claude', 'Retrying invocation WITHOUT MCP servers as fallback');
        const result = await this._runQuery(message, sessionId, systemPrompt, { skipMcp: true, timeout: overrideTimeout });
        result._mcpFallback = true;
        return result;
      }
      throw err;
    }
  }

  /**
   * Run a single SDK query and collect the result.
   * @private
   */
  async _runQuery(message, sessionId, systemPrompt, { skipMcp = false, timeout: overrideTimeout } = {}) {
    const startTime = Date.now();
    const effectiveTimeout = overrideTimeout || this.config.CLAUDE_TIMEOUT;
    const runtimeDir = path.join(this.config.DATA_DIR, 'claude-runtime');

    this._abortController = new AbortController();
    this._active = true;

    // Set up a timeout that aborts the query
    const timeoutTimer = setTimeout(() => {
      this.logger.warn('claude', `SDK query timed out after ${effectiveTimeout}ms`);
      this._abortController?.abort();
    }, effectiveTimeout);

    // MCP init timeout: if no messages arrive within MCP_INIT_TIMEOUT, abort and retry without MCP
    const mcpInitTimeout = (!sessionId && !skipMcp) ? this.config.MCP_INIT_TIMEOUT : 0;
    let receivedFirstMessage = false;
    let mcpTimedOut = false;
    let mcpInitTimer = null;

    if (mcpInitTimeout > 0) {
      mcpInitTimer = setTimeout(() => {
        if (!receivedFirstMessage) {
          mcpTimedOut = true;
          this.logger.warn('claude', `MCP initialization timed out after ${mcpInitTimeout}ms`);
          this._abortController?.abort();
        }
      }, mcpInitTimeout);
    }

    try {
      // Build SDK options
      const options = {
        model: this.config.CLAUDE_MODEL,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        cwd: runtimeDir,
        settingSources: ['project'], // Load skills from .claude/skills/
        abortController: this._abortController,
        hooks: this._buildHooks(),
        includePartialMessages: true, // For typing indicator events
      };

      if (sessionId) {
        options.resume = sessionId;
      } else {
        if (systemPrompt) {
          options.systemPrompt = systemPrompt;
        }
        if (!skipMcp) {
          options.mcpServers = this._buildMcpServers();
        }
        options.allowedTools = this._buildAllowedTools(skipMcp);
      }

      if (this.config.CLAUDE_MAX_BUDGET) {
        options.maxBudgetUsd = parseFloat(this.config.CLAUDE_MAX_BUDGET);
      }

      this.logger.info('claude', `SDK query starting (session=${sessionId || 'new'}, model=${this.config.CLAUDE_MODEL}, mcp=${!skipMcp})`);

      const textChunks = [];
      const toolCalls = [];
      let resultData = null;
      let resolvedSessionId = sessionId || '';

      const q = query({ prompt: message, options });

      for await (const msg of q) {
        // Mark first message received (for MCP init timeout)
        if (!receivedFirstMessage) {
          receivedFirstMessage = true;
          if (mcpInitTimer) clearTimeout(mcpInitTimer);
          this.logger.info('claude', `First SDK message received after ${Date.now() - startTime}ms`);
        }

        switch (msg.type) {
          case 'system': {
            if (msg.subtype === 'init' && msg.session_id) {
              resolvedSessionId = msg.session_id;
            }
            break;
          }

          case 'assistant': {
            // Extract text from assistant message content blocks
            const content = msg.message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  textChunks.push(block.text);
                }
                if (block.type === 'tool_use') {
                  toolCalls.push({
                    id: block.id,
                    name: block.name,
                    input: block.input,
                  });
                }
              }
            }
            this.emit('typing');
            break;
          }

          case 'stream_event': {
            // Incremental streaming tokens
            if (msg.event?.type === 'content_block_delta' &&
                msg.event?.delta?.type === 'text_delta' &&
                msg.event?.delta?.text) {
              // Don't push partial text -- it's already included in the full assistant message
              // Just use for typing indicator
            }
            this.emit('typing');
            break;
          }

          case 'result': {
            resultData = msg;
            // Extract any remaining text from the result
            if (msg.result && typeof msg.result === 'string') {
              // SDK result messages include the final text in msg.result
              // Only use it if we didn't collect text from assistant messages
              if (textChunks.length === 0) {
                textChunks.push(msg.result);
              }
            }
            if (msg.session_id) {
              resolvedSessionId = msg.session_id;
            }
            break;
          }

          default:
            this.logger.debug('claude', `SDK message type: ${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`);
            break;
        }
      }

      clearTimeout(timeoutTimer);
      if (mcpInitTimer) clearTimeout(mcpInitTimer);

      const duration = Date.now() - startTime;
      const text = textChunks.join('');
      const cost = resultData?.total_cost_usd ?? 0;

      // If we got a result message with text but no assistant chunks, use the result text
      if (!text && resultData?.result && typeof resultData.result === 'string') {
        textChunks.push(resultData.result);
      }

      this.logger.info(
        'claude',
        `Response received (session=${resolvedSessionId}, cost=$${cost.toFixed(4)}, duration=${duration}ms)`,
      );

      return {
        text: textChunks.join('') || text,
        sessionId: resolvedSessionId,
        cost,
        duration,
        toolCalls,
      };
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (mcpInitTimer) clearTimeout(mcpInitTimer);

      // If MCP init timed out, tag the error for the retry logic in invoke()
      if (mcpTimedOut) {
        const mcpErr = new Error(
          `MCP initialization timed out after ${mcpInitTimeout}ms -- ` +
          'MCP servers failed to start. Consider pre-installing: ' +
          'npm install -g @modelcontextprotocol/server-postgres',
        );
        mcpErr.mcpTimeout = true;
        throw mcpErr;
      }

      // Check if this was our timeout abort
      if (err.name === 'AbortError' || this._abortController?.signal.aborted) {
        throw new Error(`Claude SDK query timed out after ${effectiveTimeout}ms`);
      }

      this.logger.error('claude', `SDK query failed: ${err.message}`);
      this.emit('error', err);
      throw err;
    } finally {
      this._active = false;
      this._abortController = null;
    }
  }

  /**
   * Returns true if a Claude SDK query is currently running.
   * @returns {boolean}
   */
  isActive() {
    return this._active;
  }

  /**
   * Abort the active Claude SDK query, if any.
   */
  kill() {
    if (this._active && this._abortController) {
      this.logger.warn('claude', 'Aborting active SDK query');
      this._abortController.abort();
      this._active = false;
      this._abortController = null;
    }
  }
}

export { ClaudeBridge };
export default ClaudeBridge;
