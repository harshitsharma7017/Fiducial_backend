import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from '@asteasolutions/zod-to-openapi';
import { ApiErrorSchema } from '../shared/index.ts';
import { API_VERSION } from '../config/version.ts';

/**
 * One registry for the whole API. Each module documents its routes next to their definitions
 * with documentRoute(), and the document is generated from the same Zod schemas that validate.
 *
 * Schemas are inlined rather than registered as named components: registry.register() needs
 * extendZodWithOpenApi() to run before any schema is created, and src/shared builds its
 * schemas at import time.
 */
export const registry = new OpenAPIRegistry();

export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'Access token returned by POST /api/v1/auth/login.',
});

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request is invalid. `details` lists each problem.',
  401: 'Not signed in, or the session is no longer valid.',
  403: 'Signed in, but the role does not allow this.',
  404: 'Not found.',
  409: 'Conflicts with the current state.',
  422: 'The master data cannot support this request.',
  429: 'Too many requests.',
  503: 'A dependency is unavailable.',
};

export function errorResponses(...statuses: number[]): RouteConfig['responses'] {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      {
        description: ERROR_DESCRIPTIONS[status] ?? 'Error',
        content: { 'application/json': { schema: ApiErrorSchema } },
      },
    ]),
  );
}

export interface DocumentedRoute extends Omit<RouteConfig, 'security'> {
  /** Public routes need no bearer token. */
  public?: boolean;
}

/** Registers an endpoint. Paths use OpenAPI syntax, for example /api/v1/users/{id}. */
export function documentRoute({ public: isPublic = false, ...route }: DocumentedRoute): void {
  registry.registerPath({
    ...route,
    security: isPublic ? [] : [{ [bearerAuth.name]: [] }],
  });
}

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Property Insurance Placement ERP API',
      version: API_VERSION,
      description:
        'Foundation API: authentication, users, IIB occupancy and pincode masters, and the Fire ' +
        'rating check. Money and rates are decimal strings; rates are per mille.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth' },
      { name: 'Users', description: 'Admin only.' },
      { name: 'Masters', description: 'Reads always use the ACTIVE master version.' },
      { name: 'Rating' },
    ],
  });
}
