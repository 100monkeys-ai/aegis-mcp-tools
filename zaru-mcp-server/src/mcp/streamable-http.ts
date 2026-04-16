import type { Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZaruRequest, ZaruUser } from "../middleware/auth.js";
import { OrchestratorClient } from "./orchestrator-client.js";
import { getZaruInit } from "../prompts/index.js";
import { searchDocs } from "../docs/index.js";

const orchestratorClient = new OrchestratorClient();

interface StreamableHttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  user: ZaruUser;
}

/** Active StreamableHTTP sessions keyed by Mcp-Session-Id header */
const sessions = new Map<string, StreamableHttpSession>();

function normalizeToolResult(result: unknown): {
  content: Array<{ type: string; text: string }>;
  isError: boolean;
} {
  if (
    result &&
    typeof result === "object" &&
    (("content" in (result as Record<string, unknown>) &&
      Array.isArray((result as Record<string, unknown>).content)) ||
      "structuredContent" in (result as Record<string, unknown>))
  ) {
    return result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
  }

  return {
    content: [
      {
        type: "text",
        text:
          typeof result === "string" ? result : JSON.stringify(result, null, 2),
      },
    ],
    isError: false,
  };
}

function createMcpServerForUser(user: ZaruUser): McpServer {
  const mcpServer = new McpServer(
    {
      name: "zaru-mcp-server",
      version: "0.15.0-pre-alpha",
    },
    {
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      instructions: "This MCP endpoint proxies AEGIS tools over SEAL v1.",
    },
  );

  mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await orchestratorClient.listTools(user);
    return {
      tools: [
        ...tools,
        {
          name: "zaru.init",
          description: `Initialize Zaru — an AI agent orchestration assistant powered by the AEGIS platform. Zaru can discover, execute, and coordinate AI agents, build multi-agent workflows, manage credentials and secrets, and operate the full platform. Call this tool when the user wants to activate Zaru, says "zaru init", or asks for Zaru's help with agent orchestration. Returns a system prompt to adopt and the available tools for the requested mode. If no mode is specified, defaults to chat mode.

Available modes:
- chat: Conversation, planning, and Q&A — no tool execution
- agentic: Discover and orchestrate AI agents to perform tasks
- workflow: Design state machines that chain agents with conditional transitions
- execute: Turn natural language intent into running code in one shot
- operator: Full platform access including destructive operations and deployment`,
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["chat", "agentic", "workflow", "execute", "operator"],
                description:
                  "Conversation mode. Defaults to chat if not specified.",
              },
            },
          },
        },
        {
          name: "zaru.docs",
          description:
            "Search the AEGIS and Zaru documentation. Use this when the user asks how to do something, needs help with a feature, or wants to understand a concept. Returns relevant documentation sections.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search query — what the user wants to know about. Examples: 'how to create an agent', 'workflow state machine', 'MCP setup', 'pricing plans'",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "zaru.mode",
          description:
            "Switch Zaru's conversation mode. Returns the updated system prompt and available tools for the new mode. Use this when the user's intent shifts — for example, from chatting about a task to actually executing it with agents.",
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: ["chat", "agentic", "workflow", "execute", "operator"],
                description: "Target conversation mode",
              },
              reason: {
                type: "string",
                description:
                  "Short explanation of why the mode switch is appropriate",
              },
            },
            required: ["mode"],
          },
        },
      ],
    };
  });

  mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle client-side tools locally — never forward to AEGIS
    if (name === "zaru.init") {
      const mode = (args as Record<string, unknown>)?.mode as
        | string
        | undefined;
      const result = getZaruInit(mode);
      if (!result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Unknown mode" }) },
          ],
          isError: true,
        };
      }
      return normalizeToolResult(result);
    }

    if (name === "zaru.docs") {
      const query = (args as Record<string, unknown>)?.query as string;
      if (!query) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Query is required" }),
            },
          ],
          isError: true,
        };
      }
      try {
        const result = await searchDocs(query);
        return normalizeToolResult(result);
      } catch (err) {
        console.error(
          "zaru.docs search failed:",
          err instanceof Error ? err.message : err,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: "Failed to search docs" }),
            },
          ],
          isError: true,
        };
      }
    }

    if (name === "zaru.mode") {
      const targetMode = (args as Record<string, unknown>)?.mode as string;
      const reason = (args as Record<string, unknown>)?.reason as
        | string
        | undefined;
      const result = getZaruInit(targetMode);
      if (!result) {
        return {
          content: [
            { type: "text", text: JSON.stringify({ error: "Unknown mode" }) },
          ],
          isError: true,
        };
      }
      return normalizeToolResult({
        ...result,
        reason,
        action: "mode_switch_requested",
      });
    }

    try {
      const result = await orchestratorClient.invokeTool(
        user,
        name,
        args ?? {},
        null,
      );
      return normalizeToolResult(result);
    } catch (error) {
      console.error(
        `Tool invocation failed: ${name}`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  });

  return mcpServer;
}

/**
 * POST /mcp/v1 - Handle StreamableHTTP requests.
 *
 * Creates a per-request transport (stateless mode) or reuses an existing
 * session if an Mcp-Session-Id header is present.
 */
export async function handleStreamableHttp(
  req: ZaruRequest,
  res: Response,
): Promise<void> {
  const user = req.zaruUser;
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // If a session ID is provided, try to reuse the existing session
  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }
    // Session not found - fall through to create a new one
  }

  // Create a new transport and server for this session
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  const server = createMcpServerForUser(user);
  await server.connect(transport);

  // Store the session if a session ID was generated
  const newSessionId = transport.sessionId;
  if (newSessionId) {
    const session: StreamableHttpSession = { transport, server, user };
    sessions.set(newSessionId, session);

    console.log(
      `StreamableHTTP session established: ${newSessionId} for user ${user.userId}`,
    );
  }

  await transport.handleRequest(req, res, req.body);
}

/**
 * GET /mcp/v1 - Server-initiated notifications via SSE (per StreamableHTTP spec).
 *
 * For now, we don't support server-initiated push, so return 405.
 */
export async function handleStreamableHttpGet(
  req: ZaruRequest,
  res: Response,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId) {
    const existing = sessions.get(sessionId);
    if (existing) {
      // Delegate to the transport's GET handling for SSE streams
      await existing.transport.handleRequest(req, res);
      return;
    }
  }

  res
    .status(405)
    .json({ error: "Method Not Allowed: server-initiated push not supported" });
}

/**
 * DELETE /mcp/v1 - Session cleanup.
 */
export async function handleStreamableHttpDelete(
  req: ZaruRequest,
  res: Response,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId) {
    res.status(400).json({ error: "Missing Mcp-Session-Id header" });
    return;
  }

  const session = sessions.get(sessionId);
  if (session) {
    await session.server.close();
    sessions.delete(sessionId);
    console.log(`StreamableHTTP session deleted: ${sessionId}`);
  }

  res.status(200).json({ status: "ok" });
}
