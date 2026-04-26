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

/**
 * Extract an array of script DTOs from an `aegis.script.list` tool result.
 *
 * The SEAL-gateway wraps orchestrator responses in an MCP tool-call envelope:
 *   `{ content: [{ type: "text", text: "<JSON string>" }], isError: false }`
 * — where the `text` holds the JSON-serialized array returned by the
 * orchestrator's `GET /v1/scripts` endpoint. We also tolerate direct arrays
 * and `{type: "json"}` envelopes in case upstream shapes change.
 */
export function extractScriptsArray(
  result: unknown,
): Array<{ id: string; name: string }> {
  if (Array.isArray(result)) {
    return result as Array<{ id: string; name: string }>;
  }
  if (!result || typeof result !== "object") {
    return [];
  }
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content) && r.content[0]) {
    const first = r.content[0] as Record<string, unknown>;
    if (first.type === "text" && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text);
        if (Array.isArray(parsed)) {
          return parsed as Array<{ id: string; name: string }>;
        }
      } catch {
        // fall through — not valid JSON, return empty
      }
    }
    if (
      first.type === "json" &&
      first.json &&
      Array.isArray(first.json as unknown)
    ) {
      return first.json as Array<{ id: string; name: string }>;
    }
  }
  return [];
}

interface StreamableHttpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  user: ZaruUser;
}

/** Active StreamableHTTP sessions keyed by Mcp-Session-Id header */
const sessions = new Map<string, StreamableHttpSession>();

/**
 * Dispatch `zaru.script.save` / `zaru.script.run` onto the orchestrator via the
 * SEAL-gateway `aegis.script.*` native tools.
 *
 * `zaru.script.save` is a thin pass-through to `aegis.script.save`.
 * `zaru.script.run` loads the script DTO (by `id` or by `name` via
 * `aegis.script.list` + exact-match resolution) and returns it to the LLM so
 * the caller can execute the `code` field via `zaru.execute_typescript`.
 *
 * Exported for unit testing.
 */
export async function handleZaruScriptTool(
  client: Pick<OrchestratorClient, "invokeTool">,
  user: ZaruUser,
  name: "zaru.script.save" | "zaru.script.run",
  args: unknown,
): Promise<{
  content: Array<{ type: string; text: string }>;
  isError: boolean;
}> {
  if (name === "zaru.script.save") {
    const result = await client.invokeTool(
      user,
      "aegis.script.save",
      (args as Record<string, unknown>) ?? {},
      null,
    );
    return normalizeToolResult(result);
  }

  // zaru.script.run
  const a = (args as Record<string, unknown>) ?? {};
  const scriptId = typeof a.id === "string" ? a.id : undefined;
  const scriptName = typeof a.name === "string" ? a.name : undefined;

  if (!scriptId && !scriptName) {
    return normalizeToolResult({
      isError: true,
      content: [
        {
          type: "text",
          text: "zaru.script.run requires either 'id' or 'name' to look up the script.",
        },
      ],
    });
  }

  let resolvedId = scriptId;
  if (!resolvedId && scriptName) {
    const listResult = await client.invokeTool(
      user,
      "aegis.script.list",
      { q: scriptName },
      null,
    );
    const scripts = extractScriptsArray(listResult);
    const matches = scripts.filter(
      (s) => s.name?.toLowerCase() === scriptName.toLowerCase(),
    );
    if (matches.length === 0) {
      return normalizeToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: `No saved script named "${scriptName}".`,
          },
        ],
      });
    }
    if (matches.length > 1) {
      return normalizeToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: `Multiple saved scripts match "${scriptName}". Specify by id instead: ${matches
              .map((m) => m.id)
              .join(", ")}.`,
          },
        ],
      });
    }
    resolvedId = matches[0].id;
  }

  const scriptResult = await client.invokeTool(
    user,
    "aegis.script.get",
    { id: resolvedId },
    null,
  );
  return normalizeToolResult(scriptResult);
}

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

/**
 * Tool calls that may carry an `attachments` array per ADR-113. Only clients
 * that declare the "chat-uploads" capability are permitted to forward
 * attachments to these tools — defence-in-depth on top of the orchestrator and
 * the Zaru web client gates.
 */
const ATTACHMENT_CAPABLE_TOOLS = new Set([
  "aegis.task.execute",
  "aegis.agent.generate",
  "aegis.execute.intent",
]);

/**
 * Returns true if a tool call payload includes a non-empty `attachments` field
 * — either at the top level or nested under `input` (the conventional shape
 * for `aegis.task.execute` / `aegis.agent.generate` / `aegis.execute.intent`).
 */
function hasAttachments(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const a = args as Record<string, unknown>;
  if (Array.isArray(a.attachments) && a.attachments.length > 0) return true;
  const input = a.input;
  if (input && typeof input === "object") {
    const i = input as Record<string, unknown>;
    if (Array.isArray(i.attachments) && i.attachments.length > 0) return true;
  }
  const inputs = a.inputs;
  if (inputs && typeof inputs === "object") {
    const i = inputs as Record<string, unknown>;
    if (Array.isArray(i.attachments) && i.attachments.length > 0) return true;
  }
  return false;
}

function createMcpServerForUser(user: ZaruUser): McpServer {
  // Per-session capability state, populated by the client via `zaru.init` /
  // `zaru.mode`. Used to enforce the chat-uploads gate on subsequent tool
  // calls within this session.
  const sessionCapabilities = new Set<string>();

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
- live: Write and run TypeScript programs in a client-side QuickJS WASM sandbox with AEGIS SDK bindings
- operator: Full platform access including destructive operations and deployment`,
          inputSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                enum: [
                  "chat",
                  "agentic",
                  "workflow",
                  "execute",
                  "live",
                  "operator",
                ],
                description:
                  "Conversation mode. Defaults to chat if not specified.",
              },
              client: {
                type: "object",
                properties: {
                  runtime: { type: "string" },
                  capabilities: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
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
                enum: [
                  "chat",
                  "agentic",
                  "workflow",
                  "execute",
                  "live",
                  "operator",
                ],
                description: "Target conversation mode",
              },
              reason: {
                type: "string",
                description:
                  "Short explanation of why the mode switch is appropriate",
              },
              client: {
                type: "object",
                description:
                  "Optional client descriptor — re-asserts runtime and capabilities on mode switch. If omitted, the capabilities recorded at zaru.init time are preserved.",
                properties: {
                  runtime: { type: "string" },
                  capabilities: {
                    type: "array",
                    items: { type: "string" },
                  },
                },
              },
            },
            required: ["mode"],
          },
        },
        {
          name: "zaru.script.save",
          description:
            "Save a reusable TypeScript script to the user's script library for later use.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Script name for later retrieval",
              },
              description: {
                type: "string",
                description: "Short description of what the script does",
              },
              code: {
                type: "string",
                description: "TypeScript source code to save",
              },
            },
            required: ["name", "description", "code"],
          },
        },
        {
          name: "zaru.script.run",
          description: "Load and execute a previously saved script by name.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Name of the saved script to run",
              },
              input: {
                type: "object",
                description: "Optional input parameters to pass to the script",
              },
            },
            required: ["name"],
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
      const client = (args as Record<string, unknown>)?.client as
        | { runtime?: string; capabilities?: string[] }
        | undefined;
      // Record the client's declared capabilities for this session so
      // downstream tool calls can be gated (e.g. chat-uploads / attachments).
      sessionCapabilities.clear();
      for (const cap of client?.capabilities ?? []) {
        sessionCapabilities.add(cap);
      }
      const result = getZaruInit(mode, client);
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
      const client = (args as Record<string, unknown>)?.client as
        | { runtime?: string; capabilities?: string[] }
        | undefined;
      // If the client re-asserts capabilities on mode switch, refresh the
      // session record. Otherwise preserve what was set at zaru.init time.
      if (client?.capabilities) {
        sessionCapabilities.clear();
        for (const cap of client.capabilities) {
          sessionCapabilities.add(cap);
        }
      }
      const result = getZaruInit(
        targetMode,
        client ?? {
          capabilities: Array.from(sessionCapabilities),
        },
      );
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

    if (name === "zaru.execute_typescript") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "execute_typescript is a client-side tool and must be handled by the client, not the MCP server.",
            }),
          },
        ],
        isError: true,
      };
    }

    if (name === "zaru.script.save" || name === "zaru.script.run") {
      return handleZaruScriptTool(orchestratorClient, user, name, args);
    }

    // ADR-113 defence-in-depth: reject `attachments` from any client that has
    // not declared the "chat-uploads" capability for this session. The
    // orchestrator and the Zaru web client also gate this — the MCP server
    // must not silently forward attachments from a non-capable client.
    if (
      ATTACHMENT_CAPABLE_TOOLS.has(name) &&
      hasAttachments(args) &&
      !sessionCapabilities.has("chat-uploads")
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error:
                "attachments are only accepted from clients that declare the 'chat-uploads' capability via zaru.init.",
            }),
          },
        ],
        isError: true,
      };
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
