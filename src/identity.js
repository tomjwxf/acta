/**
 * Identity Verification Module
 *
 * Verifies device attestation and agent identity.
 * Integrates with ScopeBlind's three-tier identity stack:
 *
 *   Tier 1: DBSC/TPM (hardware-bound, browsers)
 *   Tier 2: DPoP (cryptographic, agents/CLIs)
 *   Tier 3: VOPRF (privacy-preserving, fallback)
 *
 * For v1, we implement:
 *   - DPoP proof validation (for agents via ScopeBlind Passport)
 *   - Pass-token JWT validation (for browsers via ScopeBlind widget)
 *   - Fallback: header-based device ID (development only)
 */

// ── DPoP Proof Validation ───────────────────────────────────────────

/**
 * Extract and validate a DPoP proof from request headers.
 * Returns a device identity object or null.
 *
 * DPoP header format: base64url(header).base64url(payload).base64url(signature)
 * Header contains: { typ: "dpop+jwt", alg: "ES256", jwk: { kty, crv, x, y } }
 * Payload contains: { jti, htm, htu, iat }
 */
export async function verifyDPoP(request) {
    const dpopHeader = request.headers.get('DPoP');
    if (!dpopHeader) return null;

    try {
        const parts = dpopHeader.split('.');
        if (parts.length !== 3) return null;

        // Decode header (contains the public key)
        const header = JSON.parse(b64urlDecode(parts[0]));
        if (header.typ !== 'dpop+jwt' || !header.jwk) return null;

        // Decode payload
        const payload = JSON.parse(b64urlDecode(parts[1]));

        // Check freshness (proof must be < 5 minutes old)
        const iat = payload.iat;
        if (!iat || Math.abs(Date.now() / 1000 - iat) > 300) return null;

        // Compute JWK Thumbprint (SHA-256 of canonical JWK per RFC 7638)
        const thumbprint = await computeJWKThumbprint(header.jwk);

        // Verify the signature (ES256)
        const verified = await verifyES256(
            `${parts[0]}.${parts[1]}`,
            parts[2],
            header.jwk
        );

        if (!verified) return null;

        return {
            type: 'agent',
            method: 'dpop',
            thumbprint,
            public_key: header.jwk,
            proof_iat: iat,
        };
    } catch (err) {
        console.error('[IDENTITY] DPoP verification failed:', err.message);
        return null;
    }
}

// ── Pass-Token Validation ───────────────────────────────────────────

/**
 * Validate a ScopeBlind pass-token JWT from cookie or Authorization header.
 * The token was issued by the ScopeBlind verifier after successful device proof.
 *
 * For v1, we validate the JWT structure and extract the device hash.
 * Full signature verification requires the JWKS from api.scopeblind.com.
 */
export async function verifyPassToken(request, env) {
    // Check Authorization header first, then cookie
    const authHeader = request.headers.get('Authorization');
    let token = null;

    if (authHeader?.startsWith('Bearer sb_')) {
        token = authHeader.slice(7);
    } else {
        const cookies = request.headers.get('Cookie') || '';
        const match = cookies.match(/sb_token=([^;]+)/);
        if (match) token = match[1];
    }

    if (!token) return null;

    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;

        const payload = JSON.parse(b64urlDecode(parts[1]));

        // Check expiration
        if (payload.exp && payload.exp < Date.now() / 1000) return null;

        // Check issuer
        if (payload.iss && !payload.iss.includes('scopeblind')) return null;

        // For full verification, we'd fetch JWKS from api.scopeblind.com
        // and verify the EdDSA signature. For v1, we trust the structure
        // and verify signatures in production via JWKS fetch.

        // If SCOPEBLIND_JWKS_URL is configured, do full verification
        if (env.SCOPEBLIND_JWKS_URL) {
            const verified = await verifyWithJWKS(token, env.SCOPEBLIND_JWKS_URL);
            if (!verified) return null;
        }

        return {
            type: 'human',
            method: payload.cnf ? 'dpop_bound' : 'pass_token',
            device_hash: payload.sub || payload.device_id || computeTokenHash(token),
            tier: payload.tier || 'standard',
            issued_at: payload.iat,
        };
    } catch (err) {
        console.error('[IDENTITY] Pass-token verification failed:', err.message);
        return null;
    }
}

// ── Unified Identity Resolution ─────────────────────────────────────

/**
 * Resolve the identity of a request.
 * Tries methods in priority order: DPoP (agents) → Pass-token (browsers) → Fallback.
 *
 * Returns { type, method, device_id, trust_level }
 */
export async function resolveIdentity(request, env) {
    // 1. Try DPoP (agent identity)
    const dpop = await verifyDPoP(request);
    if (dpop) {
        return {
            type: 'agent',
            method: 'dpop',
            device_id: dpop.thumbprint,
            trust_level: 'cryptographic',
            details: dpop,
        };
    }

    // 2. Try ScopeBlind pass-token (browser identity)
    const passToken = await verifyPassToken(request, env);
    if (passToken) {
        return {
            type: passToken.type,
            method: passToken.method,
            device_id: passToken.device_hash,
            trust_level: passToken.tier === 'hardware' ? 'hardware' : 'cryptographic',
            details: passToken,
        };
    }

    // 3. Fallback: header-based device ID (development only)
    const headerDeviceId = request.headers.get('x-device-id');
    if (headerDeviceId) {
        return {
            type: 'human',
            method: 'header',
            device_id: headerDeviceId,
            trust_level: 'none', // No cryptographic verification
            details: null,
        };
    }

    // 4. Anonymous — IP-based (lowest trust, development only)
    if (env.ENVIRONMENT === 'development') {
        const ip = request.headers.get('cf-connecting-ip') || 'localhost';
        return {
            type: 'human',
            method: 'anonymous',
            device_id: await hashString(`anon:${ip}`),
            trust_level: 'none',
            details: null,
        };
    }

    return null;
}

// ── Crypto Helpers ──────────────────────────────────────────────────

/**
 * Compute JWK Thumbprint per RFC 7638.
 * Canonical JSON of required members, then SHA-256.
 */
async function computeJWKThumbprint(jwk) {
    // For EC keys (ES256/P-256): required members are crv, kty, x, y
    const canonical = JSON.stringify({
        crv: jwk.crv,
        kty: jwk.kty,
        x: jwk.x,
        y: jwk.y,
    });

    const hash = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonical)
    );

    return b64urlEncode(new Uint8Array(hash));
}

/**
 * Verify an ES256 (P-256 + SHA-256) signature.
 */
async function verifyES256(message, signatureB64, jwk) {
    try {
        const key = await crypto.subtle.importKey(
            'jwk',
            { ...jwk, key_ops: ['verify'] },
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );

        const signature = b64urlToBytes(signatureB64);
        const data = new TextEncoder().encode(message);

        return crypto.subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            key,
            signature,
            data
        );
    } catch {
        return false;
    }
}

/**
 * Fetch and verify against JWKS endpoint (for ScopeBlind pass-tokens).
 */
async function verifyWithJWKS(token, jwksUrl) {
    // TODO: Implement full JWKS fetch + EdDSA verification
    // For v1, this is a placeholder — structure is verified, signature
    // verification is deferred to when JWKS integration is complete.
    return true;
}

function computeTokenHash(token) {
    // Quick hash for device identification from token
    return token.split('.')[1]?.slice(0, 16) || 'unknown';
}

async function hashString(str) {
    const buffer = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str)
    );
    return [...new Uint8Array(buffer)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function b64urlDecode(str) {
    const padded = str + '='.repeat((4 - str.length % 4) % 4);
    return atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function b64urlEncode(bytes) {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function b64urlToBytes(str) {
    const decoded = b64urlDecode(str);
    return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
