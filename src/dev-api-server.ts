import express, { NextFunction, Request, Response } from 'express';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { ConfigManager } from './config.js';
import { YouTrackMCPServer, toolDefinitions } from './server-core.js';
import { MCPResponse } from './api/base/base-client.js';
import { logger } from './logger.js';

// Load environment variables before any config validation
dotenv.config();

const PORT = Number.parseInt(process.env.DEV_API_PORT || '4100', 10);

const configManager = new ConfigManager();

try {
  configManager.validate();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown configuration error';
  logger.error('Failed to start dev API server: configuration invalid', {
    error: message,
  });
  process.exit(1);
}

const config = configManager.get();
const youTrackServer = new YouTrackMCPServer();

const app = express();
app.use(express.json({ limit: '1mb' }));

function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

function parseMcpResponse(mcpResponse: MCPResponse): any {
  const texts = mcpResponse.content
    .filter((item) => item.type === 'text' && Boolean(item.text))
    .map((item) => item.text.trim())
    .filter(Boolean);

  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch {
      // Try the next payload
    }
  }

  if (texts.length === 1) {
    return { raw: texts[0] };
  }

  return { raw: texts };
}

function sendMcp(res: Response, response: MCPResponse): void {
  res.json(parseMcpResponse(response));
}

function extractArguments(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return {};
  }

  const maybeArgs = (body as Record<string, unknown>).arguments;
  if (maybeArgs && typeof maybeArgs === 'object') {
    return maybeArgs as Record<string, unknown>;
  }

  return body as Record<string, unknown>;
}

function mapMcpErrorToStatus(error: McpError): number {
  switch (error.code) {
    case ErrorCode.InvalidParams:
    case ErrorCode.InvalidRequest:
    case ErrorCode.ParseError:
      return 400;
    case ErrorCode.MethodNotFound:
      return 404;
    case ErrorCode.ConnectionClosed:
      return 502;
    default:
      return 500;
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    youtrackUrl: config.youtrackUrl,
    toolCount: toolDefinitions.length,
    tools: toolDefinitions.map((tool) => tool.name),
  });
});

app.get('/tools', (_req, res) => {
  res.json({ tools: toolDefinitions });
});

app.post(
  '/tools/:toolName',
  asyncHandler(async (req, res) => {
    const { toolName } = req.params;
    const args = extractArguments(req.body);
    const response = await youTrackServer.executeTool(toolName, args);
    sendMcp(res, response);
  })
);

app.post(
  '/call',
  asyncHandler(async (req, res) => {
    const { name, arguments: args = {} } = req.body || {};

    if (!name || typeof name !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Request body must include "name" (string) for the tool to invoke',
      });
      return;
    }

    const response = await youTrackServer.executeTool(name, args as Record<string, unknown>);
    sendMcp(res, response);
  })
);

app.use((error: unknown, _req: Request, res: Response) => {
  if (error instanceof McpError) {
    const status = mapMcpErrorToStatus(error);
    logger.warn('Tool invocation failed with MCP error', {
      code: error.code,
      message: error.message,
    });
    res.status(status).json({
      success: false,
      error: error.message,
      code: error.code,
    });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  logger.error('Dev API request failed', { message });
  res.status(500).json({
    success: false,
    error: message,
  });
});

app.listen(PORT, () => {
  logger.info('YouTrack dev MCP API server ready', {
    port: PORT,
    youtrackUrl: config.youtrackUrl,
    toolCount: toolDefinitions.length,
  });
});
