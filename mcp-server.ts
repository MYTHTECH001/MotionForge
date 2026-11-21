import 'dotenv/config';
import readline from 'node:readline';
import {
  handleMcpJsonRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './src/mcp/mcpCore.ts';

/**
 * Standalone stdio Model Context Protocol (MCP) server for local
 * Claude Code and OpenAI Codex CLI integrations.
 *
 * Run via: npx tsx mcp-server.ts
 */
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

const writeMessage = (payload: JsonRpcResponse | JsonRpcResponse[]) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const parsed = JSON.parse(trimmed) as JsonRpcRequest | JsonRpcRequest[];
    if (Array.isArray(parsed)) {
      const results = (
        await Promise.all(parsed.map((item) => handleMcpJsonRpc(item)))
      ).filter((r): r is JsonRpcResponse => r !== null);
      if (results.length > 0) writeMessage(results);
    } else {
      const res = await handleMcpJsonRpc(parsed);
      if (res) writeMessage(res);
    }
  } catch {
    writeMessage({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
});
