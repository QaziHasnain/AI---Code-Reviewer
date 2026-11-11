import type { PublicSession } from '../session/types.js';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface AuthenticatedSession {
  token: string;
  session: PublicSession;
}

export interface AuthResult {
  user: PublicUser;
  session: AuthenticatedSession;
}

export type AuthErrorCode = 'INVALID_INPUT' | 'EMAIL_ALREADY_EXISTS' | 'AUTHENTICATION_FAILED' | 'OPERATION_FAILED';

export class AuthError extends Error {
  constructor(message: string, public readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

export const AUTHENTICATION_FAILED_MESSAGE = 'Invalid email or password';
