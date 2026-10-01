// `zaru.chat` (Zaru ADR-0049 D1, D2, D6) through the container's entrypoint:
// the real Express app of src/app.ts behind the real auth middleware, on an
// ephemeral loopback port, with the orchestrator and Zaru Web replaced by the
// stub of zaru-chat-shared.ts. The same tests run against the Workers
// entrypoint in zaru-chat.worker.test.ts.
import { after, before } from "node:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerZaruChatTests,
  startChatStub,
  type ChatStub,
} from "./zaru-chat-shared.js";

let stub: ChatStub;
let server: Server;
let base: string;

before(async () => {
  stub = await startChatStub();
  // auth.ts, orchestrator-client.ts and streamable-http.ts read these at
  // import time.
  process.env.AEGIS_ORCHESTRATOR_URL = stub.url;
  process.env.ZARU_CLIENT_URL = stub.url;
  process.env.JWKS_URI = `${stub.url}/realms/zaru-consumer/protocol/openid-connect/certs`;
  delete process.env.AEGIS_TOOL_DISCOVERY_URL;
  delete process.env.BYPASS_AUTH;
  const { app } = await import("../src/app.js");
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await stub?.close();
});

registerZaruChatTests("container", () => ({
  stub,
  post: (body, headers) =>
    fetch(`${base}/mcp/v1`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
}));
