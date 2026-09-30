/**
 * The Worker's environment: the vars in wrangler.jsonc and the secrets put
 * with `wrangler secret put`. Every name is the one the container reads
 * (aegis-platform-deployment `podman/pods/zaru/pod-zaru.yaml`, container
 * `zaru-mcp-server`), unchanged, so one module reads either entrypoint's
 * configuration: under `nodejs_compat` with a compatibility date on or after
 * 2025-04-01 the runtime fills `process.env` from these bindings before the
 * modules are evaluated, and the modules keep reading `process.env`.
 *
 * What changes on Workers is the value, not the name: the pod reaches its
 * neighbours by pod-local names (`http://aegis-core:8088`,
 * `http://zaru-client:3000`), which a Worker cannot resolve, so each URL here
 * is the service's public URL. `PORT` is the container's listening port and
 * has no meaning for a Worker.
 */
export interface Env {
  /** The AEGIS orchestrator and SEAL endpoints (`/v1/seal/*`, `/v1/executions/*`). */
  AEGIS_ORCHESTRATOR_URL: string;
  /** Zaru Web, for Zaru User Memory (ADR-118). */
  ZARU_CLIENT_URL: string;
  /** The consumer realm's key set; its issuer is derived from it (src/middleware/auth.ts). */
  JWKS_URI: string;
  EXPECTED_AUDIENCE: string;
  LOG_LEVEL: string;
  /** Sent to the orchestrator as the SEAL attestation's `container_id`. */
  CONTAINER_ID: string;

  // Optional, read when set; none is set by the pod today.
  KEYCLOAK_SYSTEM_ISSUER?: string;
  KEYCLOAK_TRUSTED_ISSUERS?: string;
  AEGIS_TOOL_DISCOVERY_URL?: string;
  AEGIS_TOOL_CACHE_TTL_MS?: string;
  LOG_TOOL_ARGS?: string;
}
