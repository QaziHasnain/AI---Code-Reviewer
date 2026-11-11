import type { PrismaClient } from '@prisma/client';

/** Must be called before any test database read that could mutate, cleanup, or delete data. */
export async function assertDedicatedTestDatabase(prisma: PrismaClient): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ current_database: string }>>`SELECT current_database()`;
  if (rows[0]?.current_database !== 'AI_Code_Reviewer_test') {
    throw new Error(`Refusing PostgreSQL integration test: expected AI_Code_Reviewer_test, connected to ${rows[0]?.current_database ?? 'unknown database'}`);
  }
}
