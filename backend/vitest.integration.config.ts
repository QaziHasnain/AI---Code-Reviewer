import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const testEnvPath = resolve(root, '..', '.env.test');
const parsedTestEnv = dotenv.parse(readFileSync(testEnvPath));

if (parsedTestEnv.DATABASE_URL) {
  throw new Error('Refusing integration tests: .env.test must not define DATABASE_URL');
}
if (!parsedTestEnv.TEST_DATABASE_URL) {
  throw new Error('Refusing integration tests: TEST_DATABASE_URL is required in .env.test');
}

// Vitest evaluates this config before loading setup files or worker modules.
// Establish the test environment here so no application module can initialize
// while the development environment is still present.
delete process.env.DATABASE_URL;
delete process.env.TEST_DATABASE_URL;
for (const [key, value] of Object.entries(parsedTestEnv)) {
  process.env[key] = value;
}
process.env.NODE_ENV = 'test';

// Block Prisma's generated-client dotenv lookup from loading backend/.env
// before the setup file runs. The sentinel is intentionally falsy and is not
// used as a datasource; tests must use TEST_DATABASE_URL explicitly.
process.env.DATABASE_URL = '';

if (process.env.DATABASE_URL) {
  throw new Error('Refusing integration tests: development DATABASE_URL is present');
}

export default defineConfig({
  root,
  test: {
    root,
    environment: 'node',
    include: ['tests/**/*.integration.test.ts'],
    setupFiles: ['vitest.setup.ts'],
  },
  resolve: { alias: { '@': resolve(root, 'src') } },
});
