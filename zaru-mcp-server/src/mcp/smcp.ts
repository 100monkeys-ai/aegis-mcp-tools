import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'crypto';
import type { JsonRpcRequest, SmcpEnvelope } from './types.js';

export interface SessionKeyPair {
    privateKey: KeyObject;
    publicKey: KeyObject;
    publicKeyRaw: Buffer;
}

export interface ZaruSmcpSession {
    sessionId: string;
    securityToken: string;
    securityContext: string;
    keyPair: SessionKeyPair;
}

function sortRecursively(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortRecursively);
    }

    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((acc, key) => {
                acc[key] = sortRecursively((value as Record<string, unknown>)[key]);
                return acc;
            }, {});
    }

    return value;
}

export function stableStringify(value: unknown): string {
    return JSON.stringify(sortRecursively(value));
}

export function createSessionKeyPair(): SessionKeyPair {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

    if (!jwk.x) {
        throw new Error('Unable to export Ed25519 public key for SMCP attestation');
    }

    return {
        privateKey,
        publicKey,
        publicKeyRaw: Buffer.from(jwk.x, 'base64url')
    };
}

export function createSessionId(): string {
    return randomUUID();
}

export function buildCanonicalMessage(
    securityToken: string,
    payload: JsonRpcRequest,
    timestampIso: string
): Buffer {
    const timestampUnix = Math.floor(new Date(timestampIso).getTime() / 1000);
    if (!Number.isFinite(timestampUnix)) {
        throw new Error(`Invalid SMCP timestamp: ${timestampIso}`);
    }

    return Buffer.from(
        stableStringify({
            payload,
            security_token: securityToken,
            timestamp: timestampUnix
        }),
        'utf-8'
    );
}

export function buildSmcpEnvelope(
    securityToken: string,
    payload: JsonRpcRequest,
    privateKey: SessionKeyPair['privateKey'],
    timestampIso = new Date().toISOString()
): SmcpEnvelope {
    const message = buildCanonicalMessage(securityToken, payload, timestampIso);
    const signature = sign(null, message, privateKey).toString('base64');

    return {
        protocol: 'smcp/v1',
        security_token: securityToken,
        signature,
        payload,
        timestamp: timestampIso
    };
}
