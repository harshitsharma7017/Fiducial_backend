import type { RequestHandler } from 'express';
import { notFound as notFoundError } from '../lib/errors.ts';

export function notFound(): RequestHandler {
  return (req) => {
    throw notFoundError(`No route for ${req.method} ${req.path}`);
  };
}
