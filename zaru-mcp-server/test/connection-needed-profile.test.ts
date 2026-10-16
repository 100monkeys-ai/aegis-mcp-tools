// Zaru ADR-0071 (deny by default) D1 (e) and D3, the Zaru MCP server's
// `zaru.connection.needed`, arc `connection-needed-profile`:
//
// A request on an API key with no profile (its own or one it names) and no
// binding chosen reaches none of the person's connections, and is listed no
// tool of any connection family. `zaru.connection.needed` must say so: the
// answer is ADR-0070's `needs` `{family: "profile", page: "/vault/profiles"}`
// with D1 (e)'s key sentence, whatever the person has connected and whether
// or not `x-zaru-turn` is sent (Trigger 2 (c): it decides nothing about
// reach). A key on a profile, a key whose request chooses a binding, and the
// person's own session answer as before.
//
// The orchestrator is a stub: the test runs its own in-memory route and never
// reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { OrchestratorClient } from "../src/mcp/orchestrator-client.js";
import { createMcpServerForUser, type McpRequestContext } from "../src/mcp/streamable-http.js";
import type { ZaruUser } from "../src/middleware/auth.js";

/** D1 (e)'s sentence for a key, verbatim from the record. */
const KEY_SENTENCE =
  "This key reaches none of your connections. Choose a profile for it on the API keys page in Zaru Web, or name one in the request.";
const PROFILE_NEEDS = { family: "profile", page: "/vault/profiles" };

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const tool = (name: string): Tool => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

/** Every family connected: the person's own listing holds a tool of each. */
const EVERY_FAMILY = ["mail.list", "calendar.list", "github.list_repositories", "nuclear-notes.search", "web.fetch"];

function stubClient(profileListed: string[] = []): OrchestratorClient {
  return {
    listTools: async () => EVERY_FAMILY.map(tool),
    listContextTools: async (_user: ZaruUser, choice: { profile?: string }) =>
      choice.profile !== undefined ? profileListed.map(tool) : [],
    invokeTool: async () => {
      throw new Error("zaru.connection.needed must call nothing but the listings");
    },
  } as unknown as OrchestratorClient;
}

const KEY_USER: ZaruUser = {
  userId: "user-1",
  tier: "pro",
  securityContext: "zaru-pro",
  token: "aegis_test-key",
  isOperator: false,
  tenantId: "tenant-1",
};
const KEY_USER_ON_PROFILE: ZaruUser = { ...KEY_USER, keyProfile: "profile-1" };
const SESSION_USER: ZaruUser = { ...KEY_USER, token: "header.payload.signature" };

async function needed(
  user: ZaruUser,
  context: McpRequestContext,
  family: string,
  profileListed?: string[],
): Promise<Record<string, unknown>> {
  const server = createMcpServerForUser(user, new Set(), "connection-needed-profile", stubClient(profileListed), context);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "connection-needed-profile", version: "0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name: "zaru.connection.needed", arguments: { family } })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    assert.notEqual(result.isError, true, result.content[0]?.text);
    return JSON.parse(result.content[0]!.text);
  } finally {
    await client.close();
    await server.close();
  }
}

for (const family of ["mailbox", "calendar", "github", "nuclear-notes"]) {
  test(`a key with no profile and no choice is told to choose a profile for ${family}, whatever is connected`, async () => {
    assert.deepEqual(await needed(KEY_USER, {}, family), { needs: PROFILE_NEEDS, sentence: KEY_SENTENCE });
  });
}

test("a key with no profile is told the same when x-zaru-turn is sent: the header decides nothing about reach", async () => {
  assert.deepEqual(await needed(KEY_USER, { zaruTurn: true }, "mailbox"), {
    needs: PROFILE_NEEDS,
    sentence: KEY_SENTENCE,
  });
});

test("a key on a profile that lacks the family answers as before: the profile does not allow it", async () => {
  assert.deepEqual(await needed(KEY_USER_ON_PROFILE, {}, "mailbox", ["calendar.list"]), {
    needs: { family: "profile", page: "/vault/profiles/profile-1" },
    sentence:
      "The profile chosen for this conversation does not allow this. Change it on the profile's page in Zaru Web.",
  });
});

test("a key on a profile that names the family answers as before: connected and chosen", async () => {
  assert.deepEqual(await needed(KEY_USER_ON_PROFILE, {}, "mailbox", ["mail.list"]), {
    needs: null,
    sentence: "Your mailbox is connected and chosen for this conversation.",
  });
});

test("a key whose request chooses a binding answers as before", async () => {
  assert.deepEqual(await needed(KEY_USER, { contexts: { imap: "binding-1" } }, "mailbox"), {
    needs: null,
    sentence: "Your mailbox is connected to Zaru.",
  });
});

test("the person's own session with no profile answers as before", async () => {
  assert.deepEqual(await needed(SESSION_USER, {}, "mailbox"), {
    needs: null,
    sentence: "Your mailbox is connected to Zaru.",
  });
});

test("the person's own chat turn with nothing chosen answers as before: connected but not chosen", async () => {
  assert.deepEqual(await needed(SESSION_USER, { zaruTurn: true }, "mailbox"), {
    needs: { family: "mailbox", page: "/vault/connections" },
    sentence:
      "Your mailbox is connected but not chosen for this conversation. Choose it under Context above the chat input.",
  });
});
