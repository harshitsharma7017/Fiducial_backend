import { z } from 'zod';

/** MongoDB ObjectId as a 24-character hex string. */
export const ObjectIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, 'Must be a 24-character hexadecimal id');

/**
 * A decimal number carried as a string. Money and rates never travel as JSON numbers,
 * so no value passes through binary floating point.
 */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'Must be a decimal number written as a string');

export const IsoDateTimeSchema = z.iso.datetime();

/** Page size for cursor pagination. Query strings arrive as text, so the value is coerced. */
export const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** Opaque cursor for "load more" pagination (the last item's id). */
export const CursorSchema = ObjectIdSchema;

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
