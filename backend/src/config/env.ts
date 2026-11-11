import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { parseRuntimeEnvironment, runtimeEnvironmentSchema } from "./runtime.js";

// Load environment variables from .env file with correct path resolution
const envFilePath = process.env.NODE_ENV === "test"
  ? path.resolve(__dirname, "../../..", ".env.test")  // Repository root: D:\AI - Code Reviewer\..\.env.test
  : path.resolve(__dirname, "../../..", ".env");    // Backend: D:\AI - Code Reviewer\..\..\backend\..\backend\.env = D:\AI - Code Reviewer\backend\.env

const envResult = dotenv.config({ path: envFilePath });

let runtimeEnvironment: ReturnType<typeof parseRuntimeEnvironment>;
try {
  runtimeEnvironment = parseRuntimeEnvironment(process.env.NODE_ENV);
} catch (error) {
  console.error("❌ Invalid NODE_ENV; expected development, test, or production:", error);
  process.exit(1);
}

if (envResult.error) {
  // For development, allow .env to be missing; for test, require it
  if (process.env.NODE_ENV === "test") {
    throw new Error(`Missing .env.test file: ${envResult.error.message}`);
  }
}

// For test environment, prioritize TEST_DATABASE_URL and reject development DATABASE_URL
if (runtimeEnvironment === "test") {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL is required in test environment");
  }
  if (process.env.DATABASE_URL) {
    throw new Error("Development DATABASE_URL should not be used in test environment");
  }
}

// Create schema that handles test vs development differently
const envSchema = runtimeEnvironment === "test"
  ? z.object({
      NODE_ENV: runtimeEnvironmentSchema,
      PORT: z.coerce.number().default(4000),
      FRONTEND_URL: z.string().url().default("http://localhost:3000"),
      TEST_DATABASE_URL: z.string().min(1, "TEST_DATABASE_URL is required"),
      HOST: z.string().default("0.0.0.0"),
    })
  : z.object({
      NODE_ENV: runtimeEnvironmentSchema,
      PORT: z.coerce.number().default(4000),
      HOST: z.string().default("0.0.0.0"),
      DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
      FRONTEND_URL: z.string().url().default("http://localhost:3000"),
    });

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;
try {
  parsedEnv = envSchema.parse({ ...process.env, NODE_ENV: runtimeEnvironment });
} catch (error) {
  console.error("❌ Invalid environment variables:", error);
  process.exit(1);
}
export default parsedEnv;
