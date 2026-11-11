import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import { isIP } from "node:net";
import { parseRuntimeEnvironment, runtimeEnvironmentSchema } from "./runtime.js";

// Load environment variables from .env file with correct path resolution
const envFilePath = process.env.NODE_ENV === "test"
  ? path.resolve(__dirname, "../../..", ".env.test")  // Repository root: D:\AI - Code Reviewer\..\.env.test
  : path.resolve(__dirname, "../../..", ".env");    // Backend: D:\AI - Code Reviewer\..\..\backend\..\backend\.env = D:\AI - Code Reviewer\backend\.env

const envResult = dotenv.config({ path: envFilePath });

export const trustedProxyAddressesSchema = z.string().default("").transform((value) =>
  value.split(",").map((address) => address.trim()).filter(Boolean),
).refine((addresses) => addresses.every((address) => isIP(address) !== 0), {
  message: "TRUSTED_PROXY_ADDRESSES must contain comma-separated IP addresses",
});
export const rateLimitHmacSecretSchema = z.string().regex(/^(?:[0-9a-fA-F]{2}){32,}$/, {
  message: "RATE_LIMIT_HMAC_SECRET must be at least 32 bytes encoded as hexadecimal",
});

let runtimeEnvironment: ReturnType<typeof parseRuntimeEnvironment>;
try {
  runtimeEnvironment = parseRuntimeEnvironment(process.env.NODE_ENV);
} catch {
  console.error("❌ Invalid NODE_ENV; expected development, test, or production.");
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
      RATE_LIMIT_HMAC_SECRET: rateLimitHmacSecretSchema,
      TRUSTED_PROXY_ADDRESSES: trustedProxyAddressesSchema,
      HOST: z.string().default("0.0.0.0"),
    })
  : z.object({
      NODE_ENV: runtimeEnvironmentSchema,
      PORT: z.coerce.number().default(4000),
      HOST: z.string().default("0.0.0.0"),
      DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
      FRONTEND_URL: z.string().url().default("http://localhost:3000"),
      RATE_LIMIT_HMAC_SECRET: rateLimitHmacSecretSchema,
      TRUSTED_PROXY_ADDRESSES: trustedProxyAddressesSchema,
    });

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;
try {
  parsedEnv = envSchema.parse({ ...process.env, NODE_ENV: runtimeEnvironment });
} catch (error) {
  console.error("❌ Invalid environment variables; check configuration values without sharing secrets.");
  process.exit(1);
}
export default parsedEnv;
