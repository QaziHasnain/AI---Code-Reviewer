import "./config/env.js";
import env from "./config/env.js";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { SessionService } from "./security/session/index.js";
import { startServer } from "./server-lifecycle.js";
import { AuthService } from "./security/auth/index.js";
import { createHash } from "node:crypto";

const port = Number(env.PORT);
const host = env.HOST;

async function start(): Promise<void> {
  const prisma = new PrismaClient();
  const sessions = new SessionService(prisma);
  const auth = new AuthService({ prisma, sessions });
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
        rateLimits: {
          increment: async (key, expiresAt) => {
            await prisma.authRateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
            const bucketKey = createHash('sha256').update(key).digest('hex');
            const bucket = await prisma.authRateLimitBucket.upsert({
              where: { key: bucketKey }, create: { key: bucketKey, count: 1, expiresAt },
              update: { count: { increment: 1 } }, select: { count: true },
            });
            return bucket.count;
          },
        },
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
