import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { validationError } from '../lib/errors.ts';

export interface RequestSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

type Output<T, Fallback> = T extends z.ZodType ? z.output<T> : Fallback;

export interface ValidatedInput<S extends RequestSchemas> {
  params: Output<S['params'], Record<string, never>>;
  query: Output<S['query'], Record<string, never>>;
  body: Output<S['body'], undefined>;
}

export interface ValidationIssue {
  location: 'params' | 'query' | 'body';
  path: string;
  message: string;
}

// Inputs a route does not declare must be empty: unknown query keys or a stray body are rejected.
const NO_PARAMS = z.strictObject({});
const NO_QUERY = z.strictObject({});
const NO_BODY = z.union([z.undefined(), z.strictObject({})]);

const LOCATIONS = ['params', 'query', 'body'] as const;

export function formatZodIssues(
  error: z.ZodError,
  location: ValidationIssue['location'],
): ValidationIssue[] {
  return error.issues.map((issue) => ({
    location,
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/**
 * Parses params, query and body with strict Zod schemas and returns the typed result.
 * Handlers only ever see parsed values, never raw req.body or req.query, so request input
 * cannot smuggle MongoDB operators into a filter.
 */
export function parseRequest<S extends RequestSchemas>(
  schemas: S,
  req: Request,
): ValidatedInput<S> {
  const issues: ValidationIssue[] = [];
  const output: Record<string, unknown> = {};

  for (const location of LOCATIONS) {
    const declared = schemas[location];
    let schema: z.ZodType;
    let raw: unknown;
    if (location === 'params') {
      schema = declared ?? NO_PARAMS;
      raw = req.params;
    } else if (location === 'query') {
      schema = declared ?? NO_QUERY;
      raw = req.query;
    } else {
      schema = declared ?? NO_BODY;
      // A declared body with nothing sent is validated as {} so the client gets field errors.
      raw = declared ? ((req.body as unknown) ?? {}) : (req.body as unknown);
    }
    const result = schema.safeParse(raw);
    if (result.success) output[location] = result.data;
    else issues.push(...formatZodIssues(result.error, location));
  }

  if (issues.length > 0) throw validationError(issues);
  return output as unknown as ValidatedInput<S>;
}

/** Middleware form of parseRequest; the parsed input is stored on res.locals.input. */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    res.locals.input = parseRequest(schemas, req);
    next();
  };
}

/**
 * Builds a route handler that validates its input first. Express 5 forwards rejected
 * promises to the error handler, so handlers can simply throw.
 */
export function route<S extends RequestSchemas>(
  schemas: S,
  handler: (input: ValidatedInput<S>, req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return async (req, res) => {
    const input = parseRequest(schemas, req);
    await handler(input, req, res);
  };
}
