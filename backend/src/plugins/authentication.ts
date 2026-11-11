import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { getSessionCookieName } from '../security/auth/cookie.js';
import type { PublicUser } from '../security/auth/types.js';
import { SessionError, type PublicSession } from '../security/session/index.js';

export interface AuthContext {
  userId: string;
  user: PublicUser;
  sessionId: string;
}

export interface AuthenticationDependencies {
  prisma: {
    user: {
      findUnique(args: {
        where: { id: string };
        select: { id: true; name: true; email: true; createdAt: true };
      }): Promise<PublicUser | null>;
    };
  };
  sessions: {
    validateSession(token: string): Promise<PublicSession>;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }

  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
  }
}

function sendUnauthenticated(reply: FastifyReply): FastifyReply {
  return reply.code(401).send({
    error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
  });
}

function sendServiceUnavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: { code: 'SERVICE_UNAVAILABLE', message: 'Authentication service unavailable' },
  });
}

function sendInternalError(reply: FastifyReply): FastifyReply {
  return reply.code(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}

export function registerAuthentication(
  app: FastifyInstance,
  dependencies: AuthenticationDependencies,
): void {
  app.decorateRequest('auth', null);

  const requireAuth: preHandlerHookHandler = async (request, reply) => {
    const token = request.cookies[getSessionCookieName()];
    if (typeof token !== 'string' || token.length === 0) {
      sendUnauthenticated(reply);
      return;
    }

    let session;
    try {
      session = await dependencies.sessions.validateSession(token);
    } catch (error) {
      if (error instanceof SessionError) {
        if (error.code === 'DATABASE_ERROR') {
          sendServiceUnavailable(reply);
          return;
        }
        if (
          error.code === 'INVALID_TOKEN'
          || error.code === 'SESSION_NOT_FOUND'
          || error.code === 'SESSION_EXPIRED'
          || error.code === 'SESSION_REVOKED'
        ) {
          sendUnauthenticated(reply);
          return;
        }
      }
      sendInternalError(reply);
      return;
    }

    let databaseUser;
    try {
      databaseUser = await dependencies.prisma.user.findUnique({
        where: { id: session.userId },
        select: { id: true, name: true, email: true, createdAt: true },
      });
    } catch {
      sendServiceUnavailable(reply);
      return;
    }

    if (!databaseUser) {
      sendUnauthenticated(reply);
      return;
    }

    const user: PublicUser = {
      id: databaseUser.id,
      name: databaseUser.name,
      email: databaseUser.email,
      createdAt: databaseUser.createdAt,
    };
    request.auth = { userId: user.id, user, sessionId: session.id };
  };

  app.decorate('requireAuth', requireAuth);
}
