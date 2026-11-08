import "./config/env.js";
import env from "./config/env.js";
import { buildApp } from "./app.js";

const port = Number(env.PORT);
const host = env.HOST;

async function start(): Promise<void> {
  const app = await buildApp({ frontendUrl: env.FRONTEND_URL });

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

void start();
