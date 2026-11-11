import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

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
