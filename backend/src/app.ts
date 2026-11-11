import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { registerAuthentication, type AuthenticationDependencies } from "./plugins/authentication.js";
import { healthRoutes } from "./routes/health.js";
import "./config/env.js";
import env from "./config/env.js";

export type AppOptions = {
  frontendUrl?: string;
  authentication?: AuthenticationDependencies;
};

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  if (env.NODE_ENV === "production" && !options.authentication) {
    throw new Error("Authentication dependencies are required in production");
  }

  const app = Fastify({
    logger: true,
  });

  const frontendUrl = options.frontendUrl ?? env.FRONTEND_URL;

  await app.register(cors, {
    origin: frontendUrl,
    credentials: true,
  });

  await app.register(cookie);

  if (options.authentication) {
    // Register decorators on the root instance so subsequent route plugins inherit them.
    registerAuthentication(app, options.authentication);
  }

  await app.register(healthRoutes);

  return app;
}

