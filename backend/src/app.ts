import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";

export type AppOptions = {
  frontendUrl?: string;
};

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  const frontendUrl = options.frontendUrl ?? process.env.FRONTEND_URL ?? "http://localhost:3000";

  await app.register(cors, {
    origin: frontendUrl,
  });

  await app.register(healthRoutes);

  return app;
}
