# Code Review API Design

**Status:** Proposed design (Commit 3.4.7; no implementation)

This document describes a review API that fits the current backend. “Existing” describes code observed in the repository; all endpoint, worker, and schema changes below are proposals unless explicitly marked otherwise.

## 1. Repository architecture assessment

### Existing implementation

- The backend is a TypeScript ES module application using Fastify 5, Prisma 6, PostgreSQL, and Zod. `backend/src/app.ts` builds the app and registers CORS, cookies, health routes, optional authentication, and optional authentication routes.
- `backend/src/server.ts` creates one `PrismaClient`, constructs services and stores, injects dependencies into `buildApp`, and owns graceful shutdown through `startServer`.
- Authentication is cookie/session based. The `requireAuth` decorator validates the session, reloads a safe user projection, and attaches `{ userId, user, sessionId }` to `request.auth`. Protected route handlers use `app.requireAuth` and derive ownership from `request.auth.userId`.
- Auth routes parse request bodies with Zod `safeParse`, return explicit `{ error: { code, message } }` payloads, and hide persistence details. Auth has same-origin checks and PostgreSQL-backed fixed-window rate limits. These controls apply to auth routes; there is no general API rate limiter.
- Services receive narrow dependency interfaces for Prisma operations, and tests inject fakes. Integration tests use an explicitly configured test database and `app.inject`.
- Fastify's body limit is currently its 1 MiB default. No global Zod integration, review service, review routes, worker, queue, AI adapter, or global error handler was found.
- `backend/prisma/schema.prisma` already declares `User`, `CodeReview`, `ReviewResult`, and `ReviewIssue`, plus enums. `CodeReview` has `PENDING`, `SUBMITTED`, `PROCESSING`, `COMPLETED`, `FAILED`, and `CANCELLED`; it stores source text and language and belongs to a user. It has no instruction, lifecycle timestamps, failure metadata, idempotency key, retry count, or durable job relation. Results are one-to-many from a review, with provider/model/token/duration fields; issues belong to a result. Existing indexes are `(userId, createdAt)`, `(codeReviewId, createdAt)`, and `(reviewResultId, severity)`.
- The root `docs/architecture.md` exists but is empty. This focused design document follows the repository's existing `docs/` convention.

### Design implications

Use Fastify route plugins and Zod request schemas, inject a review service alongside current app dependencies, keep Prisma details in service/repository boundaries, and create a separate worker entry point that reuses shared service and AI-provider contracts. The Prisma schema is not sufficient for reliable asynchronous processing without recommended additions described below. No new infrastructure dependency is required for an initial PostgreSQL-backed queue.

## 2. Proposed API specification

Base path: `/api/reviews`. All endpoints require the existing authenticated session, except `POST /api/reviews` only if product requirements explicitly decide otherwise; the recommendation is to require authentication for every review endpoint. Use UUID review/result/issue identifiers.

### Submit a review

`POST /api/reviews` — authenticated; same-origin protection should follow the cookie-authenticated mutation policy used by auth routes.

Request fields:

| Field | Type | Rules |
| --- | --- | --- |
| `sourceCode` | string | Required, non-empty; UTF-8 byte length at most 256 KiB initially. Reject whitespace-only input. |
| `programmingLanguage` | enum string | Required; match supported API language identifiers to `ProgrammingLanguage`. |
| `instructions` | string | Optional; trimmed, max 4 KiB; treated as untrusted user content, not system instructions. |
| `repository`, `branch`, `commitHash` | string | Optional metadata only; bounded length; never fetch or execute based on these fields. |
| `idempotencyKey` | string/header | Recommend `Idempotency-Key` header, 1–128 printable ASCII characters. Scope uniqueness to authenticated user. |

The route should enforce limits before expensive processing. Fastify's global 1 MiB body limit is too permissive for this endpoint's desired limit; use a route-specific body limit around 300 KiB to cover JSON overhead and a stricter schema check on the source text's UTF-8 byte count. Do not silently truncate source.

Success: `202 Accepted`, with `Location: /api/reviews/{reviewId}` and a response such as:

```json
{
  "review": {
    "id": "9c3c79d2-ef0f-4ac9-bcf8-fd6eb8a2f121",
    "status": "PENDING",
    "programmingLanguage": "TYPESCRIPT",
    "createdAt": "2026-11-11T10:00:00.000Z",
    "statusUrl": "/api/reviews/9c3c79d2-ef0f-4ac9-bcf8-fd6eb8a2f121"
  }
}
```

Return no source, AI prompt, provider details, or analysis in the submission acknowledgement. If a repeated idempotency key has the same normalized payload, return the original review (prefer `200 OK` with the same representation and `Idempotency-Replayed: true`; alternatively consistently replay the original status/body). If key and payload differ, return `409 IDEMPOTENCY_KEY_REUSED`.

### Retrieve a review

`GET /api/reviews/{reviewId}` — authenticated. Return review metadata and current status. Include a result summary only once completed, or direct clients to the result endpoint. Do not return source code by default; consider an explicit `includeSource=true` only if product needs it and response/privacy policy is settled.

### List reviews

`GET /api/reviews?limit=20&cursor={opaque}&sort=createdAt&order=desc&status=COMPLETED` — authenticated. `limit` defaults to 20 and is bounded to 100. Allowlist `sort` (`createdAt`, optionally `updatedAt`) and `order` (`asc`, `desc`); never map arbitrary user strings to Prisma fields. Prefer cursor pagination using `(createdAt, id)` stable ordering. Return `items` plus `nextCursor`; scope every query to the authenticated user. Offset pagination can be added for simple clients but is less stable under concurrent inserts.

Example:

```json
{
  "items": [
    {
      "id": "9c3c79d2-ef0f-4ac9-bcf8-fd6eb8a2f121",
      "status": "COMPLETED",
      "programmingLanguage": "TYPESCRIPT",
      "createdAt": "2026-11-11T10:00:00.000Z",
      "completedAt": "2026-11-11T10:00:08.000Z"
    }
  ],
  "nextCursor": null
}
```

List projections should omit source, full analysis, and issue descriptions to keep pages compact and avoid returning sensitive content unnecessarily.

### Retrieve results and issues

- `GET /api/reviews/{reviewId}/results` — authenticated. While queued/processing, return `202` with `{ "reviewId": "...", "status": "PROCESSING", "result": null }` and optionally `Retry-After`. On completion, return result summary, outcome, score, detailed analysis, provider/model only if product chooses to expose these operational details, and a paginated issue list or link. On failure, return `409 REVIEW_NOT_COMPLETED` with the safe status and error code, not a fake empty result.
- `GET /api/reviews/{reviewId}/issues/{issueId}` — authenticated. Ensure both IDs are tied to the same owned review in the query. Return issue fields and locations/suggestion. Do not allow retrieval through a global issue ID alone.
- Optional `GET /api/reviews/{reviewId}/issues` — authenticated, cursor-paginated and severity-sortable through a fixed allowlist. Add if clients need independent issue paging.

### Status and error codes

| Status | Use |
| --- | --- |
| `202` | Review accepted; processing is asynchronous, or result resource is not ready. |
| `200` | Retrieval succeeded, or idempotent replay policy chooses a normal response. |
| `400` | Malformed JSON/schema, invalid language, invalid cursor, or invalid query. |
| `401` | Missing, invalid, expired, or revoked session (existing convention). |
| `403` | Origin rejected for cookie-authenticated mutation, if same-origin check fails. |
| `404` | Missing review/result/issue **and** resource owned by another user; avoid an ownership oracle. |
| `409` | Idempotency-key payload conflict or result requested for a terminal failed/cancelled review. |
| `413` | Body exceeds Fastify route limit or source byte limit. |
| `429` | Per-user/IP review submission quota exceeded; include `Retry-After`. |
| `503` | Database/queue unavailable before acceptance; do not claim acceptance if enqueue transaction did not commit. |

Use the existing generic envelope: `{ "error": { "code": "INVALID_INPUT", "message": "..." } }`. Validation messages should not echo source text or secret values. Unexpected errors are logged with a request ID and returned as generic `500`; transient storage/queue unavailability can map to `503`.

## 3. Review lifecycle and transition rules

The proposed diagram's `PENDING -> QUEUED -> PROCESSING -> COMPLETED|FAILED` is understandable but the existing enum has `SUBMITTED`, not `QUEUED`. Avoid two states that mean “accepted and waiting” unless they convey distinct, observable semantics. Recommended public lifecycle:

```text
PENDING -> QUEUED -> PROCESSING -> COMPLETED
                              \-> RETRY_WAIT -> QUEUED
                              \-> FAILED
QUEUED / PENDING -> CANCELLED (only if cancellation is implemented)
```

Alternatively, retain `SUBMITTED` as the public accepted/queued state and document it as the waiting state. Do not expose both `SUBMITTED` and `QUEUED` for the same meaning. State changes must occur through guarded service operations, not arbitrary status updates.

Rules:

1. Create review and durable queue job atomically; create in `QUEUED` (or `PENDING` only if a separate dispatcher reliably changes it to `QUEUED`). A review must not be reported accepted until this transaction commits.
2. A worker claims only a queued/eligible job and atomically records lease/attempt metadata while moving the review to `PROCESSING`. Competing workers cannot claim the same live lease.
3. Only the worker holding the current lease/attempt may write completion/failure. Complete by atomically inserting the result and issues and changing the review to `COMPLETED`.
4. On retryable failure, persist attempt/error category and a future `availableAt`; mark `RETRY_WAIT` or keep the job queued with delay. After the configured bounded attempts, mark terminal `FAILED`.
5. `COMPLETED`, `FAILED`, and `CANCELLED` are terminal for the original review. Reprocessing a completed review should create a new review so its input, result, audit trail, and status are immutable and understandable. Retry transient infrastructure/provider failures against the same review/job and attempt history; do not create duplicate user-visible reviews for automatic retries.
6. Invalid transitions (for example `FAILED -> PROCESSING`, `COMPLETED -> QUEUED`) are rejected. Use conditional updates (`where id/status/lease token`) and check affected row count; enforce uniqueness and foreign keys in the database.
7. Avoid a broad transaction around AI network calls. A worker transaction claims/leases briefly; AI work happens outside the transaction; a short final transaction writes result/issues and terminal state. Lease expiry and idempotent final writes recover from worker crashes.

`CANCELLED` is already in the enum but no cancellation API is requested. Defer cancel semantics until the worker can safely stop or ignore a running task. Prefer no exposed cancel endpoint initially.

## 4. Ownership and IDOR protection

Every review read/update starts with `where: { id: reviewId, userId: request.auth!.userId }`. For nested resources, include ownership in the same relational query, e.g. issue where `id = issueId AND reviewResult.codeReviewId = reviewId AND reviewResult.codeReview.userId = auth.userId`. Do not first fetch an unscoped object and authorize afterward, and do not accept `userId` from request bodies or query strings. Return indistinguishable `404` for nonexistent and foreign-owned IDs. Authenticated route prehandlers establish identity; the service still requires `userId` explicitly to make ownership mandatory and testable. Add tests that attempt cross-account access on every retrieval route and verify no foreign data is returned.

## 5. Service-layer and route structure

Proposed modules, following existing conventions:

```text
backend/src/routes/reviews.ts              HTTP parsing, auth, status mapping
backend/src/reviews/schemas.ts             Zod body/params/query schemas
backend/src/reviews/service.ts             ownership, lifecycle, transactions
backend/src/reviews/repository.ts          narrow Prisma operations (optional initially)
backend/src/reviews/queue.ts               durable enqueue/claim/ack abstraction
backend/src/analysis/provider.ts           provider-neutral request/result contract
backend/src/analysis/providers/...         provider adapters, added when selected
backend/src/workers/review-worker.ts       worker loop / process entry point
```

Inject a `ReviewService` into `buildApp` as `reviewRoutes` already are injected for auth, and instantiate it with the shared Prisma client in `server.ts`. Keep route handlers thin: parse Zod, read `request.auth.userId`, call service, map typed domain errors. Use explicit Prisma selects for public projections. Keep provider SDKs and prompts out of route modules. No current migration convention or AI provider implementation was found, so provider choice and migration workflow should be confirmed before implementation.

## 6. Asynchronous processing architecture

Recommended initial shape:

```text
Browser -> Fastify route -> ReviewService -> PostgreSQL transaction
                                           |-- CodeReview
                                           |-- idempotency record/key
                                           `-- durable ReviewJob

Review worker -> claim job/lease -> AnalysisProvider interface -> provider
       -> validate structured response -> transaction: result + issues + completed state
```

The API should not invoke an AI provider inline. Request timeouts, client disconnects, provider latency, and process restart make synchronous review work unreliable. A durable PostgreSQL job/outbox is the smallest production-oriented starting point because PostgreSQL and Prisma already exist and no broker dependency is present. Implement atomic enqueue and worker claiming with a short transaction and database locking/conditional updates; Prisma may require parameterized raw SQL for `FOR UPDATE SKIP LOCKED`. Keep this logic behind `ReviewQueue` so a broker can replace it later if throughput requires it. Do not add Redis/BullMQ/Kafka without measured scale or operational need.

Worker responsibilities: lease one eligible job; enforce attempt count and timeout; load source only for processing; call provider adapter; validate provider output against a strict Zod schema; normalize issues and line ranges; persist results and terminal status atomically; classify retryable versus permanent failures; redact logs; renew/release lease; recover expired leases. A worker must never execute submitted source code. Provider responses are untrusted data and must be parsed, bounded, and treated as content, not instructions.

Provider abstraction should accept language, source, bounded user instructions, and a correlation/job ID; return a versioned structured result (outcome, score, summary, analysis, issue array with severity/type/location/fix). Validate score 0–100, enums, lengths, nonnegative token counts/duration, line ranges and issue count before persistence. Track provider/model and usage for operations/cost accounting, but expose only intentionally public fields.

## 7. Database recommendations (proposal only)

The current models provide a useful starting point but cannot alone guarantee durable, idempotent, recoverable asynchronous execution.

Recommended changes, separately from current schema:

- **CodeReview:** add `instructions` (nullable, bounded at API), `queuedAt`, `startedAt`, `completedAt`, `failedAt`, `failureCode` (safe enum/string, no raw provider error), `attemptCount`, `lastAttemptAt`, and optionally `inputHash`/`schemaVersion`. Add `(userId, createdAt, id)` index for stable listing. Preserve source retention only as long as product/privacy policy requires.
- **Status enum:** settle `SUBMITTED` versus `QUEUED`; recommend a single waiting state plus `PROCESSING`, `RETRY_WAIT` if visible, `COMPLETED`, `FAILED`; keep `CANCELLED` only with defined semantics. State machine updates remain service-controlled.
- **ReviewJob:** durable job relation with review ID, state, `availableAt`, `attemptCount`, `leaseUntil`, `leaseToken`, `lastErrorCode`, timestamps; unique job per review for the initial one-job-per-review model, indexes on `(state, availableAt)` and lease expiry. A separate job table keeps queue scheduling metadata out of API-facing review rows.
- **Idempotency:** add a user-scoped idempotency table/record with unique `(userId, key)` and canonical request hash plus review ID/expiry. Store a hash/key identifier, not submitted payload in a second location. Apply retention/expiry policy and handle concurrent unique-key races.
- **ReviewResult:** add unique `codeReviewId` if product guarantees one final result per review. Current one-to-many allows multiple results but no explicit retry/version semantics. If retaining many, add attempt/version and uniqueness on `(codeReviewId, attempt)` and define which is current. Add a database check for score range 0–100 (Prisma comment already notes intended custom SQL constraint) and nonnegative usage/duration where practical.
- **ReviewIssue:** indexes suited to access and ordering, e.g. `(reviewResultId, severity, id)`; add check constraints for positive line/column and `lineEnd >= lineStart` when values are present. Consider stable ordering or a source range uniqueness key only if duplicate normalization is required.
- **User:** existing ownership relation and cascading deletion fit account scoping. Decide whether deleting a user should erase source/results/jobs immediately; current cascade implies it does. Ensure worker claim queries handle deletion/cascade while a job is leased.
- Keep foreign keys and `onDelete` behavior intentional. Add enum/schema migrations only as a later implementation step; this design makes no schema edits.

## 8. Reliability, privacy, and security

### Initial implementation requirements

- Require existing authenticated session for all review endpoints; enforce per-user ownership at query time and hide foreign IDs as 404.
- Add a review submission rate limit, preferably per user with an IP-based fallback/abuse control. Auth's current DB-backed limiter pattern is reusable, but review quotas should reflect cost and should not silently reuse login thresholds.
- Enforce a route body cap and 256 KiB UTF-8 source cap, instruction limits, allowed language enum, and bounded metadata before DB writes. Align reverse proxy/gateway limits too.
- Same-origin/CSRF protection for cookie-authenticated POST (and any future mutating review action); CORS alone is not CSRF protection. Reuse established origin validation pattern or a shared helper after implementation.
- Persist review and job atomically. Use unique idempotency constraint and canonical payload hash; retry a unique-key race by reading existing record and comparing hash.
- Bounded automatic retries with exponential backoff and jitter for transient timeouts, provider 429/5xx, and selected network errors. Do not retry invalid input, unsupported language, or invalid structured output indefinitely. Mark terminal failures safely and support operational replay as an explicit later action.
- Keep external provider timeout shorter than lease duration or renew leases; use request/worker timeouts and cancellation signals. API returns promptly with `202` and does not wait for provider.
- Never log source, instructions, prompts, session cookies, raw provider responses, or credentials. Log review ID, user ID only if policy permits, state/attempt, provider, duration, and sanitized error category. Configure retention and access controls for source/results; treat submitted code as potentially proprietary and secret-bearing.
- Do not execute or clone repositories based on user-provided metadata. If repository import is added later, it needs SSRF controls, credential handling, and a separate threat review.
- Use typed safe errors and generic client responses; operational details stay in restricted logs. Do not return stack traces or raw Prisma/provider errors.

### Later enhancements

- Separate broker (e.g. managed queue) when DB polling/locking becomes a throughput or operational bottleneck.
- Per-provider circuit breaker, provider failover, cost budgets, tenant quotas, and model routing.
- Secret detection/redaction (with clear product tradeoffs), configurable source retention/deletion, encryption/key management beyond database-at-rest controls, and audit export.
- Cancel/re-run endpoints, webhook/event delivery, SSE/WebSocket status updates, and user-controlled issue status operations.
- Admin dead-letter/replay tooling, queue dashboards, worker autoscaling, and distributed tracing.

## 9. Error handling

Define typed domain errors such as `ReviewNotFound`, `InvalidReviewInput`, `IdempotencyConflict`, `ReviewNotReady`, `ReviewFailed`, `ReviewRateLimited`, and `ReviewStorageUnavailable`. Route adapters map them to the status table and existing envelope. Zod errors are converted to a stable generic validation response; avoid including submitted values. Prisma known errors are mapped narrowly (unique conflict, missing row, connectivity); unknown errors are logged and returned as generic `500`. If the initial transaction cannot commit, return `503`/`500` and do not return an accepted review ID. If the commit acknowledgment is ambiguous, idempotency key makes safe retry possible.

Worker failures differ from request failures: persist a classified failure/retry state, do not expose provider stack details to clients, and emit structured logs/metrics. A failed review remains retrievable as metadata with safe failure code; results endpoint returns `409 REVIEW_NOT_COMPLETED` or a documented failed-status envelope.

## 10. Testing strategy

Follow existing Vitest, Fastify `app.inject`, dependency-injection, and opt-in PostgreSQL integration conventions.

- Schema unit tests: allowed/unsupported languages, empty and whitespace-only source, UTF-8 byte boundary (including multibyte text), instruction/metadata bounds, strict unknown fields, malformed IDs/cursors.
- Route tests: auth required; status/error envelopes; 202 plus Location; body 413 before service/rate limiter; allowed sorting/pagination; processing and failed result semantics; no source leakage in list/ack responses.
- Ownership/IDOR tests for each route: own resource succeeds, another account's review/result/issue returns same 404 as missing; prove queries carry `userId` scope.
- Service tests: atomic review+job enqueue; same-key same-payload replay; same-key different-payload conflict; concurrent submission race; valid/invalid transitions; result/issues/status atomic completion; failure classification/backoff; lease-token stale worker rejection.
- PostgreSQL integration tests: concurrent idempotency-key inserts; transaction rollback when enqueue insert fails; worker double-claim exclusion; lease expiry recovery; conditional state update; cascade behavior. Keep using dedicated test DB safety checks.
- Provider contract tests with deterministic fake provider: schema-invalid output, oversized results, timeouts, retryable/permanent errors, and no raw response leakage. No live provider calls in routine tests.
- Operational tests: graceful worker shutdown, in-flight lease behavior, app/worker Prisma disconnect, and route-level maximum body size.

## 11. Implementation sequence

### Commit 3.4.8 — Review API and persistence foundation

1. Confirm product decisions: supported source-size limit, source/result retention, public status names, result visibility, and provider choice.
2. Design and review Prisma additions (job, idempotency, lifecycle metadata, result uniqueness/constraints); add migration and validate schema in that implementation milestone.
3. Add review Zod schemas, typed domain errors, service and narrow repository/queue interfaces; add tests first alongside implementation.
4. Register authenticated `POST /api/reviews`, `GET /api/reviews`, and `GET /api/reviews/{id}` with ownership-scoped queries, limits, cursor pagination, and idempotency.
5. Add DB-backed durable enqueue transaction; return 202 only after commit. Add submission rate limiting and safe error mapping.

### Commit 3.4.9 — Worker and provider boundary

1. Define provider-neutral input/output schema and deterministic fake implementation.
2. Add worker process entry, claim/lease/heartbeat/recovery behavior, bounded retries/backoff, and structured redacted logs.
3. Persist validated result/issues and final status atomically; integrate one selected AI provider behind adapter after secrets/config and privacy decisions are reviewed.
4. Add integration and worker failure-recovery tests.

### Commit 3.4.10 — Result retrieval and operations

1. Add result and issue routes with ownership constraints, not-ready/failure responses, and bounded pagination.
2. Add metrics/health visibility for queue depth, oldest job, failures, duration, and provider outcomes without source content.
3. Review quotas, retention/deletion, provider cost controls, deployment and rollback procedure; load-test before scaling worker concurrency.

Do not start Commit 3.4.8 or change code until the user explicitly approves the design.

## 12. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Source code contains credentials or proprietary material | Small request cap, strict access controls, no source logging, retention/deletion policy, restricted worker/provider access. |
| Queue row and review status diverge | Insert both in one transaction; conditional transitions; reconciliation for expired leases/stuck states. |
| Duplicate requests create duplicate provider spend | User-scoped idempotency key and canonical input hash; atomic unique constraint; bounded retries. |
| Worker crash leaves `PROCESSING` forever | Lease expiry, heartbeat, recovery scanner, attempt limits, alert on oldest processing job. |
| Stale worker overwrites a newer attempt | Lease token/attempt fencing checked in final transaction. |
| Provider returns malformed or hostile structured data | Strict Zod validation, bounds/check constraints, never treat output as executable or trusted instructions. |
| IDOR exposes code/results/issues | User scope in every query, nested-resource relational filter, same 404 behavior, adversarial tests. |
| Database polling competes with application load | Index eligible jobs, short claim transactions, bounded worker concurrency; move to broker only when justified. |
| Cookie-authenticated writes are vulnerable to CSRF | Same-origin check plus secure cookie policy; consider explicit CSRF tokens if deployment topology requires them. |
| `SUBMITTED`/`QUEUED` ambiguity creates invalid transitions | Choose one waiting-state name and centralize transition rules before implementation. |

## Files reviewed

`README.md`, `docs/architecture.md`, `backend/README.md`, `package.json`, `backend/package.json`, `backend/prisma/schema.prisma`, `backend/src/app.ts`, `backend/src/server.ts`, `backend/src/server-lifecycle.ts`, `backend/src/plugins/authentication.ts`, `backend/src/routes/auth.ts`, `backend/src/routes/health.ts`, `backend/src/security/auth/schemas.ts`, `backend/src/security/auth/service.ts`, `backend/src/security/session/service.ts`, `backend/src/config/env.ts`, `backend/src/config/runtime.ts`, and representative route, plugin, integration, config, and security tests under `backend/tests/` plus `backend/vitest.config.ts` and `backend/tsconfig.json`.
