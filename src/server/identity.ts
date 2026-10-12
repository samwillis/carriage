import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "./db";
import { fail } from "./errors";
export interface Identity {
  principal: string;
  userId: string;
  name: string;
  kind: "person" | "agent";
  expiresAt: number;
  grantId?: string;
  scopes: string[];
  oauthClientId?: string;
}
export function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
export function secretToken(prefix: string) {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
const localSecret = new TextEncoder().encode(
  process.env.LOCAL_AUTH_SECRET || randomBytes(32).toString("hex"),
);
export const localAuthEnabled =
  process.env.LOCAL_DEV_AUTH === "true" &&
  !process.env.NEON_AUTH_BASE_URL &&
  process.env.NODE_ENV !== "production";
const jwks = process.env.NEON_AUTH_JWKS_URL
  ? createRemoteJWKSet(new URL(process.env.NEON_AUTH_JWKS_URL))
  : undefined;
export async function localToken(name: string) {
  if (!localAuthEnabled) fail(404, "not_found", "Local login is disabled.");
  const userId = `local:${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  return new SignJWT({ name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("margin-local")
    .setAudience("margin-local")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(localSecret);
}
export async function authenticate(
  request: Request,
  allowAgent = false,
): Promise<Identity> {
  const bearer = request.headers
    .get("authorization")
    ?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) fail(401, "unauthorized", "Sign in to access this document.");
  if (bearer.startsWith("margin_")) {
    if (!allowAgent)
      fail(403, "agent_route", "Agent credentials can only access MCP.");
    const {
      rows: [grant],
    } = await pool.query(
      `SELECT *, expires_at > clock_timestamp() AS valid FROM agent_grants WHERE token_hash=$1`,
      [hash(bearer)],
    );
    if (!grant || grant.revoked_at || !grant.valid)
      fail(401, "invalid_grant", "Agent connection expired or revoked.");
    return {
      principal: `grant:${grant.id}`,
      userId: grant.user_id,
      name: grant.label,
      kind: "agent",
      grantId: grant.id,
      scopes: grant.scopes,
      expiresAt: new Date(grant.expires_at).getTime(),
    };
  }
  if (allowAgent) {
    const { verifyOAuthIdentity } = await import("./oauth");
    const identity = await verifyOAuthIdentity(bearer).catch(() => null);
    if (identity) return identity;
    fail(
      401,
      "invalid_agent_credential",
      "Connect with an agent access token or OAuth.",
    );
  }
  try {
    const payload = localAuthEnabled
      ? (
          await jwtVerify(bearer, localSecret, {
            issuer: "margin-local",
            audience: "margin-local",
          })
        ).payload
      : jwks
        ? (
            await jwtVerify(bearer, jwks, {
              issuer: new URL(process.env.NEON_AUTH_BASE_URL!).origin,
            })
          ).payload
        : undefined;
    if (!payload?.sub || !payload.exp)
      fail(401, "unauthorized", "Invalid or expired login.");
    return {
      principal: `user:${payload.sub}`,
      userId: payload.sub,
      name: String(payload.name ?? payload.email ?? "Writer"),
      kind: "person",
      scopes: ["read", "edit", "write"],
      expiresAt: payload.exp * 1000,
    };
  } catch {
    fail(401, "unauthorized", "Invalid or expired login.");
  }
}
