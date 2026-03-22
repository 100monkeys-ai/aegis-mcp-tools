import test from 'node:test';
import assert from 'node:assert/strict';
import { verify } from 'crypto';
import { buildCanonicalMessage, buildSmcpEnvelope, createSessionKeyPair, stableStringify } from '../src/mcp/smcp.js';

test('stableStringify sorts object keys recursively', () => {
    const value = {
        z: 1,
        a: {
            c: 3,
            b: 2
        }
    };

    assert.equal(stableStringify(value), '{"a":{"b":2,"c":3},"z":1}');
});

test('buildSmcpEnvelope produces a verifiable canonical signature', () => {
    const keyPair = createSessionKeyPair();
    const payload = {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'tools/call',
        params: {
            name: 'fs.read',
            arguments: {
                path: '/workspace/demo.txt'
            }
        }
    };

    const envelope = buildSmcpEnvelope('security-token', payload, keyPair.privateKey, '2026-03-21T12:34:56.000Z');
    const message = buildCanonicalMessage(envelope.security_token, envelope.payload, envelope.timestamp);

    assert.equal(envelope.protocol, 'smcp/v1');
    assert.match(envelope.timestamp, /^2026-03-21T12:34:56.000Z$/);
    assert.equal(
        verify(null, message, keyPair.publicKey, Buffer.from(envelope.signature, 'base64')),
        true
    );
});
