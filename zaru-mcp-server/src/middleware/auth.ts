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
}

export interface ZaruRequest extends Request {
  zaruUser?: ZaruUser;
}

export type AegisRole = "admin" | "operator" | "readonly";

export type VerifiedClaims = JWTPayload & {
  sub: string;
  zaru_tier?: string;
  aegis_role?: AegisRole;
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
 */
export interface ApiKeyIdentity {
  user_id: string;
  aegis_role: AegisRole;
  scopes: string[];
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
    },
    body: JSON.stringify({ api_key: token }),
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
  if (!isValidAegisRole(body.aegis_role)) {
    throw new Error(
      `API key validation response has invalid aegis_role: ${body.aegis_role}`,
    );
  }

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

// Per-issuer JWKS verifier cache — one instance per realm, each handles key rotation internally
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwksForIssuer(
  issuer: string,
): ReturnType<typeof createRemoteJWKSet> {
  const realmPrefix = keycloakHost + "/realms/";
  if (!issuer.startsWith(realmPrefix)) {
    throw new Error(`Untrusted issuer: ${issuer}`);
  }
  if (!jwksCache.has(issuer)) {
    const jwksEndpoint = `${issuer}/protocol/openid-connect/certs`;
    jwksCache.set(issuer, createRemoteJWKSet(new URL(jwksEndpoint)));
  }
  return jwksCache.get(issuer)!;
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

  const jwks = getJwksForIssuer(unverified.iss);
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

export function createZaruAuthMiddleware(
  verifier: JwtVerifier = verifyJwtWithJwks,
  apiKeyValidator: ApiKeyValidator = validateApiKeyWithOrchestrator,
) {
  return async (req: ZaruRequest, res: Response, next: NextFunction) => {
    // Support token from header (normal requests) or query parameter (SSE GET requests)
    const rawToken =
      (req.headers[TOKEN_HEADER] as string | undefined) ??
      extractBearerToken(req.headers.authorization as string | undefined) ??
      (req.query[TOKEN_QUERY_PARAM] as string | undefined);

    if (!rawToken) {
      res.status(401).json({
        error: `Unauthorized: Missing ${TOKEN_HEADER} header or ${TOKEN_QUERY_PARAM} query parameter`,
      });
      return;
    }

    if (process.env.BYPASS_AUTH === "true") {
      const bypassRole = req.headers["x-aegis-role"] as string | undefined;
      if (isValidAegisRole(bypassRole)) {
        req.zaruUser = {
          userId:
            (req.headers["x-zaru-user-id"] as string | undefined) ??
            "bypass-user",
          tier: bypassRole,
          securityContext: OPERATOR_SECURITY_CONTEXT,
          token: rawToken,
          isOperator: true,
        };
      } else {
        const tier = normalizeTier(
          (req.headers["x-zaru-tier"] as string | undefined) ?? "free",
        );
        req.zaruUser = {
          userId:
            (req.headers["x-zaru-user-id"] as string | undefined) ??
            "bypass-user",
          tier,
          securityContext: mapTierToSecurityContext(tier),
          token: rawToken,
          isOperator: false,
        };
      }
      next();
      return;
    }

    // API key authentication: tokens with `aegis_` prefix are API keys,
    // validated against the orchestrator instead of Keycloak JWKS.
    if (isApiKey(rawToken)) {
      try {
        const identity = await apiKeyValidator(rawToken);
        req.zaruUser = {
          userId: identity.user_id,
          tier: identity.aegis_role,
          securityContext: OPERATOR_SECURITY_CONTEXT,
          token: rawToken,
          isOperator: true,
        };
        next();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Invalid API key";
        res.status(401).json({ error: message });
      }
      return;
    }

    // JWT authentication: validate via Keycloak JWKS
    try {
      const claims = await verifier(rawToken);

      if (isValidAegisRole(claims.aegis_role)) {
        req.zaruUser = {
          userId: claims.sub,
          tier: claims.aegis_role,
          securityContext: OPERATOR_SECURITY_CONTEXT,
          token: rawToken,
          isOperator: true,
        };
      } else {
        const tier = normalizeTier(claims.zaru_tier);
        req.zaruUser = {
          userId: claims.sub,
          tier,
          securityContext: mapTierToSecurityContext(tier),
          token: rawToken,
          isOperator: false,
        };
      }

      next();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid token";
      const status = message.startsWith("Unsupported zaru_tier") ? 403 : 401;
      res.status(status).json({ error: message });
    }
  };
}

export const zaruAuthMiddleware = createZaruAuthMiddleware();
