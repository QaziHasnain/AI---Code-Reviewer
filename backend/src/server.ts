import "dotenv/config";
import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? 4000);
const host = "0.0.0.0";

async function start(): Promise<void> {
  const app = await buildApp();

  try {
    await app.listen({ port, host });
  } catch (error) {
    app.log.error(error, "Failed to start server");
    process.exit(1);
  }
}

void start();
