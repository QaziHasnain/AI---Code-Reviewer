import "./config/env.js";
import env from "./config/env.js";
import { PrismaClient } from "@prisma/client";
import { buildApp } from "./app.js";
import { SessionService } from "./security/session/index.js";
import { startServer } from "./server-lifecycle.js";

const port = Number(env.PORT);
const host = env.HOST;

async function start(): Promise<void> {
  const prisma = new PrismaClient();
  const sessions = new SessionService(prisma);
  await startServer({
    createApp: () => buildApp({
      frontendUrl: env.FRONTEND_URL,
      authentication: { prisma, sessions },
    }),
    disconnectPrisma: () => prisma.$disconnect(),
    listenOptions: { port, host },
  });
}

void start().catch((error: unknown) => {
  console.error("Failed to start server", error);
  process.exitCode = 1;
});
