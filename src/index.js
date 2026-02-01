#!/usr/bin/env node

/**
 * 2ndbrain -- main entry point and process manager.
 *
 * Startup sequence per spec section 10:
 *   1. Load environment variables
 *   2. Validate required config
 *   3. Connect to PostgreSQL, run pending migrations
 *   4. Resolve embedding configuration (if EMBEDDING_PROVIDER is set)
 *   5. Verify claude-cli is available
 *   6. Start web admin server
 *   7. Start Telegram long-polling
 *   8. Log startup, set signal handlers
 *   9. Auto-open browser
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import { config, validateConfig, isFirstRun, PROJECT_ROOT } from './config.js';
import { pool, query, close as closeDb, ensureDatabase } from './db/pool.js';
import { migrate } from './db/migrate.js';
import logger from './logging.js';
import { createRateLimiters } from './rate-limiter.js';
import hooks from './hooks/lifecycle.js';
import { TelegramBot } from './telegram/bot.js';
import { CommandRouter } from './telegram/commands.js';
import { ClaudeBridge } from './claude/bridge.js';
import { ConversationManager } from './claude/conversation.js';
import { generateMcpConfig } from './mcp/config.js';
import { createEmbedTool } from './mcp/embed-server.js';
import { AttachmentStore } from './attachments/store.js';
import { EmbeddingsEngine } from './embeddings/engine.js';
import { EmbeddingWorker } from './embeddings/worker.js';
import { SchedulerWorker } from './scheduler/worker.js';
import { WebServer } from './web/server.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const startTime = Date.now();
let bot = null;
let webServer = null;
let embeddingWorker = null;
let schedulerWorker = null;
let embedTool = null;
let shuttingDown = false;

// ---------------------------------------------------------------------------
// Helper: copy skill + hook files to the runtime directory
// ---------------------------------------------------------------------------

function setupRuntimeFiles() {
  const runtimeDir = path.join(config.DATA_DIR, 'claude-runtime');
  const skillsDestDir = path.join(runtimeDir, '.claude', 'skills');
  const hooksDestDir = path.join(runtimeDir, 'hooks');

  fs.mkdirSync(skillsDestDir, { recursive: true });
  fs.mkdirSync(hooksDestDir, { recursive: true });

  // Copy skill files
  const skillsSrcDir = path.join(PROJECT_ROOT, 'skills');
  if (fs.existsSync(skillsSrcDir)) {
    for (const skillDir of fs.readdirSync(skillsSrcDir)) {
      const srcSkillDir = path.join(skillsSrcDir, skillDir);
      const destSkillDir = path.join(skillsDestDir, skillDir);
      if (fs.statSync(srcSkillDir).isDirectory()) {
        fs.mkdirSync(destSkillDir, { recursive: true });
        for (const file of fs.readdirSync(srcSkillDir)) {
          fs.copyFileSync(
            path.join(srcSkillDir, file),
            path.join(destSkillDir, file),
          );
        }
      }
    }
  }

  // Copy hook scripts
  const hooksSrcDir = path.join(PROJECT_ROOT, 'hooks');
  if (fs.existsSync(hooksSrcDir)) {
    for (const file of fs.readdirSync(hooksSrcDir)) {
      const src = path.join(hooksSrcDir, file);
      const dest = path.join(hooksDestDir, file);
      fs.copyFileSync(src, dest);
      // Make scripts executable
      if (file.endsWith('.sh')) {
        fs.chmodSync(dest, 0o755);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: verify claude-cli is installed
// ---------------------------------------------------------------------------

function verifyClaude() {
  try {
    const version = execSync('claude --version', {
      timeout: 10_000,
      encoding: 'utf-8',
    }).trim();
    logger.info('startup', `claude-cli found: ${version}`);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Helper: open browser
// ---------------------------------------------------------------------------

async function openBrowser(url) {
  if (config.AUTO_OPEN_BROWSER !== 'true') return;
  // Don't try to open browser when running under systemd or without TTY
  if (!process.stdout.isTTY && !process.env.DISPLAY) return;

  try {
    const open = (await import('open')).default;
    await open(url);
  } catch (err) {
    logger.debug('startup', `Could not open browser: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Message handler -- wires Telegram messages to the Claude bridge
// ---------------------------------------------------------------------------

async function handleMessage(message, deps) {
  const {
    commandRouter,
    claudeBridge,
    conversationManager,
    attachmentStore,
    rateLimiters,
    embeddingsEngine,
  } = deps;

  const { chatId, text, attachments, messageId } = message;

  // 1. Check if it's a slash command
  const handled = await commandRouter.route(message);
  if (handled) return;

  // 2. Save user message
  const savedUserMsg = await conversationManager.saveMessage('user', text || '', {
    telegram_message_id: messageId,
    attachments: attachments?.map((a) => a.fileId) || [],
  });

  // 3. Handle attachments
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      try {
        await attachmentStore.save(
          { file_id: att.fileId, mime_type: att.mimeType },
          savedUserMsg.id,
        );
      } catch (err) {
        logger.error('attachments', `Failed to save attachment: ${err.message}`);
      }
    }
  }

  // 4. Start typing indicator
  await bot.sendTyping(chatId, true);

  try {
    // 5. Rate limit check for Claude
    await rateLimiters.claude.acquire();

    // 6. Run on_pre_claude hook
    const preResult = await hooks.emit('on_pre_claude', {
      message: text,
      systemPrompt: '',
      sessionId: conversationManager.currentSessionId,
      chatId,
    });

    if (preResult.aborted) {
      bot.stopTyping(chatId);
      await bot.sendMessage(chatId, preResult.reason || 'Request aborted.', {
        reply_to_message_id: messageId,
        parse_mode: undefined,
      });
      return;
    }

    const ctx = preResult.context || {};

    // 7. Invoke Claude
    const result = await claudeBridge.invoke(
      text || '',
      conversationManager.currentSessionId,
      ctx.systemPrompt || '',
    );

    // 8. Update session ID
    if (result.sessionId) {
      conversationManager.setSessionId(result.sessionId);
    }

    // 9. Save assistant response
    const savedAssistantMsg = await conversationManager.saveMessage('assistant', result.text || '', {
      session_id: result.sessionId,
      cost_usd: result.cost,
      duration_ms: result.duration,
      tool_calls: result.toolCalls,
      telegram_message_id: messageId,
    });

    // 10. Run on_post_claude hook
    await hooks.emit('on_post_claude', {
      response: result.text,
      tool_calls: result.toolCalls,
      duration: result.duration,
      cost: result.cost,
      sessionId: result.sessionId,
      messageId: savedAssistantMsg.id,
    });

    // 11. Run on_pre_send hook
    const sendResult = await hooks.emit('on_pre_send', {
      text: result.text || 'No response.',
      parse_mode: 'MarkdownV2',
    });

    const sendCtx = sendResult.context || { text: result.text, chunks: null };

    // 12. Stop typing and send response
    bot.stopTyping(chatId);

    if (sendCtx.chunks && sendCtx.chunks.length > 0) {
      for (let i = 0; i < sendCtx.chunks.length; i++) {
        await bot.sendMessage(chatId, sendCtx.chunks[i], {
          reply_to_message_id: i === 0 ? messageId : undefined,
        });
      }
    } else {
      await bot.sendMessage(chatId, sendCtx.text || 'No response.', {
        reply_to_message_id: messageId,
      });
    }

    // 13. Attempt auto-compaction (non-blocking)
    conversationManager.compact(claudeBridge).catch((err) => {
      logger.warn('conversation', `Auto-compaction error: ${err.message}`);
    });
  } catch (err) {
    bot.stopTyping(chatId);
    logger.error('message-handler', `Error processing message: ${err.message}`);

    // Notify user of the error
    const isTimeout = err.message?.includes('timed out');
    const userMessage = isTimeout
      ? 'Response timed out, please try again.'
      : `Sorry, an error occurred: ${err.message}`;

    await bot.sendMessage(chatId, userMessage, {
      reply_to_message_id: messageId,
      parse_mode: undefined,
    });

    // Run on_error hook
    await hooks.emit('on_error', {
      error: err,
      source: 'claude-bridge',
      context: { chatId, messageId },
    });
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info('process', `Shutdown initiated (signal=${signal})`);

  try {
    await hooks.emit('on_shutdown', { reason: signal, timestamp: Date.now() });
  } catch { /* best-effort */ }

  // Stop components in reverse order
  if (bot) {
    try { bot.stopPolling(); } catch { /* ignore */ }
  }

  if (embeddingWorker) {
    try { embeddingWorker.stop(); } catch { /* ignore */ }
  }

  if (schedulerWorker) {
    try { schedulerWorker.stop(); } catch { /* ignore */ }
  }

  if (embedTool?.server) {
    try { embedTool.server.close(); } catch { /* ignore */ }
  }

  if (webServer) {
    try { await webServer.stop(); } catch { /* ignore */ }
  }

  try { await closeDb(); } catch { /* ignore */ }

  logger.info('process', 'Shutdown complete.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main startup
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\n  2ndbrain v0.5.0\n`);

  // Step 1: Validate required config
  const firstRun = isFirstRun();
  const { valid, missing } = validateConfig();

  if (!valid && !firstRun) {
    logger.error('startup', `Missing required config: ${missing.join(', ')}`);
  }

  // Step 2 & 3: Connect to database and run migrations (if config is present)
  let dbReady = false;
  if (config.DATABASE_URL) {
    try {
      await ensureDatabase();
      await pool.query('SELECT 1');
      logger.info('startup', 'Database connection established.');
      dbReady = true;

      // Initialize logger with db pool for structured logging
      logger.init(pool);

      // Run migrations
      const applied = await migrate();
      if (applied.length > 0) {
        logger.info('startup', `Applied ${applied.length} migration(s).`);
      }
    } catch (err) {
      logger.error('startup', `Database connection failed: ${err.message}`);
    }
  }

  // Step 4: Embeddings configuration
  const embeddingsEngine = new EmbeddingsEngine({ db: { query }, config, logger });
  if (embeddingsEngine.isEnabled() && dbReady) {
    try {
      await embeddingsEngine.initialize();
    } catch (err) {
      logger.error('startup', `Embeddings initialization failed: ${err.message}`);
    }
  }

  // Start the embed_query MCP tool server if embeddings are enabled
  if (embeddingsEngine.isEnabled()) {
    try {
      embedTool = await createEmbedTool(config);
      if (embedTool) {
        config._embedServerUrl = embedTool.url;
        logger.info('startup', `embed_query MCP server listening on ${embedTool.url}`);
      }
    } catch (err) {
      logger.error('startup', `embed_query server failed to start: ${err.message}`);
    }
  }

  // Step 5: Verify claude-cli
  const claudeAvailable = verifyClaude();
  if (!claudeAvailable) {
    logger.error(
      'startup',
      'claude not found. Install Claude Code: https://claude.ai/code',
    );
    if (valid) {
      // Only fail startup if config is present (not first run)
      // On first run, we still want to show the settings page
      if (!firstRun) {
        process.exit(1);
      }
    }
  }

  // Set up runtime files (skills, hooks)
  try {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
    setupRuntimeFiles();
    logger.info('startup', 'Runtime files deployed.');
  } catch (err) {
    logger.error('startup', `Failed to set up runtime files: ${err.message}`);
  }

  // Generate MCP configuration
  let mcpConfigPath;
  if (config.DATABASE_URL) {
    try {
      mcpConfigPath = generateMcpConfig(config);
      // Override MCP_CONFIG_PATH to use the generated one
      config.MCP_CONFIG_PATH = mcpConfigPath;
      const mcpContent = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const mcpServerNames = Object.keys(mcpContent.mcpServers || {});
      logger.info('startup', `MCP config written to ${mcpConfigPath} (servers: ${mcpServerNames.join(', ')})`);
    } catch (err) {
      logger.error('startup', `Failed to generate MCP config: ${err.message}`);
    }
  }

  // Create rate limiters
  const rateLimiters = createRateLimiters();

  // Create core components
  const conversationManager = new ConversationManager({
    db: { query },
    logger,
    config,
  });

  const claudeBridge = new ClaudeBridge({ config, logger, hooks });

  // Register lifecycle hooks
  hooks.registerDefaults({
    logger,
    db: { query },
    config,
    rateLimiters,
    telegram: null, // Will be set after bot creation
    embeddingsEngine,
  });

  // Step 6: Start web admin server
  webServer = new WebServer({ config, db: { query }, logger });
  try {
    await webServer.start();
  } catch (err) {
    logger.error('startup', `Web admin server failed to start: ${err.message}`);
  }

  // Step 7: Start Telegram long-polling (only if token is configured)
  if (config.TELEGRAM_BOT_TOKEN) {
    bot = new TelegramBot({
      token: config.TELEGRAM_BOT_TOKEN,
      allowedUsers: config.TELEGRAM_ALLOWED_USERS
        ? config.TELEGRAM_ALLOWED_USERS.split(',').map((id) => id.trim())
        : [],
    });

    const attachmentStore = new AttachmentStore({
      db: { query },
      bot,
      config,
      logger,
    });

    const commandRouter = new CommandRouter({
      bot,
      logger,
      conversationManager,
      processInfo: {
        startTime,
        getMessageCount: () => conversationManager.getMessageCount(),
        getHealthStatus: async () => {
          const health = {
            status: 'ok',
            components: {
              database: { ok: dbReady },
              telegram: { ok: true },
              claude: { ok: claudeAvailable },
            },
          };
          // Check DB live status
          try {
            await query('SELECT 1');
            health.components.database.ok = true;
          } catch {
            health.components.database.ok = false;
            health.components.database.message = 'Connection failed';
          }
          // Derive overall status
          const states = Object.values(health.components);
          if (states.some((s) => !s.ok)) {
            health.status = states.every((s) => !s.ok) ? 'error' : 'degraded';
          }
          return health;
        },
      },
    });

    const deps = {
      commandRouter,
      claudeBridge,
      conversationManager,
      attachmentStore,
      rateLimiters,
      embeddingsEngine,
    };

    // Catch emitted errors so they don't throw (Node.js EventEmitter behaviour)
    bot.on('error', (err) => {
      logger.error('telegram', `Bot error: ${err.message}`);
    });

    // Wire message handler
    bot.on('message', (msg) => {
      handleMessage(msg, deps).catch((err) => {
        logger.error('message-handler', `Unhandled error: ${err.message}`);
      });
    });

    bot.startPolling();
    logger.info('startup', 'Telegram bot started.');
  } else {
    logger.warn('startup', 'TELEGRAM_BOT_TOKEN not set; Telegram bot not started.');
  }

  // Start background embedding worker
  if (embeddingsEngine.isInitialized() && dbReady) {
    embeddingWorker = new EmbeddingWorker({ db: { query }, config, logger });
    embeddingWorker.start();
  }

  // Start background scheduler worker
  if (dbReady && bot) {
    schedulerWorker = new SchedulerWorker({
      db: { query },
      config,
      logger,
      claudeBridge,
      bot,
      rateLimiters,
    });
    schedulerWorker.start();
  }

  // Step 8: Set signal handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', async (err) => {
    logger.error('process', `Uncaught exception: ${err.message}`);
    try {
      await hooks.emit('on_error', {
        error: err,
        source: 'uncaughtException',
      });
    } catch { /* best-effort */ }
    await shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('process', `Unhandled rejection: ${reason}`);
  });

  // Fire on_startup hook
  if (dbReady) {
    await hooks.emit('on_startup', { version: '0.5.0', timestamp: Date.now(), config });
  }

  logger.info('startup', 'Startup complete.');

  // Step 9: Auto-open browser
  const baseUrl = `http://${config.WEB_BIND}:${config.WEB_PORT}`;
  if (firstRun) {
    await openBrowser(`${baseUrl}/settings`);
    logger.info('startup', 'First run detected -- opening settings page.');
  } else {
    await openBrowser(baseUrl);
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(`Fatal startup error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
