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

test("x-zaru-active-tenant header with t- prefix overrides JWT tenant_id", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-2",
    zaru_tier: "pro",
    tenant_id: "t-personal-abc",
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
  assert.equal(req.zaruUser?.tenantId, "t-team-xyz");
});

test("x-zaru-active-tenant without t- prefix is ignored; JWT tenant_id used instead", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-3",
    zaru_tier: "pro",
    tenant_id: "t-personal-abc",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "invalid-header",
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

test("x-zaru-active-tenant value 't-' alone (length <= 2) is ignored", async () => {
  const middleware = createZaruAuthMiddleware(async () => ({
    sub: "user-tenant-4",
    zaru_tier: "free",
    tenant_id: "t-personal-def",
  }));

  const req = {
    headers: {
      "x-zaru-user-token": "jwt-token",
      "x-zaru-active-tenant": "t-",
    },
  } as any;
  const res = createResponseRecorder();
  let nextCalled = false;

  await middleware(req, res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(req.zaruUser?.tenantId, "t-personal-def");
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
