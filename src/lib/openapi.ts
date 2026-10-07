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
  403: "Signed in, but the user's roles do not hold the permission this needs.",
  404: 'Not found.',
  409: 'Conflicts with the current state.',
  413: 'The uploaded file is too large.',
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
      title: 'Fiducial API',
      version: API_VERSION,
      description:
        'Foundation API: authentication, users, IIB occupancy and pincode masters, clients ' +
        'with their risk locations, the insurer master, the Fire rating check and the audit log. Money and rates are decimal strings; rates are per ' +
        'mille. Each route needs one permission; src/shared/permissions.ts maps roles to ' +
        'permissions.',
    },
    servers: [{ url: '/' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth' },
      { name: 'Users', description: 'Admin only.' },
      { name: 'Masters', description: 'Reads always use the ACTIVE master version.' },
      { name: 'Clients', description: 'The insured and their risk locations.' },
      { name: 'Insurers', description: 'Insurer branches and the email addresses RFQs go to.' },
      { name: 'Proposals', description: 'New business, from creation to the RFQ.' },
      {
        name: 'Product and cover masters',
        description:
          'Products, coverage sections, add-ons, BSUS/BLUS add-on rates, tax rates and standard notes.',
      },
      {
        name: 'Imports',
        description: 'Excel templates and bulk import of clients, locations and insurers.',
      },
      { name: 'Rating' },
      { name: 'Audit', description: 'Admin only. Append-only: entries are never changed.' },
    ],
  });
}
