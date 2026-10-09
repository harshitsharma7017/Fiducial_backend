import { describe, expect, it } from 'vitest';
import { LoginRequestSchema } from './auth.ts';
import { OccupancySearchQuerySchema } from './masters.ts';
import { CreateUserRequestSchema, UpdateUserRequestSchema } from './users.ts';

describe('LoginRequestSchema', () => {
  it('normalises the email', () => {
    const parsed = LoginRequestSchema.parse({ email: '  Admin@Example.COM ', password: 'x' });
    expect(parsed.email).toBe('admin@example.com');
  });

  it('rejects operator objects and unknown keys', () => {
    expect(LoginRequestSchema.safeParse({ email: { $gt: '' }, password: 'x' }).success).toBe(false);
    expect(
      LoginRequestSchema.safeParse({ email: 'a@example.com', password: 'x', role: 'ADMIN' })
        .success,
    ).toBe(false);
  });
});

describe('CreateUserRequestSchema', () => {
  const valid = {
    email: 'new.user@example.com',
    name: 'New User',
    password: 'correct horse battery',
    roles: ['MANAGER'],
  };

  it('accepts a valid user', () => {
    expect(CreateUserRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('enforces a 12 character minimum password', () => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, password: 'short-pass1' }).success).toBe(
      false,
    );
  });

  it('requires at least one unique role', () => {
    expect(CreateUserRequestSchema.safeParse({ ...valid, roles: [] }).success).toBe(false);
    expect(
      CreateUserRequestSchema.safeParse({ ...valid, roles: ['MANAGER', 'MANAGER'] }).success,
    ).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...valid, roles: ['ROOT'] }).success).toBe(false);
  });
});

describe('UpdateUserRequestSchema', () => {
  it('requires at least one field', () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ active: false }).success).toBe(true);
  });
});

describe('OccupancySearchQuerySchema', () => {
  it('coerces and bounds the limit', () => {
    expect(OccupancySearchQuerySchema.parse({}).limit).toBe(20);
    expect(OccupancySearchQuerySchema.parse({ limit: '50' }).limit).toBe(50);
    expect(OccupancySearchQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});
