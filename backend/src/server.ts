import "./config/env.js";
import env from "./config/env.js";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { SessionService } from "./security/session/index.js";
import { startServer } from "./server-lifecycle.js";
import { AuthService } from "./security/auth/index.js";
import { PersistentAuthRateLimitStore } from "./security/auth/rate-limit-store.js";
import { ReviewService } from "./reviews/service.js";

const port = Number(env.PORT);
const host = env.HOST;

async function start(): Promise<void> {
  const prisma = new PrismaClient();
  const sessions = new SessionService(prisma);
  const auth = new AuthService({ prisma, sessions });
  const rateLimitStore = new PersistentAuthRateLimitStore(prisma.authRateLimitBucket);
  const reviews = new ReviewService(prisma);
  await startServer({
    createApp: () => buildApp({
      frontendUrl: env.FRONTEND_URL,
      trustedProxyAddresses: env.TRUSTED_PROXY_ADDRESSES,
      authentication: { prisma, sessions },
      authRoutes: {
        auth,
        sessions,
        frontendUrl: env.FRONTEND_URL,
        rateLimitHmacSecret: env.RATE_LIMIT_HMAC_SECRET,
        rateLimits: rateLimitStore,
      },
      reviewRoutes: {
        reviews,
        frontendUrl: env.FRONTEND_URL,
        rateLimitHmacSecret: env.RATE_LIMIT_HMAC_SECRET,
        rateLimits: rateLimitStore,
      },
    }),
    disconnectPrisma: () => prisma.$disconnect(),
    listenOptions: { port, host },
  });
}

void start().catch((error: unknown) => {
  console.error("Failed to start server", error);
  process.exitCode = 1;
});
