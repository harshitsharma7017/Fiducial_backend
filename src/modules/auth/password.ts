import argon2 from 'argon2';

const HASH_OPTIONS = { type: argon2.argon2id } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Spends about as long as a real check. Used when the account is unknown, inactive or locked,
 * so response time does not reveal which emails have accounts.
 */
export async function verifyAgainstDummyHash(password: string): Promise<void> {
  dummyHash ??= argon2.hash('timing-equaliser-not-a-real-password', HASH_OPTIONS);
  await verifyPassword(await dummyHash, password);
}
