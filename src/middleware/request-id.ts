import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const ACCEPTED_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Gives every request an id. A well-formed incoming X-Request-Id (for example from the
 * web app's proxy) is kept so a request can be traced across both apps.
 */
export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && ACCEPTED_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    next();
  };
}
