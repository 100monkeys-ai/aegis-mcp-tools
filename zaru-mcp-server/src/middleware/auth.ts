import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

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

export type AegisRole = 'admin' | 'operator' | 'readonly';

export type VerifiedClaims = JWTPayload & {
    sub: string;
    zaru_tier?: string;
    aegis_role?: AegisRole;
};

export type JwtVerifier = (token: string) => Promise<VerifiedClaims>;

const TOKEN_HEADER = 'x-zaru-user-token';
const TOKEN_QUERY_PARAM = 'token';

const VALID_AEGIS_ROLES = new Set<string>(['admin', 'operator', 'readonly']);
const OPERATOR_SECURITY_CONTEXT = 'aegis-system-operator';

function isValidAegisRole(role: unknown): role is AegisRole {
    return typeof role === 'string' && VALID_AEGIS_ROLES.has(role);
}

const jwksUri = process.env.JWKS_URI || 'http://localhost:8180/realms/zaru-consumer/protocol/openid-connect/certs';
const JWKS = createRemoteJWKSet(new URL(jwksUri));

export function normalizeTier(rawTier?: string): string {
    const tier = (rawTier ?? 'free').trim().toLowerCase();

    if (tier === 'zaru-free' || tier === 'free') {
        return 'free';
    }

    if (tier === 'zaru-pro' || tier === 'pro') {
        return 'pro';
    }

    if (tier === 'zaru-business' || tier === 'business') {
        return 'business';
    }

    if (tier === 'zaru-enterprise' || tier === 'enterprise') {
        return 'enterprise';
    }

    throw new Error(`Unsupported zaru_tier claim: ${rawTier}`);
}

export function mapTierToSecurityContext(rawTier?: string): string {
    return `zaru-${normalizeTier(rawTier)}`;
}

export async function verifyJwtWithJwks(token: string): Promise<VerifiedClaims> {
    const { payload } = await jwtVerify(token, JWKS, {
        algorithms: ['RS256'],
    });

    if (!payload.sub || typeof payload.sub !== 'string') {
        throw new Error('Token missing sub claim');
    }

    return payload as VerifiedClaims;
}

function extractBearerToken(header?: string): string | undefined {
    if (!header) return undefined;
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
}

export function createZaruAuthMiddleware(verifier: JwtVerifier = verifyJwtWithJwks) {
    return async (req: ZaruRequest, res: Response, next: NextFunction) => {
        // Support token from header (normal requests) or query parameter (SSE GET requests)
        const rawToken =
            (req.headers[TOKEN_HEADER] as string | undefined) ??
            extractBearerToken(req.headers.authorization as string | undefined) ??
            (req.query[TOKEN_QUERY_PARAM] as string | undefined);

        if (!rawToken) {
            res.status(401).json({ error: `Unauthorized: Missing ${TOKEN_HEADER} header or ${TOKEN_QUERY_PARAM} query parameter` });
            return;
        }

        if (process.env.BYPASS_AUTH === 'true') {
            const bypassRole = req.headers['x-aegis-role'] as string | undefined;
            if (isValidAegisRole(bypassRole)) {
                req.zaruUser = {
                    userId: (req.headers['x-zaru-user-id'] as string | undefined) ?? 'bypass-user',
                    tier: bypassRole,
                    securityContext: OPERATOR_SECURITY_CONTEXT,
                    token: rawToken,
                    isOperator: true
                };
            } else {
                const tier = normalizeTier((req.headers['x-zaru-tier'] as string | undefined) ?? 'free');
                req.zaruUser = {
                    userId: (req.headers['x-zaru-user-id'] as string | undefined) ?? 'bypass-user',
                    tier,
                    securityContext: mapTierToSecurityContext(tier),
                    token: rawToken,
                    isOperator: false
                };
            }
            next();
            return;
        }

        try {
            const claims = await verifier(rawToken);

            if (isValidAegisRole(claims.aegis_role)) {
                req.zaruUser = {
                    userId: claims.sub,
                    tier: claims.aegis_role,
                    securityContext: OPERATOR_SECURITY_CONTEXT,
                    token: rawToken,
                    isOperator: true
                };
            } else {
                const tier = normalizeTier(claims.zaru_tier);
                req.zaruUser = {
                    userId: claims.sub,
                    tier,
                    securityContext: mapTierToSecurityContext(tier),
                    token: rawToken,
                    isOperator: false
                };
            }

            next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid token';
            const status = message.startsWith('Unsupported zaru_tier') ? 403 : 401;
            res.status(status).json({ error: message });
        }
    };
}

export const zaruAuthMiddleware = createZaruAuthMiddleware();
