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
  });
});

test("auth middleware maps aegis_role operator to operator identity", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "operator-1",
    aegis_role: "admin" as const,
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
    userId: "operator-1",
    tier: "admin",
    securityContext: "aegis-system-operator",
    token: "jwt-token",
    isOperator: true,
  });
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

test("auth middleware validates aegis_ API key via apiKeyValidator", async () => {
  const jwtVerifier = async () => {
    throw new Error("JWT verifier should not be called for API keys");
  };
  const apiKeyValidator = async (token: string) => {
    assert.equal(token, "aegis_test_key_12345");
    return {
      user_id: "api-user-789",
      aegis_role: "operator" as const,
      scopes: ["agent:read", "agent:execute"],
    };
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
    tier: "operator",
    securityContext: "aegis-system-operator",
    token: "aegis_test_key_12345",
    isOperator: true,
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
      aegis_role: "admin" as const,
      scopes: ["key:list"],
    };
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
  assert.deepEqual(req.zaruUser, {
    userId: "header-user",
    tier: "admin",
    securityContext: "aegis-system-operator",
    token: "aegis_header_key",
    isOperator: true,
  });
});

test("auth middleware does not call API key validator for non-aegis_ tokens", async () => {
  let apiKeyValidatorCalled = false;
  const apiKeyValidator = async () => {
    apiKeyValidatorCalled = true;
    return {
      user_id: "should-not-happen",
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
