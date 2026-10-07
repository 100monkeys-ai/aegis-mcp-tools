// A conversation's chosen context (AEGIS ADR-132 S7, S8) through the Workers
// entrypoint (src/worker.ts), run in the Workers runtime (wrangler's local
// workerd) as worker-runtime.worker.test.ts is, with the orchestrator
// replaced by the stub of context-tools-shared.ts. The same tests run against
// the container's Express app in context-tools.test.ts.
import { after, before } from "node:test";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import {
  registerContextToolsTests,
  startContextStub,
  type ContextStub,
} from "./context-tools-shared.js";

let stub: ContextStub;
let worker: Unstable_DevWorker;

before(async () => {
  stub = await startContextStub();
  worker = await unstable_dev("src/worker.ts", {
    config: "wrangler.jsonc",
    env: "staging",
    ip: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    persist: false,
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

registerContextToolsTests("worker", () => ({
  stub,
  post: (body, headers) =>
    worker.fetch("/mcp/v1", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as unknown as Promise<Response>,
}));
