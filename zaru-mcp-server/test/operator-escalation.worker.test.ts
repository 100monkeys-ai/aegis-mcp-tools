// The operator escalation (Zaru ADR-0050 D3 to D6) through the Workers
// entrypoint (src/worker.ts), run in the Workers runtime (wrangler's local
// workerd) as zaru-chat.worker.test.ts is, with the orchestrator replaced by
// the stub of operator-escalation-shared.ts. The same tests run against the
// container's Express app in operator-escalation.test.ts.
import { after, before } from "node:test";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import {
  registerEscalationToolTests,
  registerOperatorSurfaceTests,
  startEscalationStub,
  type EscalationStub,
} from "./operator-escalation-shared.js";

let stub: EscalationStub;
let worker: Unstable_DevWorker;

before(async () => {
  stub = await startEscalationStub();
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

const context = () => ({
  stub,
  post: (body: unknown, headers?: Record<string, string>) =>
    worker.fetch("/mcp/v1", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as unknown as Promise<Response>,
});

registerOperatorSurfaceTests("worker", context);
registerEscalationToolTests("worker", context);
