We are starting AI Code Reviewer — Commit 2.2: Prisma Schema Implementation.

The Architect has completed and we have approved Commit 2.1 (Database Schema Design).

Prisma Client v6.19.3 has already been generated successfully.

Your first responsibility is to inspect the current repository and report its state.

Check:
1. Current prisma/schema.prisma implementation.
2. All four models and their relationships.
3. UUID fields and foreign keys.
4. All required enums.
5. Default values and cascade deletion.
6. Three required indexes.
7. Whether Prisma Client generation is working.

Then run:
- npx prisma validate
- npm run typecheck
- npm test
- npm run build

Do not modify files yet.

Do not generate migrations.
Do not create database tables.
Do not change existing functionality.

Return your inspection findings, command results and any problems discovered.

Wait for my approval before making implementation changes.