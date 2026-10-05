import { ERROR_CODES, type ApiErrorBody } from '../shared/index.ts';
import type { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { AppError } from '../lib/errors.ts';

interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
}

/** Errors raised by express.json() carry a `type` such as "entity.parse.failed". */
function bodyParserErrorType(error: unknown): string | null {
  if (error instanceof Error && 'type' in error && typeof error.type === 'string')
    return error.type;
  return null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return error instanceof mongoose.mongo.MongoServerError && error.code === 11000;
}

function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AppError) {
    const body: ApiErrorBody = { message: error.message, code: error.code };
    if (error.details !== undefined) body.details = error.details;
    return { status: error.status, body };
  }

  switch (bodyParserErrorType(error)) {
    case 'entity.parse.failed':
      return {
        status: 400,
        body: { message: 'The request body is not valid JSON', code: ERROR_CODES.INVALID_JSON },
      };
    case 'entity.too.large':
      return {
        status: 413,
        body: { message: 'The request body is too large', code: ERROR_CODES.PAYLOAD_TOO_LARGE },
      };
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return {
        status: 415,
        body: {
          message: 'The request encoding is not supported',
          code: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        },
      };
    default:
      break;
  }

  if (isDuplicateKeyError(error)) {
    return {
      status: 409,
      body: {
        message: 'A record with the same unique value already exists',
        code: ERROR_CODES.CONFLICT,
      },
    };
  }

  return {
    status: 500,
    body: { message: 'Something went wrong. Please try again.', code: ERROR_CODES.INTERNAL_ERROR },
  };
}

/** Renders every error as { message, code, details? }. Internal details are only logged. */
export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, next) => {
    const { status, body } = toErrorResponse(error);
    if (status >= 500) req.log.error({ err: error }, 'Request failed');
    if (res.headersSent) {
      next(error);
      return;
    }
    res.status(status).json(body);
  };
}
