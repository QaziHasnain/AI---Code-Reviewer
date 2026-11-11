import type { PrismaClient } from '@prisma/client';
import { hashPassword, verifyPassword } from '../password/index.js';
import { DEFAULT_PASSWORD_POLICY } from '../password/types.js';
import type { PublicSession } from '../session/types.js';
import {
  AUTHENTICATION_FAILED_MESSAGE,
  AuthError,
  type AuthResult,
  type PublicUser,
} from './types.js';

const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=4$6sbOtDG/TYpVhfGY8URI8A$asQm1jwPTWx4VvOckM5YRFWzmKj/5AsjGbQC5+ePAp8';
const publicUserSelect = { id: true, name: true, email: true, createdAt: true } as const;
const loginUserSelect = { ...publicUserSelect, passwordHash: true } as const;

type UserForLogin = PublicUser & { passwordHash: string };
type UserDelegate = Pick<PrismaClient['user'], 'create' | 'findUnique'>;
type SessionCreator = {
  createSession(userId: string): Promise<{ token: string; session: PublicSession }>;
};

export interface AuthServiceDependencies {
  prisma: { user: UserDelegate };
  sessions: SessionCreator;
  hashPassword?: typeof hashPassword;
  verifyPassword?: typeof verifyPassword;
}

function operationFailed(): AuthError {
  return new AuthError('Authentication operation failed', 'OPERATION_FAILED');
}

function isUniqueEmailError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export class AuthService {
  private readonly hash: typeof hashPassword;
  private readonly verify: typeof verifyPassword;

  constructor(private readonly dependencies: AuthServiceDependencies) {
    this.hash = dependencies.hashPassword ?? hashPassword;
    this.verify = dependencies.verifyPassword ?? verifyPassword;
  }

  async register(input: { name: string; email: string; password: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    let passwordHash: string;
    try {
      passwordHash = (await this.hash(input.password)).hash;
    } catch {
      throw new AuthError('Invalid registration details', 'INVALID_INPUT');
    }

    let user: PublicUser;
    try {
      user = await this.dependencies.prisma.user.create({
        data: { name: input.name, email, passwordHash },
        select: publicUserSelect,
      }) as PublicUser;
    } catch (error) {
      if (isUniqueEmailError(error)) {
        throw new AuthError('An account with this email already exists', 'EMAIL_ALREADY_EXISTS');
      }
      throw operationFailed();
    }

    try {
      const session = await this.dependencies.sessions.createSession(user.id);
      return { user, session };
    } catch {
      throw operationFailed();
    }
  }

  async login(input: { email: string; password: string }): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    let user: UserForLogin | null;
    try {
      user = await this.dependencies.prisma.user.findUnique({
        where: { email },
        select: loginUserSelect,
      }) as UserForLogin | null;
    } catch {
      throw operationFailed();
    }

    const passwordWithinPolicy = input.password.length >= DEFAULT_PASSWORD_POLICY.minLength
      && input.password.length <= DEFAULT_PASSWORD_POLICY.maxLength;

    if (!user || !passwordWithinPolicy) {
      await this.performDummyVerification();
      throw new AuthError(AUTHENTICATION_FAILED_MESSAGE, 'AUTHENTICATION_FAILED');
    }

    let verification: { valid: boolean };
    try {
      verification = await this.verify(input.password, user.passwordHash);
    } catch {
      // A malformed stored hash still receives a dummy Argon2 verification.
      await this.performDummyVerification();
      throw new AuthError(AUTHENTICATION_FAILED_MESSAGE, 'AUTHENTICATION_FAILED');
    }
    if (!verification.valid) {
      throw new AuthError(AUTHENTICATION_FAILED_MESSAGE, 'AUTHENTICATION_FAILED');
    }

    const { passwordHash: _passwordHash, ...publicUser } = user;
    try {
      const session = await this.dependencies.sessions.createSession(user.id);
      return { user: publicUser, session };
    } catch {
      throw operationFailed();
    }
  }

  private async performDummyVerification(): Promise<void> {
    try {
      await this.verify('codex-dummy-auth-password', DUMMY_PASSWORD_HASH);
    } catch {
      // Authentication still fails generically if the dummy verification fails.
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
