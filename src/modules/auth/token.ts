import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'property-erp-api';
const AUDIENCE = 'property-erp';
const ALGORITHM = 'HS256';

const encoder = new TextEncoder();

/** Signs a short-lived access token whose subject is the user id. */
export async function signAccessToken(
  userId: string,
  secret: string,
  expiresInSeconds: number,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .setJti(randomUUID())
    .sign(encoder.encode(secret));
}

/** Returns the user id for a valid token, or null for an invalid, expired or tampered one. */
export async function verifyAccessToken(token: string, secret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
