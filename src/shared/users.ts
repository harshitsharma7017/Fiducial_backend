import { z } from 'zod';
import { EmailSchema, PasswordSchema, UserSchema } from './auth.ts';
import { CursorSchema, LimitSchema, ObjectIdSchema, paginatedSchema } from './common.ts';
import { ROLES, RoleSchema } from './roles.ts';

export const UserNameSchema = z.string().trim().min(1, 'Enter a name').max(120, 'Name is too long');

export const UserRolesSchema = z
  .array(RoleSchema)
  .min(1, 'Select at least one role')
  .max(ROLES.length)
  .refine((roles) => new Set(roles).size === roles.length, 'Each role can be selected once');

export const CreateUserRequestSchema = z.strictObject({
  email: EmailSchema,
  name: UserNameSchema,
  password: PasswordSchema,
  roles: UserRolesSchema,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .strictObject({
    name: UserNameSchema.optional(),
    roles: UserRolesSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.roles !== undefined || body.active !== undefined,
    'Provide at least one of name, roles or active',
  );
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const UserListQuerySchema = z.strictObject({
  limit: LimitSchema,
  cursor: CursorSchema.optional(),
});
export type UserListQuery = z.infer<typeof UserListQuerySchema>;

export const UserIdParamsSchema = z.strictObject({ id: ObjectIdSchema });

export const UserListResponseSchema = paginatedSchema(UserSchema);
export type UserListResponse = z.infer<typeof UserListResponseSchema>;
