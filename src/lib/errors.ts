import { ERROR_CODES, INVALID_CREDENTIALS_MESSAGE, type ErrorCode } from '../shared/index.ts';

/** An error with an HTTP status and a stable code, rendered as { message, code, details? }. */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validationError(details: unknown, message = 'Request validation failed'): AppError {
  return new AppError(400, ERROR_CODES.VALIDATION_ERROR, message, details);
}

export function unauthenticated(message = 'Sign in to continue'): AppError {
  return new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);
}

export function invalidCredentials(): AppError {
  return new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, INVALID_CREDENTIALS_MESSAGE);
}

export function forbidden(message = 'You do not have permission to do this'): AppError {
  return new AppError(403, ERROR_CODES.FORBIDDEN, message);
}

export function notFound(message = 'Not found', code: ErrorCode = ERROR_CODES.NOT_FOUND): AppError {
  return new AppError(404, code, message);
}

export function conflict(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(409, code, message, details);
}

export function unprocessable(code: ErrorCode, message: string, details?: unknown): AppError {
  return new AppError(422, code, message, details);
}
