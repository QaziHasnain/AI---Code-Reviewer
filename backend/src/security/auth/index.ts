export { AuthService } from './service.js';
export { loginSchema, registerSchema, type LoginInput, type RegisterInput } from './schemas.js';
export {
  buildSessionCookieOptions,
  clearSessionCookie,
  getSessionCookieName,
  isProductionEnvironment,
  setSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from './cookie.js';
export {
  AUTHENTICATION_FAILED_MESSAGE,
  AuthError,
  type AuthErrorCode,
  type AuthResult,
  type AuthenticatedSession,
  type PublicUser,
} from './types.js';
