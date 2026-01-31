import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Generate a vector embedding for the given text by calling the configured
 * OpenAI-compatible embedding provider API.
 *
 * Uses the node:https built-in module for the outbound API call.
 *
 * @param {string} text - The text to embed.
 * @param {object} config - Embedding configuration.
 * @param {string} config.EMBEDDING_API_KEY - API key for the provider.
 * @param {string} [config.EMBEDDING_MODEL] - Model name (default: text-embedding-3-small).
 * @param {string} [config.EMBEDDING_BASE_URL] - Base URL (default: https://api.openai.com/v1).
 * @param {string|number} [config.EMBEDDING_DIMENSIONS] - Override output dimensions.
 * @returns {Promise<{ vector: number[], dimensions: number }>}
 */
function generateEmbedding(text, config) {
  return new Promise((resolve, reject) => {
    const baseUrl = config.EMBEDDING_BASE_URL || DEFAULT_BASE_URL;
    const url = new URL(`${baseUrl}/embeddings`);
    const model = config.EMBEDDING_MODEL || 'text-embedding-3-small';

    const payload = { input: text, model };
    if (config.EMBEDDING_DIMENSIONS) {
      payload.dimensions = parseInt(config.EMBEDDING_DIMENSIONS, 10);
    }

    const body = JSON.stringify(payload);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.EMBEDDING_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Embedding API error (HTTP ${res.statusCode}): ${data}`));
            return;
          }
          const parsed = JSON.parse(data);
          const embedding = parsed.data[0].embedding;
          resolve({ vector: embedding, dimensions: embedding.length });
        } catch (err) {
          reject(new Error(`Failed to parse embedding response: ${err.message}`));
        }
      });
    });

    req.on('error', (err) => {
      reject(new Error(`Embedding API request failed: ${err.message}`));
    });

    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming MCP JSON-RPC 2.0 request.
 *
 * Supported methods:
 *   - initialize       -- handshake, returns server capabilities
 *   - notifications/*  -- acknowledged silently (no response)
 *   - tools/list       -- returns the embed_query tool definition
 *   - tools/call       -- executes embed_query
 *
 * @param {object} request - JSON-RPC 2.0 request object.
 * @param {object} config - Application configuration.
 * @returns {Promise<object|null>} JSON-RPC response, or null for notifications.
 */
async function handleMcpRequest(request, config) {
  const { method, id, params } = request;

  // Notifications have no id and require no response
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: '2ndbrain-embed', version: '0.5.0' },
        },
      };

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'embed_query',
              description:
                'Generate a vector embedding for a search query. ' +
                'Returns { vector: [...], dimensions: N }.',
              inputSchema: {
                type: 'object',
                properties: {
                  text: {
                    type: 'string',
                    description: 'The search query text to embed',
                  },
                },
                required: ['text'],
              },
            },
          ],
        },
      };

    case 'tools/call': {
      if (params?.name !== 'embed_query') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${params?.name}` },
        };
      }

      try {
        const result = await generateEmbedding(params.arguments.text, config);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
            isError: true,
          },
        };
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ---------------------------------------------------------------------------
// HTTP-based MCP server
// ---------------------------------------------------------------------------

/**
 * Create and start a lightweight HTTP-based MCP server that exposes the
 * embed_query tool.  The server listens on 127.0.0.1 with an
 * OS-assigned port so there is no conflict risk.
 *
 * @param {object} config - Application configuration.
 * @returns {Promise<{ server: http.Server, port: number, url: string }|null>}
 *   Resolves with server details, or null when EMBEDDING_PROVIDER is not set.
 */
function createEmbedTool(config) {
  if (!config.EMBEDDING_PROVIDER) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Only POST is meaningful for MCP JSON-RPC
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const request = JSON.parse(body);
          const response = await handleMcpRequest(request, config);

          if (response === null) {
            // Notification -- acknowledge with 202 No Content
            res.writeHead(202);
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } catch (err) {
          const errorResponse = {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: `Parse error: ${err.message}` },
          };
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(errorResponse));
        }
      });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;
      resolve({ server, port, url });
    });
  });
}

export { createEmbedTool, generateEmbedding };
export default createEmbedTool;
