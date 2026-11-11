import { z } from 'zod';

export const SOURCE_CODE_MAX_BYTES = 256 * 1024;
export const REVIEW_INSTRUCTIONS_MAX_LENGTH = 4 * 1024;
export const REVIEW_METADATA_MAX_LENGTH = 512;
export const REVIEW_PAGE_DEFAULT_LIMIT = 20;
export const REVIEW_PAGE_MAX_LIMIT = 100;

export const programmingLanguageSchema = z.enum([
  'TYPESCRIPT', 'JAVASCRIPT', 'PYTHON', 'JAVA', 'CPP', 'CSHARP', 'GO', 'RUST',
  'RUBY', 'PHP', 'SWIFT', 'KOTLIN', 'R', 'MATLAB', 'SCALA', 'HASKELL', 'ELM',
  'OCAML', 'PERL', 'LUA', 'DART',
]);

const boundedMetadata = z.string().trim().min(1).max(REVIEW_METADATA_MAX_LENGTH);

export const createReviewSchema = z.object({
  sourceCode: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: 'Source code cannot be empty',
  }),
  programmingLanguage: programmingLanguageSchema,
  instructions: z.string().trim().max(REVIEW_INSTRUCTIONS_MAX_LENGTH).optional(),
  repository: boundedMetadata.optional(),
  branch: boundedMetadata.optional(),
  commitHash: boundedMetadata.optional(),
}).strict();

export const reviewIdSchema = z.object({
  reviewId: z.string().uuid(),
}).strict();

export const issueParamsSchema = z.object({
  reviewId: z.string().uuid(),
  issueId: z.string().uuid(),
}).strict();

export const listReviewsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(REVIEW_PAGE_MAX_LIMIT).default(REVIEW_PAGE_DEFAULT_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
  sort: z.enum(['createdAt']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  status: z.enum(['PENDING', 'SUBMITTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED']).optional(),
}).strict();

export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
