import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { registerAuthentication, type AuthenticationDependencies } from "./plugins/authentication.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes, type AuthRouteDependencies } from "./routes/auth.js";
import { reviewRoutes, type ReviewRouteDependencies } from "./routes/reviews.js";
import "./config/env.js";
import env from "./config/env.js";

export type AppOptions = {
  frontendUrl?: string;
  trustedProxyAddresses?: string[];
  authentication?: AuthenticationDependencies;
  authRoutes?: AuthRouteDependencies;
  reviewRoutes?: ReviewRouteDependencies;
};

export async function buildApp(options: AppOptions = {}): Promise<FastifyInstance> {
  if (env.NODE_ENV === "production" && !options.authentication) {
    throw new Error("Authentication dependencies are required in production");
  }

  const app = Fastify({
    logger: true,
    trustProxy: options.trustedProxyAddresses ?? env.TRUSTED_PROXY_ADDRESSES,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'REQUEST_TOO_LARGE', message: 'Request body exceeds the maximum size' } });
    }
    sendSafeError(error, reply);
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
  if (options.authRoutes) await app.register(authRoutes, options.authRoutes);
  if (options.reviewRoutes) await app.register(reviewRoutes, options.reviewRoutes);

  return app;
}

function sendSafeError(error: unknown, reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }): unknown {
  if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 400) {
    return reply.code(400).send({ error: { code: 'INVALID_INPUT', message: 'Invalid request' } });
  }
  return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}

