import { z } from 'zod';
import { DEFAULT_PASSWORD_POLICY } from '../password/types.js';

const emailSchema = z.string().trim().email().transform((email) => email.toLowerCase());
const passwordSchema = z.string();

export const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: emailSchema,
  password: passwordSchema
    .min(DEFAULT_PASSWORD_POLICY.minLength)
    .max(DEFAULT_PASSWORD_POLICY.maxLength),
}).strict();

export const loginSchema = z.object({
  email: emailSchema,
  // Short and over-policy passwords reach the service for generic auth handling.
  password: passwordSchema,
}).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
