export type SessionErrorCode =
  | 'INVALID_TOKEN'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_REVOKED'
  | 'DATABASE_ERROR';

export class SessionError extends Error {
  constructor(message: string, public readonly code: SessionErrorCode) {
    super(message);
    this.name = 'SessionError';
  }
}

export class SessionTokenError extends Error {
  constructor(message: string, public readonly code: 'GENERATION_FAILED') {
    super(message);
    this.name = 'SessionTokenError';
  }
}

export interface SessionTokenResult {
  token: string;
}

export interface PublicSession {
  id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  userAgent: string | null;
  ipHash: string | null;
}

export interface CreateSessionOptions {
  userAgent?: string;
  ipHash?: string;
  now?: Date;
}

