import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

// Type definitions for our extended Request object
export interface ZaruRequest extends Request {
    zaruUser?: {
        userId: string;
        tier: string;
        token: string;
    };
}

const client = jwksClient({
    jwksUri: process.env.JWKS_URI || 'http://localhost:3080/oauth/jwks'
});

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
    if (!header.kid) {
        // Fallback for missing kid, or bypass in dev
        if (process.env.NODE_ENV === 'development') {
            return callback(null, process.env.DEV_JWT_SECRET || 'secret');
        }
        return callback(new Error('No Key ID found in JWT'), undefined);
    }
    client.getSigningKey(header.kid, (err, key) => {
        if (err || !key) {
            callback(err || new Error('Key not found'), undefined);
            return;
        }
        const signingKey = key.getPublicKey();
        callback(null, signingKey);
    });
}

export const zaruAuthMiddleware = (req: ZaruRequest, res: Response, next: NextFunction) => {
    // 1. Read Keycloak JWT from X-Zaru-User-Token
    const rawToken = req.headers['x-zaru-user-token'] as string;

    if (!rawToken) {
        console.warn('Missing or invalid X-Zaru-User-Token header');
        res.status(401).json({ error: 'Unauthorized: Missing X-Zaru-User-Token' });
        return;
    }

    if (process.env.BYPASS_AUTH === 'true') {
        const fallbackUserId = req.headers['x-librechat-user-id'] as string || 'bypass-user';
        const fallbackTier = req.headers['x-zaru-tier'] as string || 'default';
        console.warn('BYPASS_AUTH enabled: Using fallback headers or default values');
        req.zaruUser = { userId: fallbackUserId, tier: fallbackTier, token: rawToken };
        next();
        return;
    }

    // 2. Validate against Keycloak JWKS
    jwt.verify(rawToken, getKey, {
        algorithms: ['RS256']
    }, (err, decoded) => {
        if (err || !decoded || typeof decoded === 'string') {
            console.error('JWT Verification failed:', err ? err.message : 'Invalid payload');
            res.status(401).json({ error: 'Invalid Token' });
            return;
        }

        // 3. Resolve identity and tier from Native Keycloak Claims
        const userId = decoded.sub;
        const tier = decoded.zaru_tier || 'free';

        if (!userId) {
            res.status(401).json({ error: 'Token missing sub claim' });
            return;
        }

        req.zaruUser = {
            userId: userId as string,
            tier: tier as string,
            token: rawToken
        };
        next();
    });
};
