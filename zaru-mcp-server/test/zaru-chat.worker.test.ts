// `zaru.chat` (Zaru ADR-0049 D1, D2, D6) through the Workers entrypoint
// (src/worker.ts), run in the Workers runtime (wrangler's local workerd) as
// worker-runtime.worker.test.ts is, with the orchestrator and Zaru Web
// replaced by the stub of zaru-chat-shared.ts. The same tests run against the
// container's Express app in zaru-chat.test.ts.
import { after, before } from "node:test";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import {
  registerZaruChatTests,
  startChatStub,
  type ChatStub,
} from "./zaru-chat-shared.js";

let stub: ChatStub;
let worker: Unstable_DevWorker;

before(async () => {
  stub = await startChatStub();
  worker = await unstable_dev("src/worker.ts", {
    config: "wrangler.jsonc",
    env: "staging",
    ip: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    vars: {
      AEGIS_ORCHESTRATOR_URL: stub.url,
      ZARU_CLIENT_URL: stub.url,
      JWKS_URI: `${stub.url}/realms/zaru-consumer/protocol/openid-connect/certs`,
    },
    experimental: { disableExperimentalWarning: true },
  });
});

after(async () => {
  await worker?.stop();
  await stub?.close();
});

registerZaruChatTests("worker", () => ({
  stub,
  post: (body, headers) =>
    worker.fetch("/mcp/v1", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as unknown as Promise<Response>,
}));
