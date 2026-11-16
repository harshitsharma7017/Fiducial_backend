import { EB_ADDON_LIST } from '../../shared/index.ts';
import { validationError } from '../../lib/errors.ts';
import { catalogItems } from '../catalog/catalog.service.ts';

/**
 * The add-on covers asked for on an Employee Benefits case (GMC, GPA, GTLI), checked against the
 * Employee Benefits list of the add-on master and spelled as the master spells them. A cover the
 * case already had stays allowed after the master switches it off, so an unrelated edit is not
 * refused.
 */
export async function checkEbAddons(
  names: readonly string[] | undefined,
  previous: readonly string[] | undefined,
): Promise<string[]> {
  const asked = names ?? [];
  if (asked.length === 0) return [];
  const master = (await catalogItems('addons')).filter((item) => item.list === EB_ADDON_LIST);
  const key = (name: string) => name.trim().toLowerCase();
  const kept = new Set((previous ?? []).map(key));
  return asked.map((name, index) => {
    const item = master.find((entry) => key(entry.name) === key(name));
    if (item && (item.active || kept.has(key(name)))) return item.name;
    if (!item && kept.has(key(name))) return name;
    throw validationError([
      {
        location: 'body',
        path: `addons.${index}`,
        message: `${name} is not an active add-on of the Employee Benefits list`,
      },
    ]);
  });
}
