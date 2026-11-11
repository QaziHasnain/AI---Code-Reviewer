# AI Code Reviewer Backend (Phase 0)

Fastify + TypeScript backend scaffold.

## Scripts (PowerShell)

Run from `D:\AI - Code Reviewer\backend`:

```powershell
npm run dev
npm run build
npm run start
npm run typecheck
npm run test
npm run prisma:generate
npm run prisma:validate
```

## Environment

Copy `.env.example` to `.env` and set `DATABASE_URL` for local PostgreSQL.
AI-related variables are optional in Phase 0.

## Authentication rate limiting

Login attempts use PostgreSQL-backed fixed-window buckets keyed by an HMAC-SHA-256 digest of the client IP and window. This storage is shared across backend instances using the application database. Apply the `AuthRateLimitBucket` migration before deploying the updated server. Expired buckets are removed opportunistically during login requests; for high traffic deployments, schedule database cleanup and monitor bucket-table growth. The rate limit is 10 attempts per 15-minute window per client IP.

Set `RATE_LIMIT_HMAC_SECRET` to at least 32 random bytes encoded as hexadecimal. Generate it with `openssl rand -hex 32` and keep it in the deployment secret manager; never commit it, print it, or send it to clients. Every instance sharing a rate-limit database must use the same active secret. Rotating it changes all derived keys and effectively starts fresh rate-limit buckets for the active window. Coordinate rotation across instances; consider it a limiter reset, and rotate immediately if the secret may have leaked.

`TRUSTED_PROXY_ADDRESSES` is an optional comma-separated list of exact proxy IP addresses. Fastify trusts forwarded client-IP headers only when the connection comes from one of those addresses. Keep it empty when the app is reached directly. In proxied deployments, list only the actual ingress/proxy addresses and prevent direct public access to the app; do not list client networks or use wildcard trust. Ensure the proxy overwrites incoming forwarded-IP headers. Configure stable proxy addresses before deployment; if the infrastructure uses changing addresses, maintain the list through deployment configuration. Without trusted proxies, `request.ip` remains the direct peer address.

Registration creates the user and session through one Prisma interactive transaction using its transaction client for both inserts. If either operation fails before commit, PostgreSQL rolls both writes back. As with any database transaction, a connection loss while the commit acknowledgement is in flight can leave the caller uncertain about whether the atomic transaction committed; inspect the email/account state before retrying such an ambiguous request.
