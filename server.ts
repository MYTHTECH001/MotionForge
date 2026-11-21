import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAnimationPayload } from './src/animation/validator.ts';
import type { PropType } from './src/animation/types.ts';
import {
  GeminiGenerationError,
  generateAnimationFromPrompt,
  isGeminiConfigured,
  refineAnimation,
} from './src/server/geminiGenerator.ts';
import {
  MCP_TOOLS,
  deleteSharedWorkspaceClip,
  deleteSharedWorkspaceSession,
  handleMcpJsonRpc,
  listSharedWorkspaceClips,
  saveSharedWorkspaceClip,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './src/mcp/mcpCore.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const mcpEnabled = process.env.ENABLE_MCP !== 'false';
const MCP_COOKIE_NAME = 'mf_mcp_session';

function parseCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(eqIdx + 1).trim());
    }
  }
  return null;
}

function resolveMcpSessionId(
  req: express.Request,
  res: express.Response,
): string {
  const headerVal = req.headers['mcp-session-id'];
  const rawHeader =
    typeof headerVal === 'string' ? headerVal.trim() : undefined;
  const cookieVal = parseCookieValue(req.headers.cookie, MCP_COOKIE_NAME);
  const candidate = rawHeader || cookieVal || '';

  const valid = /^[a-zA-Z0-9_-]{8,128}$/.test(candidate);
  const sessionId = valid ? candidate : crypto.randomUUID();

  res.setHeader('Mcp-Session-Id', sessionId);
  if (!cookieVal || cookieVal !== sessionId) {
    res.setHeader(
      'Set-Cookie',
      `${MCP_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax`,
    );
  }
  return sessionId;
}

async function createServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  const aiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: {
      error: 'Too many AI animation requests. Please wait a minute and try again.',
    },
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: isGeminiConfigured(),
      mcpEnabled,
      mcpEndpoint: mcpEnabled ? '/mcp' : null,
    });
  });

  app.post('/api/generate-animation', aiRateLimiter, async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
    const duration =
      typeof body?.duration === 'number' ? body.duration : undefined;
    const prop =
      body?.prop === 'net' ||
      body?.prop === 'sword' ||
      body?.prop === 'none' ||
      body?.prop === 'auto'
        ? (body.prop as PropType | 'auto')
        : 'auto';
    const loop = typeof body?.loop === 'boolean' ? body.loop : true;

    try {
      const result = await generateAnimationFromPrompt({
        prompt,
        duration,
        prop,
        loop,
      });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof GeminiGenerationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unknown error generating animation.',
      });
    }
  });

  app.post('/api/refine-animation', aiRateLimiter, async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const instruction =
      typeof body?.instruction === 'string' ? body.instruction : '';
    const project = body?.project;

    try {
      const result = await refineAnimation({ project, instruction });
      res.json(result);
    } catch (err: unknown) {
      if (err instanceof GeminiGenerationError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unknown error refining animation.',
      });
    }
  });

  const requireMcpEnabled: express.RequestHandler = (_req, res, next) => {
    if (!mcpEnabled) {
      res.status(404).json({
        error: 'MCP server is disabled (ENABLE_MCP=false).',
      });
      return;
    }
    next();
  };

  // Shared MCP Workspace Clip Bridge (session-scoped)
  app.get('/api/mcp/clips', requireMcpEnabled, (req, res) => {
    const sessionId = resolveMcpSessionId(req, res);
    res.json({
      sessionId,
      clips: listSharedWorkspaceClips(sessionId),
    });
  });

  app.post('/api/mcp/clips', requireMcpEnabled, (req, res) => {
    const sessionId = resolveMcpSessionId(req, res);
    const body = req.body as Record<string, unknown> | undefined;
    const validation = validateAnimationPayload(body?.project ?? body);
    if (!validation.valid || !validation.project) {
      res.status(422).json({
        error: `Invalid AnimationProject: ${validation.errors.join(' ')}`,
      });
      return;
    }
    const id = typeof body?.id === 'string' ? body.id : undefined;
    const saved = saveSharedWorkspaceClip(
      validation.project,
      id,
      'studio',
      sessionId,
    );
    res.json({ sessionId, clip: saved });
  });

  app.delete('/api/mcp/clips/:id', requireMcpEnabled, (req, res) => {
    const sessionId = resolveMcpSessionId(req, res);
    const deleted = deleteSharedWorkspaceClip(String(req.params.id), sessionId);
    res.json({ deleted });
  });

  // Streamable HTTP MCP Endpoint (compatible with Claude Code & OpenAI Codex CLI)
  const setMcpCorsHeaders = (res: express.Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id, MCP-Protocol-Version',
    );
    res.setHeader('MCP-Protocol-Version', '2025-03-26');
  };

  app.options('/mcp', requireMcpEnabled, (_req, res) => {
    setMcpCorsHeaders(res);
    res.status(204).end();
  });

  app.get('/mcp', requireMcpEnabled, (req, res) => {
    setMcpCorsHeaders(res);
    const accept = String(req.headers.accept || '');
    if (accept.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(': MotionForge MCP Streamable HTTP ready\n\n');
      const keepAlive = setInterval(() => {
        res.write(': ping\n\n');
      }, 25000);
      req.on('close', () => {
        clearInterval(keepAlive);
      });
      return;
    }

    res.json({
      name: 'motionforge-r15',
      version: '2.0.0',
      transport: 'streamable-http',
      protocolVersions: ['2025-03-26', '2024-11-05'],
      endpoint: '/mcp',
      tools: MCP_TOOLS.map((t) => t.name),
    });
  });

  app.post('/mcp', requireMcpEnabled, async (req, res) => {
    setMcpCorsHeaders(res);
    const payload = req.body as JsonRpcRequest | JsonRpcRequest[];

    if (!payload || (typeof payload !== 'object' && !Array.isArray(payload))) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON-RPC payload' },
      });
      return;
    }

    const sessionId = resolveMcpSessionId(req, res);

    if (Array.isArray(payload)) {
      const results = (
        await Promise.all(
          payload.map((item) => handleMcpJsonRpc(item, sessionId)),
        )
      ).filter((r): r is JsonRpcResponse => r !== null);
      if (results.length === 0) {
        res.status(202).end();
        return;
      }
      res.json(results);
      return;
    }

    const result = await handleMcpJsonRpc(payload, sessionId);
    if (!result) {
      res.status(202).end();
      return;
    }
    res.json(result);
  });

  app.delete('/mcp', requireMcpEnabled, (req, res) => {
    setMcpCorsHeaders(res);
    const headerVal = req.headers['mcp-session-id'];
    const rawHeader =
      typeof headerVal === 'string' ? headerVal.trim() : undefined;
    const cookieVal = parseCookieValue(req.headers.cookie, MCP_COOKIE_NAME);
    const sessionId = rawHeader || cookieVal;
    if (sessionId) {
      deleteSharedWorkspaceSession(sessionId);
    }
    res.status(200).json({ ok: true });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`MotionForge server listening on http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Failed to start MotionForge server:', err);
  process.exit(1);
});
