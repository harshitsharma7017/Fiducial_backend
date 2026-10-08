import {
  CATALOG_SHEETS,
  type CatalogItem,
  type CatalogMaster,
  type CatalogRows,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { toDecimal128 } from '../../lib/decimal.ts';
import type { CatalogItemDoc } from './catalog-item.model.ts';

const DECIMAL_TYPES = new Set(['rupees', 'percent']);

/** A validated row as stored: amounts and percentages as Decimal128. */
export function toCatalogData(master: CatalogMaster, row: object): Record<string, unknown> {
  const values = row as Record<string, unknown>;
  return Object.fromEntries(
    CATALOG_SHEETS[master].columns.map((column) => {
      const value = values[column.key] ?? null;
      return [
        column.key,
        DECIMAL_TYPES.has(column.type) && typeof value === 'string' ? toDecimal128(value) : value,
      ];
    }),
  );
}

function plain(value: unknown): unknown {
  if (value instanceof Types.Decimal128) return value.toString();
  return value ?? null;
}

/** A stored row as the API returns it. Columns added later read as null. */
export function toCatalogRow<M extends CatalogMaster>(
  master: M,
  data: Record<string, unknown>,
): CatalogRows[M] {
  return Object.fromEntries(
    CATALOG_SHEETS[master].columns.map((column) => {
      const value = plain(data[column.key]);
      return [column.key, column.type === 'list' && value === null ? [] : value];
    }),
  ) as unknown as CatalogRows[M];
}

export function toCatalogItem<M extends CatalogMaster>(
  master: M,
  doc: Pick<CatalogItemDoc, '_id' | 'data' | 'updatedAt'>,
): CatalogItem<M> {
  return {
    ...toCatalogRow(master, doc.data),
    id: doc._id.toHexString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

/** How rows are listed: by order (or list then S No, or date), then by name. */
export function compareCatalogItems(master: CatalogMaster) {
  return (a: object, b: object): number => {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const num = (value: unknown) => (typeof value === 'number' ? value : 0);
    const str = (value: unknown) => (typeof value === 'string' ? value : '');
    switch (master) {
      case 'addons':
        return (
          str(x.list).localeCompare(str(y.list)) ||
          num(x.seq) - num(y.seq) ||
          str(x.name).localeCompare(str(y.name))
        );
      case 'addon-rules':
        return num(x.seq) - num(y.seq);
      case 'tax-rates':
        return (
          str(x.tax).localeCompare(str(y.tax)) ||
          str(y.effectiveFrom).localeCompare(str(x.effectiveFrom))
        );
      case 'occupancy-defaults':
        return str(x.tacCode).localeCompare(str(y.tacCode), 'en', { numeric: true });
      default:
        return num(x.order) - num(y.order) || str(x.code).localeCompare(str(y.code));
    }
  };
}
