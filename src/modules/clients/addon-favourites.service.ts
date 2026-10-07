import {
  AUDIT_ACTIONS,
  AUDIT_ENTITIES,
  type AddonFavourites,
  type SetAddonFavouritesRequest,
} from '../../shared/index.ts';
import { Types } from 'mongoose';
import { withTransaction } from '../../lib/db.ts';
import { notFound } from '../../lib/errors.ts';
import { writeAudit } from '../audit/audit.service.ts';
import { AddonFavouritesModel, type AddonFavouritesDoc } from './addon-favourites.model.ts';
import { ClientModel } from './client.model.ts';
import type { Actor } from './clients.service.ts';

// Favourite add-on covers per client (C-4): the team marks the covers a client usually takes, and
// the add-on picker of every case for the client lists them first.

function toFavourites(
  doc: Pick<AddonFavouritesDoc, 'items' | 'updatedAt'> | null,
): AddonFavourites {
  return {
    items: (doc?.items ?? []).map((item) => ({ list: item.list, name: item.name })),
    updatedAt: doc?.updatedAt.toISOString() ?? null,
  };
}

async function assertClient(clientId: string): Promise<void> {
  if (!(await ClientModel.exists({ _id: clientId }))) throw notFound('Client not found');
}

export async function getAddonFavourites(clientId: string): Promise<AddonFavourites> {
  await assertClient(clientId);
  return toFavourites(
    await AddonFavouritesModel.findOne({ clientId: new Types.ObjectId(clientId) }).lean(),
  );
}

/** Replaces the client's favourites, audited with the list before and after. */
export async function setAddonFavourites(
  clientId: string,
  input: SetAddonFavouritesRequest,
  actor: Actor,
): Promise<AddonFavourites> {
  await assertClient(clientId);
  return withTransaction(async (session) => {
    const filter = { clientId: new Types.ObjectId(clientId) };
    const before = await AddonFavouritesModel.findOne(filter).session(session).lean();
    const saved = await AddonFavouritesModel.findOneAndUpdate(
      filter,
      { $set: { items: input.items, updatedBy: new Types.ObjectId(actor.id) } },
      { upsert: true, returnDocument: 'after', runValidators: true, session },
    ).lean();
    const view = (doc: typeof before) =>
      (doc?.items ?? []).map((item) => `${item.list}: ${item.name}`);
    await writeAudit(
      {
        userId: actor.id,
        action: AUDIT_ACTIONS.ADDON_FAVOURITES_UPDATED,
        entity: AUDIT_ENTITIES.CLIENT,
        entityId: clientId,
        before: { addonFavourites: view(before) },
        after: { addonFavourites: view(saved) },
        requestId: actor.requestId,
      },
      session,
    );
    return toFavourites(saved);
  });
}
