import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');

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