import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { healthRoutes } from "./routes/health.js";
import "./config/env.js";
import env from "./config/env.js";

export type AppOptions = {
  frontendUrl?: string;
};

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  const frontendUrl = options.frontendUrl ?? env.FRONTEND_URL;

  await app.register(cors, {
    origin: frontendUrl,
  });

  await app.register(healthRoutes);

  return app;
}

