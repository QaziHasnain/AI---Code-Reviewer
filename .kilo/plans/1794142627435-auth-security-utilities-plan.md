# AI Code Reviewer — Commit 3.2.1 Architecture Plan
## Password Hashing and Session Utilities (Revised)

---

## 1. Responsibilities of Each Utility

### Password Utility
- Hash plaintext passwords using Argon2id before persisting to `User.passwordHash`
- Verify a plaintext password against a stored Argon2id hash during authentication
- Accept and return the full Argon2id encoded hash string (contains salt, parameters, and hash together)
- Validate input passwords: minimum 12 characters, maximum 128 characters, non-empty
- Never log or return plaintext passwords
- Return descriptive but non-sensitive error messages

### Session Token Utility
- Generate cryptographically secure random session tokens using Node.js `crypto.randomBytes()`
- Generate exactly 32 cryptographically secure random bytes per token
- Return the **raw token only** (hex-encoded string) from the generation utility
- Do NOT hash tokens internally — hashing is the responsibility of the Token Hashing Utility
- Do NOT perform any database operations
- Do NOT calculate or return expiry times — expiry belongs to the future session/authentication service
- Validate that generated tokens meet minimum length requirements
- Return typed results rather than loose strings

### Token Hashing Utility
- Hash raw session tokens using SHA-256 before storing in `Session.tokenHash`
- Return lowercase hexadecimal digest (64 characters, compatible with `VARCHAR(64)`)
- Never log or persist raw (unhashed) tokens
- Do NOT provide constant-time comparison utilities — token lookups use indexed PostgreSQL `tokenHash` column, eliminating timing-attack surface at the utility layer

---

## 2. Recommended TypeScript Folder Structure

```
backend/
  src/
    config/
      env.ts
    routes/
      health.ts
    security/
      index.ts               # Barrel exports for all security utilities
      password/
        hash.ts              # Argon2id hashing
        verify.ts            # Argon2id verification
        types.ts             # Password utility types
        index.ts             # Password barrel
      session/
        generate.ts          # Secure random token generation (raw token only)
        types.ts             # Session token types
        index.ts             # Session token barrel
      token/
        hash.ts              # SHA-256 token hashing only
        types.ts             # Token hashing types
        index.ts             # Token barrel
    app.ts
    server.ts
    tests/
      security/
        password/
          hash.test.ts
          verify.test.ts
        session/
          generate.test.ts
        token/
          hash.test.ts
```

Rationale: Grouping by security domain (password/session/token) keeps concerns separated while allowing each utility to evolve independently. The `compare.ts` file and `compareTokens` function have been removed from the token utility per decision #5. Barrel exports simplify imports elsewhere in the codebase. Co-locating tests under `tests/security/` keeps them discoverable.

---

## 3. Proposed Function Signatures and Return Types

### Password Utility

```typescript
// src/security/password/types.ts

export interface PasswordHashResult {
  hash: string; // Full Argon2id encoded hash string
  algorithm: 'argon2id';
}

export interface PasswordVerifyResult {
  valid: boolean;
  needsRehash: boolean; // true if parameters should be upgraded
}

export class PasswordError extends Error {
  constructor(message: string, public readonly code: 'INVALID_INPUT' | 'HASH_FAILED' | 'VERIFY_FAILED');
}

export interface PasswordConfig {
  memoryCost: number;     // KiB
  timeCost: number;       // iterations
  parallelism: number;    // threads
  hashLength: number;     // bytes
  saltLength: number;     // bytes
  version: number;        // Argon2 version (19 or 13)
}

export interface PasswordPolicy {
  minLength: number;      // 12
  maxLength: number;      // 128
}

export const DEFAULT_PASSWORD_CONFIG: PasswordConfig;
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy;
```

```typescript
// src/security/password/hash.ts

export async function hashPassword(
  password: string,
  config?: Partial<PasswordConfig>
): Promise<PasswordHashResult>;
```

```typescript
// src/security/password/verify.ts

export async function verifyPassword(
  password: string,
  hash: string,
  config?: Partial<PasswordConfig>
): Promise<PasswordVerifyResult>;
```

### Session Token Utility

```typescript
// src/security/session/types.ts

export interface SessionTokenResult {
  token: string;       // Raw unhashed token (hex-encoded, 64 chars for 32 bytes)
}

export class SessionTokenError extends Error {
  constructor(message: string, public readonly code: 'GENERATION_FAILED');
}
```

```typescript
// src/security/session/generate.ts

export function generateSessionToken(
  lengthBytes: number
): SessionTokenResult;
```

Notes:
- `lengthBytes` defaults to 32; callers may override but 32 is the recommended value
- No `ttlMinutes` or `expiresAt` parameter — expiry calculation belongs to the future session/authentication service
- Returns raw token only; callers pass the raw token to `hashToken()` for DB storage

### Token Hashing Utility

```typescript
// src/security/token/types.ts

export interface TokenHashResult {
  hash: string; // SHA-256 hex digest (64 lowercase hex characters)
}

export class TokenHashError extends Error {
  constructor(message: string, public readonly code: 'HASH_FAILED');
}
```

```typescript
// src/security/token/hash.ts

export function hashToken(token: string): TokenHashResult;
```

Notes:
- `compareTokens` has been removed — no constant-time comparison utility needed
- SHA-256 hex output is 64 characters, compatible with `Session.tokenHash` VARCHAR(64)

### Combined Usage Example (application layer, not part of utilities)
```typescript
// Application/service layer combines the utilities
const { token } = generateSessionToken(32);           // raw token for client
const { hash } = hashToken(token);                     // hash for DB storage
// Store hash in Session.tokenHash, return raw token to client via cookie/header
```

---

## 4. Recommended Argon2id Parameters and Trade-offs

**Recommended production parameters:**

| Parameter | Value | Notes |
|-----------|-------|-------|
| `memoryCost` | 65536 KiB (64 MiB) | Strong resistance against GPU/ASIC attacks |
| `timeCost` | 3 iterations | Balances security with reasonable latency |
| `parallelism` | 4 threads | Subject to benchmarking; reduce to 1 on single-core hosts |
| `hashLength` | 32 bytes | 256-bit output |
| `saltLength` | 16 bytes | 128-bit salt |
| `version` | 19 | Latest Argon2 version standard |

**Trade-offs:**
- Higher memory/time cost increases resistance to brute-force but also increases authentication latency
- Parallelism of 4 assumes multi-core; benchmark before production deployment to confirm optimal value
- Parameters are embedded in the encoded hash string, allowing future upgrades without breaking existing hashes

**Why Argon2id over bcrypt/scrypt:** Argon2id won the Password Hashing Competition, provides resistance to both GPU and side-channel attacks, and allows tunable memory/time/parallelism parameters.

---

## 5. How Salts and Verification Work

**Salting:**
- A cryptographically random 16-byte salt is generated per password hash operation
- The salt is embedded in the Argon2id encoded hash string (format: `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`)
- Each password gets a unique salt, preventing identical passwords from producing identical hashes
- No separate salt storage column needed; salt travels with the hash

**Verification:**
- The stored Argon2id hash string is parsed to extract salt and parameters
- The provided plaintext password is hashed with the same salt and parameters
- The resulting hash is compared against the stored hash using constant-time comparison (handled by the argon2 library internally)
- `needsRehash` flag indicates if stored hash parameters are outdated (e.g., after parameter upgrades)

---

## 6. Why SHA-256 for Session Tokens but Not Passwords

| Aspect | User Passwords | Session Tokens |
|--------|---------------|----------------|
| Entropy source | User-chosen (low entropy) | CSPRNG-generated (high entropy, 256 bits) |
| Attack vector | Dictionary/brute-force | Preimage attack on hash |
| Recommended algorithm | Argon2id (memory-hard, slow) | SHA-256 (fast, one-way) |
| Salting required | Yes (unique per password) | No (token already unique/random) |
| Storage | `User.passwordHash` (TEXT) | `Session.tokenHash` (VARCHAR(64)) |

**SHA-256 is appropriate for session tokens because:**
- Session tokens are already high-entropy (32 bytes of CSPRNG output), making dictionary attacks infeasible
- SHA-256 produces a 64-character hex string matching the `VARCHAR(64)` column definition
- Fast hashing is acceptable since tokens are not vulnerable to offline brute-force attacks

**SHA-256 is NOT appropriate for passwords because:**
- Fast hashing enables GPU/ASIC-based brute-force attacks
- No built-in salting (salts must be managed separately)
- No configurable work factor to slow attackers over time

**No constant-time comparison utility needed:** Token validation uses indexed PostgreSQL lookups on `Session.tokenHash` (which is `@unique`), so there is no timing-attack surface at the utility layer that requires `crypto.timingSafeEqual`.

---

## 7. Security Requirements and Edge Cases

**Security Requirements:**
- Plaintext passwords must never appear in logs, error messages, or responses
- Raw session tokens must never be persisted to the database (only SHA-256 hashes)
- All cryptographic operations must use Node.js `crypto` module (built-in, no external RNG)
- Password minimum length: 12 characters; maximum: 128 characters
- Session token length: 32 bytes (256 bits)
- Session lifetime default: 7 days; configurable via environment/external config
- Session expiry calculation belongs to the future session/authentication service, not this utility layer
- No sliding session renewal in Commit 3.2
- Argon2id parameters must be versioned within the hash string for future upgrades

**Edge Cases:**
- Empty or whitespace-only passwords → throw `PasswordError` with `INVALID_INPUT`
- Passwords shorter than 12 characters → throw `PasswordError` with `INVALID_INPUT`
- Passwords longer than 128 characters → throw `PasswordError` with `INVALID_INPUT`
- Corrupted or tampered hash strings → throw `PasswordError` with `VERIFY_FAILED`
- Concurrent session generation for same user → each token is independent; no collision handling needed at utility layer
- Token reuse detection → handled at application layer, not utility layer
- Clock skew for token expiration → handled at application layer

---

## 8. Proposed Vitest Unit Tests

### Password Utility Tests (`tests/security/password/hash.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, DEFAULT_PASSWORD_POLICY } from '@/security/password';

describe('hashPassword', () => {
  it('hashes a valid password meeting policy', async () => {
    const result = await hashPassword('SecurePass123!Ab');
    expect(result.hash).toMatch(/^\$argon2id\$/);
    expect(result.algorithm).toBe('argon2id');
  });

  it('rejects passwords shorter than 12 characters', async () => {
    await expect(hashPassword('Short1!')).rejects.toThrow();
  });

  it('rejects passwords longer than 128 characters', async () => {
    const longPassword = 'a'.repeat(129);
    await expect(hashPassword(longPassword)).rejects.toThrow();
  });

  it('rejects empty passwords', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('rejects whitespace-only passwords', async () => {
    await expect(hashPassword('   ')).rejects.toThrow();
  });

  it('produces different hashes for same password (unique salt)', async () => {
    const h1 = await hashPassword('SecurePass123!Ab');
    const h2 = await hashPassword('SecurePass123!Ab');
    expect(h1.hash).not.toBe(h2.hash);
  });

  it('uses provided config parameters', async () => {
    const result = await hashPassword('SecurePass123!Ab', { memoryCost: 16384, timeCost: 1 });
    expect(result.hash).toContain('m=16384,t=1');
  });

  it('exports correct password policy defaults', () => {
    expect(DEFAULT_PASSWORD_POLICY.minLength).toBe(12);
    expect(DEFAULT_PASSWORD_POLICY.maxLength).toBe(128);
  });
});
```

```typescript
// tests/security/password/verify.test.ts

describe('verifyPassword', () => {
  it('verifies correct password', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab');
    const result = await verifyPassword('SecurePass123!Ab', hash);
    expect(result.valid).toBe(true);
  });

  it('rejects wrong password', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab');
    const result = await verifyPassword('WrongPass123!Ab', hash);
    expect(result.valid).toBe(false);
  });

  it('rejects malformed hash', async () => {
    await expect(verifyPassword('SecurePass123!Ab', 'invalid-hash')).rejects.toThrow();
  });

  it('flags needsRehash for outdated parameters', async () => {
    const { hash } = await hashPassword('SecurePass123!Ab', { memoryCost: 16384 });
    const result = await verifyPassword('SecurePass123!Ab', hash, { memoryCost: 65536 });
    expect(result.needsRehash).toBe(true);
  });
});
```

### Session Token Utility Tests (`tests/security/session/generate.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { generateSessionToken } from '@/security/session';

describe('generateSessionToken', () => {
  it('generates a token of expected length (32 bytes = 64 hex chars)', () => {
    const result = generateSessionToken(32);
    expect(result.token).toHaveLength(64);
  });

  it('returns raw token only (no hash, no expiry)', () => {
    const result = generateSessionToken(32);
    expect(result).toHaveProperty('token');
    expect(result).not.toHaveProperty('hash');
    expect(result).not.toHaveProperty('expiresAt');
  });

  it('generates unique tokens on each call', () => {
    const t1 = generateSessionToken(32);
    const t2 = generateSessionToken(32);
    expect(t1.token).not.toBe(t2.token);
  });

  it('produces valid hex encoding', () => {
    const result = generateSessionToken(32);
    expect(/^[0-9a-f]+$/.test(result.token)).toBe(true);
  });

  it('throws on zero length', () => {
    expect(() => generateSessionToken(0)).toThrow();
  });
});
```

### Token Hashing Utility Tests (`tests/security/token/hash.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { hashToken } from '@/security/token';

describe('hashToken', () => {
  it('produces 64-character hex hash', () => {
    const result = hashToken('raw-token-value');
    expect(result.hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(result.hash)).toBe(true);
  });

  it('produces consistent output for same input', () => {
    const h1 = hashToken('same-token');
    const h2 = hashToken('same-token');
    expect(h1.hash).toBe(h2.hash);
  });

  it('produces different output for different inputs', () => {
    const h1 = hashToken('token-a');
    const h2 = hashToken('token-b');
    expect(h1.hash).not.toBe(h2.hash);
  });

  it('output is compatible with VARCHAR(64)', () => {
    const result = hashToken('any-token');
    expect(result.hash.length).toBeLessThanOrEqual(64);
  });
});
```

---

## 9. Required npm Dependencies

### Existing Dependencies (already in package.json)

| Dependency | Purpose |
|------------|---------|
| `vitest` ^3.2.7 | Unit testing framework |
| `@types/node` ^22.20.5 | Node.js type definitions (includes `crypto` types) |
| `zod` ^4.6.7 | Input validation (optional, for password length validation) |
| `@prisma/client` ^6.19.3 | Database client (for future integration) |

### New Dependencies (required)

| Dependency | Version | Purpose | Type | Status |
|------------|---------|---------|------|--------|
| `argon2` | ^0.41.0 | Argon2id password hashing | Production dependency | New |
| `@types/argon2` | ^0.41.0 | TypeScript types for argon2 | Dev dependency | **Verification pending** |

**Note:** Node.js `crypto` module is built-in; no dependency needed for SHA-256 or random token generation.

**Verification required:** Whether the `argon2` npm package bundles its own TypeScript declarations. If it does, `@types/argon2` is unnecessary. If not, `@types/argon2` must be added as a dev dependency. This must be confirmed before implementation.

---

## 10. Integration with Prisma Session Model

The utilities integrate with the existing Prisma schema as follows:

**User model integration:**
```typescript
// During registration / password change
const { hash } = await hashPassword(plaintextPassword);
await prisma.user.create({
  data: { email, passwordHash: hash, ... }
});
```

**Session model integration:**
```typescript
// During session creation (application/service layer, not utility layer)
const { token } = generateSessionToken(32);                    // raw token for client
const { hash } = hashToken(token);                               // hash for DB storage
await prisma.session.create({
  data: {
    userId,
    tokenHash: hash,        // SHA-256 hex digest stored in VARCHAR(64)
    expiresAt: <calculated by session service>,               // default 7 days, configurable
  },
});

// Raw token returned to client via cookie or Authorization header
// Session tokenHash is @unique, enabling indexed PostgreSQL lookup
```

**Key integration points:**
- `User.passwordHash` stores the full Argon2id encoded hash string (salt + parameters + hash embedded)
- `Session.tokenHash` stores SHA-256 hex digest of the raw session token
- Raw session token is returned to the client and never stored
- `Session.tokenHash` is `@unique` and `VARCHAR(64)`, matching SHA-256 hex output length
- `Session` has indexes on `userId` and `expiresAt` for efficient lookup and cleanup
- Expiry calculation is NOT part of the token generation utility — belongs to future session service

---

## Security Decisions Requiring Approval

1. **Argon2id memory cost**: 65536 KiB (64 MiB). Lower to 32768 KiB if memory-constrained.
2. **Argon2id parallelism**: 4 threads, subject to benchmarking before production deployment.
3. **Password policy**: Minimum 12 characters, maximum 128 characters.
4. **Session token length**: 32 bytes (256 bits) raw output.
5. **Session lifetime default**: 7 days, configurable via external config (not hardcoded in utilities).
6. **Token encoding**: Hexadecimal for tokens and SHA-256 hashes.
7. **Folder structure**: `src/security/{password,session,token}/` with barrel exports.
8. **@types/argon2**: Verification pending — confirm whether `argon2` bundles its own TypeScript declarations before installing.
9. **No constant-time comparison**: Confirmed decision — not needed due to indexed PostgreSQL lookups.

---

## Implementation Notes

- Do not implement registration, login, logout, cookies, or database session operations in this commit — those are separate features
- All utilities are pure functions with no side effects (no DB calls, no logging)
- Error classes extend `Error` with typed error codes for programmatic handling
- TypeScript `strict` mode recommended; all functions explicitly typed
- No external logging framework dependency; callers handle logging
- Vitest configured to run from `backend/` directory using existing `npm test` script
- The `compare.ts` file and `compareTokens` function have been deliberately omitted
