import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface ZaruUser {
    userId: string;
    tier: string;
    securityContext: string;
    token: string;
}

export interface ZaruRequest extends Request {
    zaruUser?: ZaruUser;
}

export type VerifiedClaims = JwtPayload & {
    sub: string;
    zaru_tier?: string;
};

export type JwtVerifier = (token: string) => Promise<VerifiedClaims>;

const TOKEN_HEADER = 'x-zaru-user-token';
const TOKEN_QUERY_PARAM = 'token';

const client = jwksClient({
    jwksUri: process.env.JWKS_URI || 'http://localhost:3080/oauth/jwks'
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
    if (!header.kid) {
        callback(new Error('JWT missing kid header'), undefined);
        return;
    }

    client.getSigningKey(header.kid, (err, key) => {
        if (err || !key) {
            callback(err || new Error('Unable to resolve JWKS signing key'), undefined);
            return;
        }

        callback(null, key.getPublicKey());
    });
}

export function normalizeTier(rawTier?: string): string {
    const tier = (rawTier ?? 'free').trim().toLowerCase();

    if (tier === 'zaru-free' || tier === 'free') {
        return 'free';
    }

    if (tier === 'zaru-pro' || tier === 'pro') {
        return 'pro';
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
    return new Promise((resolve, reject) => {
        jwt.verify(
            token,
            getKey,
            {
                algorithms: ['RS256']
            },
            (err, decoded) => {
                if (err || !decoded || typeof decoded === 'string') {
                    reject(err || new Error('Invalid JWT payload'));
                    return;
                }

                if (!decoded.sub || typeof decoded.sub !== 'string') {
                    reject(new Error('Token missing sub claim'));
                    return;
                }

                resolve(decoded as VerifiedClaims);
            }
        );
    });
}

export function createZaruAuthMiddleware(verifier: JwtVerifier = verifyJwtWithJwks) {
    return async (req: ZaruRequest, res: Response, next: NextFunction) => {
        // Support token from header (normal requests) or query parameter (SSE GET requests)
        const rawToken =
            (req.headers[TOKEN_HEADER] as string | undefined) ??
            (req.query[TOKEN_QUERY_PARAM] as string | undefined);

        if (!rawToken) {
            res.status(401).json({ error: `Unauthorized: Missing ${TOKEN_HEADER} header or ${TOKEN_QUERY_PARAM} query parameter` });
            return;
        }

        if (process.env.BYPASS_AUTH === 'true') {
            const tier = normalizeTier((req.headers['x-zaru-tier'] as string | undefined) ?? 'free');
            req.zaruUser = {
                userId: (req.headers['x-librechat-user-id'] as string | undefined) ?? 'bypass-user',
                tier,
                securityContext: mapTierToSecurityContext(tier),
                token: rawToken
            };
            next();
            return;
        }

        try {
            const claims = await verifier(rawToken);
            const tier = normalizeTier(claims.zaru_tier);

            req.zaruUser = {
                userId: claims.sub,
                tier,
                securityContext: mapTierToSecurityContext(tier),
                token: rawToken
            };

            next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid token';
            const status = message.startsWith('Unsupported zaru_tier') ? 403 : 401;
            res.status(status).json({ error: message });
        }
    };
}

export const zaruAuthMiddleware = createZaruAuthMiddleware();
