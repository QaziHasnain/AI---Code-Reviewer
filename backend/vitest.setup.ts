import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const testEnvPath = resolve(__dirname, '..', '.env.test');

// Load the dedicated test environment before any application module is imported.
// This makes the test file authoritative and prevents backend/.env from being
// loaded by src/config/env.ts during worker initialization.
process.env.NODE_ENV = 'test';
delete process.env.DATABASE_URL;
delete process.env.TEST_DATABASE_URL;
const loadedTestEnv = dotenv.config({ path: testEnvPath, override: true });
if (loadedTestEnv.error) {
  throw new Error(`Missing .env.test file: ${loadedTestEnv.error.message}`);
}

// Prisma's generated client loads backend/.env during module import. Keep a
// falsy sentinel so that import cannot repopulate the development URL; all
// integration clients receive TEST_DATABASE_URL through an explicit datasource.
process.env.DATABASE_URL = '';
if (process.env.DATABASE_URL) {
  throw new Error('Development DATABASE_URL must not be present in test environment');
}
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL is required in test environment');
}

// Tests use the dedicated TEST_DATABASE_URL contract and must never inherit a
// developer or deployment DATABASE_URL from the shell running Vitest.

// Configure path aliases for tests
export const testAliases = {
  '@/security/password/index': resolve(__dirname, 'src/security/password/index.ts'),
  '@/security/password/hash': resolve(__dirname, 'src/security/password/hash.ts'),
  '@/security/password/verify': resolve(__dirname, 'src/security/password/verify.ts'),
  '@/security/password/types': resolve(__dirname, 'src/security/password/types.ts'),
  '@/security/password': resolve(__dirname, 'src/security/password'),
};

// Configure path aliases for Vitest
export function setupVitestPathAliases() {
  // This function would be called in a Vitest setup hook
  // but Vitest doesn't have a direct way to configure path aliases
  // So we need to use a different approach
}
