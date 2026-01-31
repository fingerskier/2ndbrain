import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Claude CLI subprocess bridge (spec section 5).
 *
 * Spawns `claude -p` as a child process for each conversational message.
 * Emits 'typing' events during streaming (for refreshing Telegram typing
 * indicator) and 'error' events on failures.
 */
class ClaudeBridge extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.config - Application configuration object
   * @param {object} options.logger - Structured logger instance
   * @param {object} [options.hooks] - Optional lifecycle hooks
   */
  constructor({ config, logger, hooks = {} }) {
    super();
    this.config = config;
    this.logger = logger;
    this.hooks = hooks;

    /** @type {import('node:child_process').ChildProcess | null} */
    this.activeProcess = null;
  }

  /**
   * Invoke the Claude CLI with a user message.
   *
   * For new sessions (no sessionId), spawns with full configuration flags.
   * For continuations, spawns with --resume to continue the existing session.
   * The user message is piped via stdin to handle special characters safely.
   *
   * @param {string} message - The user message to send
   * @param {string|null} [sessionId=null] - Existing session ID for continuation
   * @param {string} [systemPrompt=''] - System prompt for new sessions
   * @returns {Promise<{ text: string, sessionId: string, cost: number, duration: number, toolCalls: Array }>}
   */
  async invoke(message, sessionId = null, systemPrompt = '') {
    const startTime = Date.now();
    const args = this._buildArgs(sessionId, systemPrompt);

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.activeProcess = proc;

      let stdoutBuffer = '';
      let stderrBuffer = '';
      const textChunks = [];
      const toolCalls = [];
      let resultData = null;
      let timedOut = false;

      // Set up the timeout guard
      const timeout = setTimeout(() => {
        timedOut = true;
        this.logger.warn('claude', `Subprocess timed out after ${this.config.CLAUDE_TIMEOUT}ms`);
        this.kill();
      }, this.config.CLAUDE_TIMEOUT);

      // Pipe the user message via stdin and close it
      proc.stdin.write(message);
      proc.stdin.end();

      // Collect and parse stdout stream-json chunks
      proc.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();

        // Process complete lines (NDJSON: one JSON object per line)
        const lines = stdoutBuffer.split('\n');
        // Keep the last potentially incomplete line in the buffer
        stdoutBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            this._handleStreamChunk(parsed, textChunks, toolCalls);

            if (parsed.type === 'result') {
              resultData = parsed;
            }
          } catch {
            // Non-JSON line; ignore
            this.logger.debug('claude', `Non-JSON stdout line: ${trimmed}`);
          }
        }
      });

      // Monitor stderr for errors
      proc.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);
        this.activeProcess = null;

        // Process any remaining data in the stdout buffer
        if (stdoutBuffer.trim()) {
          try {
            const parsed = JSON.parse(stdoutBuffer.trim());
            this._handleStreamChunk(parsed, textChunks, toolCalls);
            if (parsed.type === 'result') {
              resultData = parsed;
            }
          } catch {
            // Ignore trailing non-JSON data
          }
        }

        const duration = Date.now() - startTime;

        if (timedOut) {
          reject(new Error(`Claude subprocess timed out after ${this.config.CLAUDE_TIMEOUT}ms`));
          return;
        }

        if (code !== 0 && !resultData) {
          const errMsg = stderrBuffer.trim() || `Claude process exited with code ${code}`;
          this.logger.error('claude', errMsg);
          this.emit('error', new Error(errMsg));
          reject(new Error(errMsg));
          return;
        }

        if (stderrBuffer.trim()) {
          this.logger.debug('claude', `stderr: ${stderrBuffer.trim()}`);
        }

        const text = textChunks.join('');
        const resolvedSessionId = resultData?.session_id || sessionId || '';
        const cost = resultData?.total_cost_usd ?? 0;

        this.logger.info(
          'claude',
          `Response received (session=${resolvedSessionId}, cost=$${cost.toFixed(4)}, duration=${duration}ms)`,
        );

        resolve({
          text,
          sessionId: resolvedSessionId,
          cost,
          duration,
          toolCalls,
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        this.activeProcess = null;
        this.logger.error('claude', `Failed to spawn claude: ${err.message}`);
        this.emit('error', err);
        reject(err);
      });
    });
  }

  /**
   * Build the CLI argument array for the claude subprocess.
   *
   * @param {string|null} sessionId - Session ID for continuation, or null for new
   * @param {string} systemPrompt - System prompt for new sessions
   * @returns {string[]}
   * @private
   */
  _buildArgs(sessionId, systemPrompt) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];

    if (sessionId) {
      // Continuation: resume an existing session
      args.push('--resume', sessionId);
    } else {
      // New session: full configuration
      args.push('--model', this.config.CLAUDE_MODEL);

      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }

      args.push('--mcp-config', this.config.MCP_CONFIG_PATH);
      args.push('--allowed-tools', this.config.MCP_TOOLS_WHITELIST);

      if (this.config.CLAUDE_MAX_BUDGET) {
        args.push('--max-budget-usd', this.config.CLAUDE_MAX_BUDGET);
      }
    }

    return args;
  }

  /**
   * Handle a single parsed stream-json chunk.
   *
   * Stream-json output consists of objects with a `type` field:
   * - "assistant": contains text content chunks
   * - "result": final object with session_id, total_cost_usd, usage
   * - "tool_use": tool invocation records
   *
   * @param {object} chunk - Parsed JSON chunk
   * @param {string[]} textChunks - Accumulator for assistant text
   * @param {Array} toolCalls - Accumulator for tool call records
   * @private
   */
  _handleStreamChunk(chunk, textChunks, toolCalls) {
    switch (chunk.type) {
      case 'assistant': {
        // Extract text content from assistant messages
        const content = chunk.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              textChunks.push(block.text);
            }
          }
        } else if (typeof content === 'string') {
          textChunks.push(content);
        }

        // Emit typing event so Telegram adapter can refresh the indicator
        this.emit('typing');
        break;
      }

      case 'content_block_delta': {
        // Incremental text deltas during streaming
        if (chunk.delta?.type === 'text_delta' && chunk.delta.text) {
          textChunks.push(chunk.delta.text);
        }
        this.emit('typing');
        break;
      }

      case 'tool_use': {
        toolCalls.push({
          id: chunk.id,
          name: chunk.name,
          input: chunk.input,
        });
        break;
      }

      case 'result': {
        // Final result object -- extract any remaining text from the result
        const resultContent = chunk.result?.content;
        if (Array.isArray(resultContent)) {
          for (const block of resultContent) {
            if (block.type === 'text' && block.text) {
              textChunks.push(block.text);
            }
          }
        }
        break;
      }

      default:
        // Other chunk types (e.g., "system", "thinking") are logged at debug level
        this.logger.debug('claude', `Stream chunk type: ${chunk.type}`);
        break;
    }
  }

  /**
   * Returns true if a Claude subprocess is currently running.
   * @returns {boolean}
   */
  isActive() {
    return this.activeProcess !== null && this.activeProcess.exitCode === null;
  }

  /**
   * Kill the active Claude subprocess, if any.
   */
  kill() {
    if (this.activeProcess && this.activeProcess.exitCode === null) {
      this.logger.warn('claude', 'Killing active subprocess');
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
  }
}

export { ClaudeBridge };
export default ClaudeBridge;
