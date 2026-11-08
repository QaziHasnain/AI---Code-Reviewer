import { z } from "zod";
import * as dotenv from "dotenv";

// Load environment variables from .env file
const envFilePath = process.env.NODE_ENV === "test"
  ? ".env.test"
  : ".env";

const envResult = dotenv.config({ path: envFilePath });

if (envResult.error) {
  // For development, allow .env to be missing; for test, require it
  if (process.env.NODE_ENV === "test") {
    throw new Error(`Missing .env.test file: ${envResult.error.message}`);
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  FRONTEND_URL: z.string().url().default("http://localhost:3000"),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;
try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  console.error("❌ Invalid environment variables:", error);
  process.exit(1);
}
export default parsedEnv;
