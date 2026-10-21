import type { z } from 'zod';
import { documentRoute, errorResponses } from '../../lib/openapi.ts';

const json = (schema: z.ZodType) => ({ content: { 'application/json': { schema } } });

export interface EbRouteDoc {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  summary: string;
  permission: string;
  query?: z.ZodType;
  body?: z.ZodType;
  response?: z.ZodType;
  status?: number;
  file?: boolean;
  upload?: string;
}

/** Documents one Employee Benefits or family plan route in the OpenAPI document. */
export function documentEbRoute(item: EbRouteDoc, tag = 'Employee benefits'): void {
  const ok = item.status ?? 200;
  documentRoute({
    method: item.method,
    path: item.path,
    tags: [tag],
    summary: item.summary,
    description: `Needs ${item.permission}.`,
    request: {
      ...(item.query ? { query: item.query as z.ZodObject } : {}),
      ...(item.body ? { body: json(item.body) } : {}),
      ...(item.upload
        ? { body: { content: { [item.upload]: { schema: { type: 'string', format: 'binary' } } } } }
        : {}),
    },
    responses: {
      [ok]: item.file
        ? {
            description: 'The file',
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          }
        : item.response
          ? { description: 'OK', ...json(item.response) }
          : { description: 'Done' },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  });
}
