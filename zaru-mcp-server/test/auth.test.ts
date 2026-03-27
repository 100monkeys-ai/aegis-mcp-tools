import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Response } from 'express';
import { createZaruAuthMiddleware } from '../src/middleware/auth.js';

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
        }
    } as Response & { statusCode: number; body: unknown };
}

test('auth middleware validates token claims and maps tier to security context', async () => {
    const middleware = createZaruAuthMiddleware(async () => ({
        sub: 'user-123',
        zaru_tier: 'pro'
    }));

    const req = {
        headers: {
            'x-zaru-user-token': 'jwt-token'
        }
    } as any;
    const res = createResponseRecorder();
    let nextCalled = false;

    await middleware(req, res, (() => {
        nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, true);
    assert.deepEqual(req.zaruUser, {
        userId: 'user-123',
        tier: 'pro',
        securityContext: 'zaru-pro',
        token: 'jwt-token'
    });
});

test('auth middleware accepts Authorization: Bearer header as fallback', async () => {
    const middleware = createZaruAuthMiddleware(async () => ({
        sub: 'user-456',
        zaru_tier: 'free'
    }));

    const req = {
        headers: {
            authorization: 'Bearer my-bearer-token'
        },
        query: {}
    } as any;
    const res = createResponseRecorder();
    let nextCalled = false;

    await middleware(req, res, (() => {
        nextCalled = true;
    }) as NextFunction);

    assert.equal(nextCalled, true);
    assert.deepEqual(req.zaruUser, {
        userId: 'user-456',
        tier: 'free',
        securityContext: 'zaru-free',
        token: 'my-bearer-token'
    });
});

test('auth middleware rejects unsupported tiers', async () => {
    const middleware = createZaruAuthMiddleware(async () => ({
        sub: 'user-123',
        zaru_tier: 'godmode'
    }));

    const req = {
        headers: {
            'x-zaru-user-token': 'jwt-token'
        }
    } as any;
    const res = createResponseRecorder();

    await middleware(req, res, (() => undefined) as NextFunction);

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.body, {
        error: 'Unsupported zaru_tier claim: godmode'
    });
});
