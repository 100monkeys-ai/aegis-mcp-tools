import test from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Response } from "express";
import { createZaruAuthMiddleware, isApiKey } from "../src/middleware/auth.js";

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  } as Response & { statusCode: number; body: unknown };
}

// ── JWT Auth Tests ──────────────────────────────────────────────────────────

test("auth middleware validates JWT claims and maps tier to security context", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-123",
    zaru_tier: "pro",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(req.zaruUser, {
    userId: "user-123",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "jwt-token",
    isOperator: false,
    tenantId: undefined,
  });
});

test("auth middleware accepts Authorization: Bearer header as fallback", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-456",
    zaru_tier: "free",
  }));

  const req = {
    headers: {
      authorization: "Bearer my-bearer-token",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(req.zaruUser, {
    userId: "user-456",
    tier: "free",
    securityContext: "zaru-free",
    token: "my-bearer-token",
    isOperator: false,
    tenantId: undefined,
  });
});

test("auth middleware normalizes unknown tier to free", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-123",
    zaru_tier: "godmode",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(req.zaruUser, {
    userId: "user-123",
    tier: "free",
    securityContext: "zaru-free",
    token: "jwt-token",
    isOperator: false,
    tenantId: undefined,
  });
});

// ── Zaru ADR-0050 D6: no operator surface without an escalation ────────────
//
// An aegis-system JWT presented as a bearer is refused 401, whatever it
// carries, and the verifier is never asked; an API key's stored aegis_role
// no longer grants the operator context.

/** The issuer of the aegis-system realm as this process derives it. */
const SYSTEM_ISSUER = "http://localhost:8180/realms/aegis-system";

/** A JWT-shaped token carrying `claims`, unsigned: refused before verification. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.c2ln`;
}

async function refusedWithoutVerifying(claims: Record<string, unknown>) {
  let verifierCalled = false;
  const middleware = createZaruAuthMiddleware(async () => {
    verifierCalled = true;
    return { sub: String(claims.sub), ...claims } as any;
  });
  const req = {
    headers: { authorization: `Bearer ${unsignedJwt(claims)}` },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;
  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(verifierCalled, false);
  assert.equal(req.zaruUser, undefined);
  return res.body as { error: string };
}

test("an aegis-system JWT with aegis_role admin is refused 401 (D6)", async () => {
  const body = await refusedWithoutVerifying({
    sub: "operator-1",
    iss: SYSTEM_ISSUER,
    aegis_role: "admin",
  });
  assert.match(body.error, /aegis-system/);
});

// ── System-Realm Gating for aegis_role (ADR-073) ────────────────────────────
//
// Per ADR-041 / ADR-073, operator privilege lives exclusively in the
// aegis-system realm. The orchestrator's
// resolve_role_rejects_consumer_identity_even_with_aegis_role_claim test
// (keycloak_iam_service.rs) enforces the same invariant on the Rust side.
// A consumer-realm JWT with a forged aegis_role claim must NOT be promoted
// to operator — it must silently fall through to the normal tier path.

test("consumer_realm_jwt_with_aegis_role_falls_back_to_tier_context", async () => {
  // Privilege-escalation attempt: a consumer-realm JWT carrying a forged
  // aegis_role=operator claim. The middleware MUST drop the role and
  // treat the caller as a normal tier user, mirroring the orchestrator.
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "consumer-user-1",
    iss: "http://localhost:8180/realms/zaru-consumer",
    aegis_role: "operator" as const,
    zaru_tier: "pro",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.zaruUser?.isOperator, false);
  assert.notEqual(req.zaruUser?.securityContext, "aegis-system-operator");
  assert.equal(req.zaruUser?.securityContext, "zaru-pro");
  assert.equal(req.zaruUser?.tier, "pro");
});

test("an aegis-system JWT with aegis_role operator is refused 401 (D6)", async () => {
  await refusedWithoutVerifying({
    sub: "operator-real-1",
    iss: SYSTEM_ISSUER,
    aegis_role: "operator",
  });
});

test("an aegis-system JWT without aegis_role is refused 401 too (D6)", async () => {
  await refusedWithoutVerifying({
    sub: "system-svc-1",
    iss: SYSTEM_ISSUER,
    zaru_tier: "free",
  });
});

test("an aegis-system JWT in x-zaru-user-token is refused 401 (D6)", async () => {
  const middleware = createZaruAuthMiddleware(async () => {
    throw new Error("the verifier must not be asked");
  });
  const req = {
    headers: {
      "x-zaru-user-token": unsignedJwt({
        sub: "operator-1",
        iss: SYSTEM_ISSUER,
        aegis_role: "admin",
      }),
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  await middleware(req, res, (() => undefined) as NextFunction);
  assert.equal(res.statusCode, 401);
  assert.equal(req.zaruUser, undefined);
});

test("auth middleware rejects request with no token", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-123",
  }));

  const req = {
    headers: {},
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

// ── API Key Detection Tests ─────────────────────────────────────────────────

test("isApiKey returns true for aegis_ prefixed tokens", () => {
  assert.equal(isApiKey("aegis_abc123def456"), true);
  assert.equal(isApiKey("aegis_"), true);
});

test("isApiKey returns false for JWT-like tokens", () => {
  assert.equal(isApiKey("eyJhbGciOiJSUzI1NiJ9.xxx.yyy"), false);
  assert.equal(isApiKey("some-random-token"), false);
  assert.equal(isApiKey(""), false);
});

// ── API Key Auth Tests ──────────────────────────────────────────────────────

test("a key with a stored aegis_role is served the consumer context, not the operator's (D6)", async () => {
  const jwtVerifier = async () => {
    throw new Error("JWT verifier should not be called for API keys");
  };
  const apiKeyValidator = async (token: string) => {
    assert.equal(token, "aegis_test_key_12345");
    // The orchestrator's spelling of a stored role (iam/mod.rs as_claim_str).
    return {
      user_id: "api-user-789",
      tenant_id: null,
      zaru_tier: null,
      aegis_role: "aegis:operator",
      scopes: ["agent:read", "agent:execute"],
    } as any;
  };

  const middleware = createZaruAuthMiddleware(jwtVerifier, apiKeyValidator);

  const req = {
    headers: {
      authorization: "Bearer aegis_test_key_12345",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.deepEqual(req.zaruUser, {
    userId: "api-user-789",
    tier: "free",
    securityContext: "zaru-free",
    token: "aegis_test_key_12345",
    isOperator: false,
    tenantId: undefined,
  });
});

test("auth middleware rejects invalid API key", async () => {
  const jwtVerifier = async () => {
    throw new Error("JWT verifier should not be called for API keys");
  };
  const apiKeyValidator = async () => {
    throw new Error("Invalid API key");
  };

  const middleware = createZaruAuthMiddleware(jwtVerifier, apiKeyValidator);

  const req = {
    headers: {
      authorization: "Bearer aegis_bad_key",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Invalid API key" });
});

test("auth middleware routes aegis_ token from x-zaru-user-token header to API key validator", async () => {
  const apiKeyValidator = async (token: string) => {
    assert.equal(token, "aegis_header_key");
    return {
      user_id: "header-user",
      tenant_id: null,
      zaru_tier: "pro",
      aegis_role: "aegis:admin",
      scopes: ["key:list"],
    } as any;
  };

  const middleware = createZaruAuthMiddleware(async () => {
    throw new Error("should not be called");
  }, apiKeyValidator);

  const req = {
    headers: {
      "x-zaru-user-token": "aegis_header_key",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  // A stored aegis:admin grants nothing here either (D6).
  assert.deepEqual(req.zaruUser, {
    userId: "header-user",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "aegis_header_key",
    isOperator: false,
    tenantId: undefined,
  });
});

// ── Zaru ADR-0050 D5: what an escalated key is served ──────────────────────

const IN_AN_HOUR = () => new Date(Date.now() + 3600_000).toISOString();
const AN_HOUR_AGO = () => new Date(Date.now() - 3600_000).toISOString();

async function userForKey(identity: Record<string, unknown>) {
  const middleware = createZaruAuthMiddleware(
    async () => {
      throw new Error("should not be called");
    },
    async () =>
      ({
        user_id: "consumer-sub-1",
        tenant_id: "u-consumer-sub-1",
        zaru_tier: "pro",
        scopes: [],
        ...identity,
      }) as any,
  );
  const req = {
    headers: { authorization: "Bearer aegis_escalated_key" },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;
  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);
  assert.equal(nextCalled, true);
  return req.zaruUser;
}

test("a key holding an escalation as aegis:operator is served the operator context (D5)", async () => {
  const expiresAt = IN_AN_HOUR();
  const user = await userForKey({
    aegis_role: "aegis:operator",
    operator_escalation: { expires_at: expiresAt },
  });
  assert.deepEqual(user, {
    userId: "consumer-sub-1",
    tier: "operator",
    securityContext: "aegis-system-operator",
    token: "aegis_escalated_key",
    isOperator: true,
    tenantId: "u-consumer-sub-1",
    operatorEscalation: { expiresAt },
  });
});

test("a key holding an escalation as aegis:admin is served tier admin (D5)", async () => {
  const user = await userForKey({
    aegis_role: "aegis:admin",
    operator_escalation: { expires_at: IN_AN_HOUR() },
  });
  assert.equal(user.isOperator, true);
  assert.equal(user.tier, "admin");
  assert.equal(user.securityContext, "aegis-system-operator");
});

test("the same key once validate omits operator_escalation is served its consumer context (D5)", async () => {
  const user = await userForKey({ aegis_role: null });
  assert.deepEqual(user, {
    userId: "consumer-sub-1",
    tier: "pro",
    securityContext: "zaru-pro",
    token: "aegis_escalated_key",
    isOperator: false,
    tenantId: "u-consumer-sub-1",
  });
});

test("an escalation whose expires_at has passed grants nothing (D5)", async () => {
  const user = await userForKey({
    aegis_role: "aegis:operator",
    operator_escalation: { expires_at: AN_HOUR_AGO() },
  });
  assert.equal(user.isOperator, false);
  assert.equal(user.securityContext, "zaru-pro");
  assert.equal(user.operatorEscalation, undefined);
});

test("an escalation with a role other than aegis:admin or aegis:operator grants nothing (D5)", async () => {
  for (const role of ["aegis:readonly", "operator", "admin", null]) {
    const user = await userForKey({
      aegis_role: role,
      operator_escalation: { expires_at: IN_AN_HOUR() },
    });
    assert.equal(user.isOperator, false, `role ${String(role)}`);
    assert.equal(user.securityContext, "zaru-pro", `role ${String(role)}`);
  }
});

test("an operator_escalation without a readable expires_at grants nothing (D5)", async () => {
  for (const escalation of [{}, { expires_at: "not a time" }, { expires_at: 5 }, null]) {
    const user = await userForKey({
      aegis_role: "aegis:operator",
      operator_escalation: escalation,
    });
    assert.equal(user.isOperator, false, JSON.stringify(escalation));
  }
});

test("auth middleware does not call API key validator for non-aegis_ tokens", async () => {
  let apiKeyValidatorCalled = false;
  const apiKeyValidator = async () => {
    apiKeyValidatorCalled = true;
    return {
      user_id: "should-not-happen",
      tenant_id: null,
      zaru_tier: null,
      aegis_role: "admin" as const,
      scopes: [],
    };
  };

  const middleware = createZaruAuthMiddleware(async () => {
    return { sub: "jwt-user", zaru_tier: "pro" };
  }, apiKeyValidator);

  const req = {
    headers: {
      authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();

  await middleware(req, res, (() => undefined) as NextFunction);

  assert.equal(apiKeyValidatorCalled, false);
  assert.equal(req.zaruUser?.userId, "jwt-user");
});

// ── Tenant ID Resolution Tests ──────────────────────────────────────────────

test("JWT with tenant_id claim populates req.zaruUser.tenantId", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-1",
    zaru_tier: "pro",
    tenant_id: "t-personal-abc",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(req.zaruUser?.tenantId, "t-personal-abc");
});

test("auth middleware accepts x-zaru-active-tenant listed in JWT team_memberships", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-2",
    zaru_tier: "pro",
    tenant_id: "u-personal-abc",
    team_memberships: ["t-team-xyz", "t-team-other"],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-team-xyz",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.zaruUser?.tenantId, "t-team-xyz");
});

test("auth middleware rejects x-zaru-active-tenant not in JWT memberships", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-3",
    zaru_tier: "pro",
    tenant_id: "u-personal-abc",
    team_memberships: ["t-team-allowed"],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-team-forged",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(req.zaruUser, undefined);
});

test("auth middleware defaults to JWT tenant_id when header absent", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-4",
    zaru_tier: "free",
    tenant_id: "u-personal-def",
    team_memberships: ["t-team-xyz"],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.zaruUser?.tenantId, "u-personal-def");
});

test("auth middleware rejects header equal to another user's u- tenant", async () => {
  // Caller has personal tenant u-alice and no team memberships. A forged
  // header pointing at another user's personal u- tenant must be rejected
  // — the deleted prefix-based heuristic only checked for `t-`, so this
  // case explicitly guards against the inverse leak as well.
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-alice",
    zaru_tier: "pro",
    tenant_id: "u-alice-123",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "u-bob-456",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(req.zaruUser, undefined);
});

test("API key path stores identity.tenant_id on ZaruUser.tenantId", async () => {
  const middleware = createZaruAuthMiddleware(
    async () => {
      throw new Error("should not be called");
    },
    async () => ({
      user_id: "api-user-tenant",
      tenant_id: "t-api-tenant-123",
      aegis_role: null,
      zaru_tier: "pro",
      scopes: [],
    }),
  );

  const req = {
    headers: {
      authorization: "Bearer aegis_key_with_tenant",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(req.zaruUser?.tenantId, "t-api-tenant-123");
});

// ── team_memberships Claim End-to-End Tests ─────────────────────────────────
//
// These lock in the contract for the in-flight upstream changes: Keycloak
// will mint `team_memberships` into the access token, and the orchestrator
// will stamp matching membership rows. The middleware (commit ea607f5) is
// already wired to enforce this — these tests guarantee the four paths a
// caller can take through the JWT branch with the new claim are stable.

test("team_memberships claim with t- tenant in header passes (200)", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-alice",
    zaru_tier: "pro",
    tenant_id: "u-alice",
    team_memberships: ["t-foo", "t-bar"],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-foo",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.zaruUser?.tenantId, "t-foo");
  assert.equal(req.zaruUser?.userId, "user-alice");
});

test("team_memberships claim absent and t- header set returns 403", async () => {
  // Fail-closed: with no team_memberships claim, the only allowed tenant is
  // the caller's personal u- tenant. A header asking for a t- tenant must
  // be rejected — even if the orchestrator would in fact recognise it.
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-alice",
    zaru_tier: "pro",
    tenant_id: "u-alice",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-foo",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(req.zaruUser, undefined);
});

test("team_memberships claim present but does not contain header tenant returns 403", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-alice",
    zaru_tier: "pro",
    tenant_id: "u-alice",
    team_memberships: ["t-foo"],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-baz",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(req.zaruUser, undefined);
});

test("team_memberships claim with empty array and no header defaults to personal tenant", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-alice",
    zaru_tier: "pro",
    tenant_id: "u-alice",
    team_memberships: [],
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(req.zaruUser?.tenantId, "u-alice");
});

test("API key path with null tenant_id results in undefined tenantId", async () => {
  const middleware = createZaruAuthMiddleware(
    async () => {
      throw new Error("should not be called");
    },
    async () => ({
      user_id: "api-user-no-tenant",
      tenant_id: null,
      aegis_role: null,
      zaru_tier: "free",
      scopes: [],
    }),
  );

  const req = {
    headers: {
      authorization: "Bearer aegis_key_no_tenant",
    },
    query: {},
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(req.zaruUser?.tenantId, undefined);
});
