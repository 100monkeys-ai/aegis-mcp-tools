import type { NextFunction, Request, Response } from "express";
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from "jose";

export interface ZaruUser {
  userId: string;
  tier: string;
  securityContext: string;
  token: string;
  isOperator: boolean;
  tenantId?: string;
  /**
   * Present only while the presented API key holds an operator escalation
   * (Zaru ADR-0050 D5): its end, as the orchestrator's validate answer gave
   * it. `zaru.operator.release` is listed only while it is set (D4).
   */
  operatorEscalation?: { expiresAt: string };
}

export interface ZaruRequest extends Request {
  zaruUser?: ZaruUser;
  /**
   * Correlation id populated by `requestIdMiddleware`. Optional in the
   * type because the middleware runs before route handlers but after
   * any pre-app pipeline that might construct a `ZaruRequest`.
   */
  requestId?: string;
}

export type AegisRole = "admin" | "operator" | "readonly";

export type VerifiedClaims = JWTPayload & {
  sub: string;
  zaru_tier?: string;
  aegis_role?: AegisRole;
  tenant_id?: string;
  /**
   * List of team tenant ids the user is a member of. Mirrors the
   * `team_memberships` table populated by the orchestrator's team
   * service. Validated against the `x-zaru-active-tenant` header so
   * a forged cookie cannot elevate a caller into a team they do not
   * belong to.
   */
  team_memberships?: string[];
};

export type JwtVerifier = (token: string) => Promise<VerifiedClaims>;

// ── API Key Authentication ──────────────────────────────────────────────────

const API_KEY_PREFIX = "aegis_";

export function isApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Response shape from the orchestrator's `POST /v1/api-keys/validate` endpoint.
 * Returns the identity associated with the API key.
 *
 * `aegis_role` is in the orchestrator's spelling (`aegis:admin`,
 * `aegis:operator`, `aegis:readonly`). While a key with no stored role holds
 * an operator escalation it is the escalation's role and `operator_escalation`
 * carries the escalation's end (AEGIS ADR-129 D14 and its Update U7).
 */
export interface ApiKeyIdentity {
  user_id: string;
  tenant_id: string | null;
  aegis_role: string | null;
  zaru_tier: string | null;
  scopes: string[];
  operator_escalation?: { expires_at?: unknown } | null;
}

/**
 * The roles an escalation serves the operator surface for, mapped to the
 * tier `allowedModesFor` reads (`src/prompts/index.ts`).
 */
const ESCALATED_TIERS: ReadonlyMap<string, string> = new Map([
  ["aegis:admin", "admin"],
  ["aegis:operator", "operator"],
]);

/**
 * The operator escalation a validate answer reports, when it is one the
 * server serves (Zaru ADR-0050 D5): an `operator_escalation` whose
 * `expires_at` is later than `now`, with an `aegis_role` of `aegis:admin` or
 * `aegis:operator`. Anything else is no escalation.
 */
export function activeOperatorEscalation(
  identity: ApiKeyIdentity,
  now: number = Date.now(),
): { tier: string; expiresAt: string } | null {
  const expiresAt = identity.operator_escalation?.expires_at;
  if (typeof expiresAt !== "string") return null;
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end) || end <= now) return null;
  const tier = identity.aegis_role
    ? ESCALATED_TIERS.get(identity.aegis_role)
    : undefined;
  if (!tier) return null;
  return { tier, expiresAt };
}

export type ApiKeyValidator = (token: string) => Promise<ApiKeyIdentity>;

/**
 * Validate an API key against the orchestrator's `/v1/api-keys/validate` endpoint.
 * The orchestrator hashes the key, looks it up in the DB, and returns the owner identity.
 */
export async function validateApiKeyWithOrchestrator(
  token: string,
): Promise<ApiKeyIdentity> {
  const orchestratorUrl =
    process.env.AEGIS_ORCHESTRATOR_URL || "http://localhost:8088";
  const response = await fetch(`${orchestratorUrl}/v1/api-keys/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Invalid API key");
    }
    throw new Error(
      `API key validation failed: ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as ApiKeyIdentity;
  if (!body.user_id) {
    throw new Error("API key validation response missing user_id");
  }
  // aegis_role is null for consumer users (they have zaru_tier instead)

  return body;
}

const TOKEN_HEADER = "x-zaru-user-token";
const TOKEN_QUERY_PARAM = "token";

const VALID_AEGIS_ROLES = new Set<string>(["admin", "operator", "readonly"]);
const OPERATOR_SECURITY_CONTEXT = "aegis-system-operator";

function isValidAegisRole(role: unknown): role is AegisRole {
  return typeof role === "string" && VALID_AEGIS_ROLES.has(role);
}

// Derive the trusted Keycloak host from JWKS_URI (strip /realms/... suffix)
const jwksUri =
  process.env.JWKS_URI ||
  "http://localhost:8180/realms/zaru-consumer/protocol/openid-connect/certs";
const keycloakHost = jwksUri.replace(/\/realms\/.*$/, "");

// Issuer URL of the aegis-system Keycloak realm, named here only to refuse
// its tokens. Through this server no credential carries the operator surface
// of its own: an aegis-system JWT presented as a bearer is refused 401, and
// the operator surface is served only while an API key holds an operator
// escalation (Zaru ADR-0050 D5, D6; AEGIS ADR-129 D15). Default mirrors the
// pod-network deployment shape; override via KEYCLOAK_SYSTEM_ISSUER.
const SYSTEM_REALM_ISSUER =
  process.env.KEYCLOAK_SYSTEM_ISSUER ?? `${keycloakHost}/realms/aegis-system`;

function isSystemRealmIssuer(issuer: unknown): boolean {
  return typeof issuer === "string" && issuer === SYSTEM_REALM_ISSUER;
}

/** The `iss` of a JWT-shaped token, read without verification; else undefined. */
function unverifiedIssuer(token: string): unknown {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}

const SYSTEM_REALM_REFUSAL =
  "Unauthorized: aegis-system tokens are not accepted; the operator surface is reached only by an operator escalation (zaru.operator.escalate)";

const JWKS_PATH_SUFFIX = "/protocol/openid-connect/certs";

/**
 * The exact set of issuers whose tokens this server verifies, fixed at
 * startup:
 *   - the realm JWKS_URI points at (the consumer realm in production), and
 *   - each exact issuer URL in KEYCLOAK_TRUSTED_ISSUERS (comma-separated),
 *     which is how an enterprise `tenant-{slug}` realm is added.
 * The aegis-system realm is not in it: its tokens are refused (Zaru ADR-0050
 * D6), so it holds no key set.
 * A token whose unverified `iss` is not in this set is refused before any
 * key set is allocated or any request is made. Previously a prefix check
 * let an unauthenticated caller grow an unbounded cache and choose the
 * path of an outbound request to the Keycloak host.
 */
function buildTrustedIssuers(): Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
> {
  if (!jwksUri.endsWith(JWKS_PATH_SUFFIX)) {
    throw new Error(
      `JWKS_URI must end with ${JWKS_PATH_SUFFIX} so its issuer can be derived; got ${jwksUri}`,
    );
  }
  const jwksEndpoints = new Map<string, string>();
  jwksEndpoints.set(jwksUri.slice(0, -JWKS_PATH_SUFFIX.length), jwksUri);
  const extraIssuers = (process.env.KEYCLOAK_TRUSTED_ISSUERS ?? "")
    .split(",")
    .map((issuer) => issuer.trim())
    .filter((issuer) => issuer.length > 0);
  for (const issuer of extraIssuers) {
    if (!jwksEndpoints.has(issuer) && !isSystemRealmIssuer(issuer)) {
      jwksEndpoints.set(issuer, `${issuer}${JWKS_PATH_SUFFIX}`);
    }
  }

  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  for (const [issuer, endpoint] of jwksEndpoints) {
    // createRemoteJWKSet makes no request until the first verification.
    keySets.set(issuer, createRemoteJWKSet(new URL(endpoint)));
  }
  return keySets;
}

const jwksByIssuer = buildTrustedIssuers();

/** Number of remote JWKS key sets this process holds. */
export function jwksKeySetCount(): number {
  return jwksByIssuer.size;
}

export function normalizeTier(rawTier?: string): string {
  const tier = (rawTier ?? "free").trim().toLowerCase();

  if (tier === "zaru-free" || tier === "free") {
    return "free";
  }

  if (tier === "zaru-pro" || tier === "pro") {
    return "pro";
  }

  if (tier === "zaru-business" || tier === "business") {
    return "business";
  }

  if (tier === "zaru-enterprise" || tier === "enterprise") {
    return "enterprise";
  }

  return "free";
}

export function mapTierToSecurityContext(rawTier?: string): string {
  return `zaru-${normalizeTier(rawTier)}`;
}

export async function verifyJwtWithJwks(
  token: string,
): Promise<VerifiedClaims> {
  // Decode without verification to extract the issuer for JWKS routing
  const unverified = decodeJwt(token);
  if (!unverified.iss) {
    throw new Error("Token missing iss claim");
  }

  const jwks = jwksByIssuer.get(unverified.iss);
  if (!jwks) {
    throw new Error("Untrusted issuer");
  }
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"],
    issuer: unverified.iss,
  });

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new Error("Token missing sub claim");
  }

  return payload as VerifiedClaims;
}

function extractBearerToken(header?: string): string | undefined {
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

/** The request's headers, as Node and Express present them (lowercased names). */
export type ZaruRequestHeaders = Record<string, string | string[] | undefined>;

/** The outcome of authenticating one request: a caller, or the refusal to send. */
export type ZaruAuthResult =
  | { user: ZaruUser }
  | { status: number; error: string };

/**
 * Resolve the caller of one request from its headers and query string:
 * the `x-zaru-user-token` header, else `Authorization: Bearer`, else the
 * `token` query parameter (SSE GET requests). Shared by the Express
 * middleware below and the Workers fetch handler (`src/worker.ts`), so both
 * entrypoints authenticate identically.
 */
export async function authenticateZaruRequest(
  headers: ZaruRequestHeaders,
  query: Record<string, unknown>,
  verifier: JwtVerifier = verifyJwtWithJwks,
  apiKeyValidator: ApiKeyValidator = validateApiKeyWithOrchestrator,
): Promise<ZaruAuthResult> {
  let user: ZaruUser;
  // Support token from header (normal requests) or query parameter (SSE GET requests)
  const rawToken =
    (headers[TOKEN_HEADER] as string | undefined) ??
    extractBearerToken(headers.authorization as string | undefined) ??
    (query[TOKEN_QUERY_PARAM] as string | undefined);

  if (!rawToken) {
    return {
      status: 401,
      error: `Unauthorized: Missing ${TOKEN_HEADER} header or ${TOKEN_QUERY_PARAM} query parameter`,
    };
  }

  if (process.env.BYPASS_AUTH === "true") {
    const bypassRole = headers["x-aegis-role"] as string | undefined;
    if (isValidAegisRole(bypassRole)) {
      user = {
        userId:
          (headers["x-zaru-user-id"] as string | undefined) ??
          "bypass-user",
        tier: bypassRole,
        securityContext: OPERATOR_SECURITY_CONTEXT,
        token: rawToken,
        isOperator: true,
      };
    } else {
      const tier = normalizeTier(
        (headers["x-zaru-tier"] as string | undefined) ?? "free",
      );
      user = {
        userId:
          (headers["x-zaru-user-id"] as string | undefined) ??
          "bypass-user",
        tier,
        securityContext: mapTierToSecurityContext(tier),
        token: rawToken,
        isOperator: false,
      };
    }
    return { user };
  }

  // API key authentication: tokens with `aegis_` prefix are API keys,
  // validated against the orchestrator instead of Keycloak JWKS.
  //
  // The operator context is served only while the orchestrator reports an
  // active operator escalation for the key (Zaru ADR-0050 D5). A key's stored
  // aegis_role grants nothing here: such a key is served the consumer context
  // like any other (D6; AEGIS ADR-129 D15).
  if (isApiKey(rawToken)) {
    try {
      const identity = await apiKeyValidator(rawToken);
      const escalation = activeOperatorEscalation(identity);
      if (escalation) {
        user = {
          userId: identity.user_id,
          tier: escalation.tier,
          securityContext: OPERATOR_SECURITY_CONTEXT,
          token: rawToken,
          isOperator: true,
          tenantId: identity.tenant_id ?? undefined,
          operatorEscalation: { expiresAt: escalation.expiresAt },
        };
        return { user };
      }
      const tier = identity.zaru_tier ?? "free";
      user = {
        userId: identity.user_id,
        tier,
        securityContext: `zaru-${tier}`,
        token: rawToken,
        isOperator: false,
        tenantId: identity.tenant_id ?? undefined,
      };
      return { user };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid API key";
      return { status: 401, error: message };
    }
  }

  // An aegis-system JWT is refused before any verification or key fetch:
  // no credential carries the operator surface of its own (Zaru ADR-0050 D6).
  if (isSystemRealmIssuer(unverifiedIssuer(rawToken))) {
    return { status: 401, error: SYSTEM_REALM_REFUSAL };
  }

  // JWT authentication: validate via Keycloak JWKS
  try {
    const claims = await verifier(rawToken);

    const jwtTenantId = claims.tenant_id ?? undefined;
    const activeTenantHeader = headers["x-zaru-active-tenant"] as
      | string
      | undefined;

    // Build the caller's allowed-tenant set from the verified JWT:
    //   { personal tenant } ∪ team_memberships[]
    // The active-tenant cookie is user-writable, so we must validate
    // any value it carries against this server-trusted set. A missing
    // header means "use my personal tenant" and is always permitted.
    const allowedTenants = new Set<string>();
    if (jwtTenantId) {
      allowedTenants.add(jwtTenantId);
    }
    if (Array.isArray(claims.team_memberships)) {
      for (const t of claims.team_memberships) {
        if (typeof t === "string" && t.length > 0) {
          allowedTenants.add(t);
        }
      }
    }

    let tenantId: string | undefined;
    if (activeTenantHeader && activeTenantHeader.length > 0) {
      if (!allowedTenants.has(activeTenantHeader)) {
        return {
          status: 403,
          error:
            "Forbidden: x-zaru-active-tenant is not a tenant the caller is a member of",
        };
      }
      tenantId = activeTenantHeader;
    } else {
      tenantId = jwtTenantId;
    }

    // A JWT never carries the operator surface (Zaru ADR-0050 D6): an
    // `aegis_role` claim on any token this server verifies is ignored and
    // the caller is served its tier.
    const tier = normalizeTier(claims.zaru_tier);
    user = {
      userId: claims.sub,
      tier,
      securityContext: mapTierToSecurityContext(tier),
      token: rawToken,
      isOperator: false,
      tenantId,
    };

    return { user };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid token";
    const status = message.startsWith("Unsupported zaru_tier") ? 403 : 401;
    return { status, error: message };
  }
}

export function createZaruAuthMiddleware(
  verifier: JwtVerifier = verifyJwtWithJwks,
  apiKeyValidator: ApiKeyValidator = validateApiKeyWithOrchestrator,
) {
  return async (req: ZaruRequest, res: Response, next: NextFunction) => {
    const result = await authenticateZaruRequest(
      req.headers,
      req.query,
      verifier,
      apiKeyValidator,
    );
    if ("user" in result) {
      req.zaruUser = result.user;
      next();
      return;
    }
    res.status(result.status).json({ error: result.error });
  };
}

export const zaruAuthMiddleware = createZaruAuthMiddleware();
