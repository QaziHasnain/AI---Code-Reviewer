import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

const envPath = resolve(process.cwd(), '..', '.env.test');
const parsedEnv = dotenv.parse(readFileSync(envPath));
if (parsedEnv.DATABASE_URL) throw new Error('Refusing PostgreSQL integration tests: .env.test must define TEST_DATABASE_URL only.');
delete process.env.DATABASE_URL;
const loaded = dotenv.config({ path: envPath, override: false });
if (loaded.error) throw new Error(`Unable to load required .env.test at ${envPath}: ${loaded.error.message}`);
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required in .env.test.');

const prisma = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
try {
  const rows = await prisma.$queryRaw`SELECT current_database()`;
  const database = rows[0]?.current_database;
  if (database !== 'AI_Code_Reviewer_test') {
    throw new Error(`Refusing PostgreSQL integration tests: expected AI_Code_Reviewer_test, connected to ${database ?? 'unknown database'}.`);
  }
  console.log(`PostgreSQL integration preflight passed: ${database}`);
} catch (error) {
  console.error(`PostgreSQL integration preflight failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
if (process.exitCode) process.exit(process.exitCode);

const testEnv = { ...process.env, NODE_ENV: 'test', RUN_SESSION_DB_INTEGRATION_TESTS: 'true' };
delete testEnv.DATABASE_URL;
const vitestCli = resolve(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs');
if (!existsSync(vitestCli)) {
  console.error(`Unable to launch PostgreSQL integration tests: local Vitest CLI not found at ${vitestCli}.`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [
  vitestCli, 'run', '--config', 'vitest.integration.config.ts',
], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: testEnv,
});
if (result.error) {
  console.error(`Unable to launch PostgreSQL integration tests: ${result.error.message}`);
  if (result.error.code) console.error(`Process launch error code: ${result.error.code}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`PostgreSQL integration tests were terminated by signal ${result.signal}.`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`Vitest exited with status ${result.status ?? 'unknown'}.`);
}
process.exit(result.status ?? 1);
