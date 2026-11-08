import type { PrismaClient } from '@prisma/client';
import { generateSessionToken } from './generate.js';
import { hashToken } from '../token/hash.js';
import {
  SessionError,
  type CreateSessionOptions,
  type PublicSession,
} from './types.js';

const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const sessionSelect = {
  id: true,
  userId: true,
  expiresAt: true,
  createdAt: true,
  lastSeenAt: true,
  revokedAt: true,
  userAgent: true,
  ipHash: true,
} as const;

type SessionClient = Pick<PrismaClient, 'session'>;

function validateRawToken(rawToken: string): void {
  if (typeof rawToken !== 'string' || rawToken.length === 0) {
    throw new SessionError('Invalid session token', 'INVALID_TOKEN');
  }
}

function databaseError(): SessionError {
  return new SessionError('Session operation failed', 'DATABASE_ERROR');
}

export class SessionService {
  constructor(private readonly prisma: SessionClient) {}

  async createSession(
    userId: string,
    options: CreateSessionOptions = {},
  ): Promise<{ token: string; session: PublicSession }> {
    const now = options.now ?? new Date();
    const { token } = generateSessionToken();
    const { hash } = hashToken(token);

    try {
      const session = await this.prisma.session.create({
        data: {
          userId,
          tokenHash: hash,
          expiresAt: new Date(now.getTime() + SESSION_LIFETIME_MS),
          ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
          ...(options.ipHash === undefined ? {} : { ipHash: options.ipHash }),
        },
        select: sessionSelect,
      });

      return { token, session: session as PublicSession };
    } catch {
      throw databaseError();
    }
  }

  async validateSession(rawToken: string, now = new Date()): Promise<PublicSession> {
    validateRawToken(rawToken);

    let session: PublicSession | null;
    try {
      session = await this.prisma.session.findUnique({
        where: { tokenHash: hashToken(rawToken).hash },
        select: sessionSelect,
      }) as PublicSession | null;
    } catch {
      throw databaseError();
    }

    if (!session) {
      throw new SessionError('Session not found', 'SESSION_NOT_FOUND');
    }
    if (session.revokedAt !== null) {
      throw new SessionError('Session has been revoked', 'SESSION_REVOKED');
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      throw new SessionError('Session has expired', 'SESSION_EXPIRED');
    }

    return session;
  }

  async revokeSession(rawToken: string, revokedAt = new Date()): Promise<void> {
    validateRawToken(rawToken);

    try {
      const result = await this.prisma.session.updateMany({
        where: { tokenHash: hashToken(rawToken).hash, revokedAt: null },
        data: { revokedAt },
      });

      if (result.count === 0) {
        const existingSession = await this.prisma.session.findUnique({
          where: { tokenHash: hashToken(rawToken).hash },
          select: { revokedAt: true },
        });

        if (existingSession !== null && existingSession.revokedAt !== null) {
          throw new SessionError('Session has already been revoked', 'SESSION_REVOKED');
        }
        throw new SessionError('Session not found', 'SESSION_NOT_FOUND');
      }
    } catch (error) {
      if (error instanceof SessionError) {
        throw error;
      }
      throw databaseError();
    }
  }

  async revokeAllSessions(userId: string, revokedAt = new Date()): Promise<number> {
    try {
      const result = await this.prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt },
      });
      return result.count;
    } catch {
      throw databaseError();
    }
  }
}

export { SESSION_LIFETIME_MS };

