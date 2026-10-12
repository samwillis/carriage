import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  oauthProvider,
  oauthProviderAuthServerMetadata,
  getOAuthProviderApi,
  verifyOAuthQueryParams,
  type OAuthOptions,
} from "@better-auth/oauth-provider";
import { z } from "zod";
import { pool, transaction } from "./db";
import { hash, secretToken, type Identity } from "./identity";
import { fail } from "./errors";
export const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:5180";
export const apiBase = (
  process.env.API_BASE_URL ?? "http://localhost:3080"
).replace(/\/$/, "");
export const resource = `${apiBase}/mcp`;
const flowHeader = "x-margin-authorization-flow";
function flowHash(params: URLSearchParams) {
  return hash(
    JSON.stringify(
      [
        "client_id",
        "redirect_uri",
        "response_type",
        "scope",
        "state",
        "resource",
        "code_challenge",
        "code_challenge_method",
        "nonce",
      ].map((key) => [key, params.getAll(key).sort()]),
    ),
  );
}
const oauthSecret = process.env.OAUTH_SECRET;
if (!oauthSecret || oauthSecret.length < 32)
  throw new Error("OAUTH_SECRET must contain at least 32 characters.");
export const oauthOptions: OAuthOptions<string[]> = {
  loginPage: `${appOrigin}/oauth/connect`,
  consentPage: `${apiBase}/oauth/consent`,
  scopes: [
    "document:read",
    "document:edit",
    "document:write",
    "document:create",
    "offline_access",
  ],
  resources: [resource],
  grantTypes: ["authorization_code", "refresh_token"],
  clientRegistrationDefaultResources: [resource],
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  accessTokenExpiresIn: 900,
  storeTokens: "hashed",
  schema: {
    oauthClient: { modelName: "oauth_clients" },
    oauthAccessToken: { modelName: "oauth_access_tokens" },
    oauthRefreshToken: { modelName: "oauth_refresh_tokens" },
    oauthConsent: { modelName: "oauth_consents" },
  },
  postLogin: {
    page: `${appOrigin}/oauth/connect`,
    shouldRedirect: async ({ session, headers }) =>
      !session.grantId || session.grantFlow !== headers.get(flowHeader),
    consentReferenceId: async ({ session, user }) => {
      const {
        rows: [grant],
      } = await pool.query(
        "SELECT id FROM agent_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        [session.grantId, user.id],
      );
      if (!grant)
        throw new APIError("FORBIDDEN", {
          message: "Agent approval expired.",
        });
      return grant.id;
    },
  },
  customAccessTokenClaims: async ({ referenceId, user }) => {
    if (!referenceId || !user)
      throw new APIError("FORBIDDEN", {
        message: "An agent grant is required.",
      });
    const {
      rows: [grant],
    } = await pool.query(
      "SELECT id FROM agent_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
      [referenceId, user.id],
    );
    if (!grant)
      throw new APIError("FORBIDDEN", {
        message: "Agent approval expired or was revoked.",
      });
    return { grant_id: grant.id };
  },
};
export const oauth = betterAuth({
  appName: "Carriage agent connections",
  baseURL: `${apiBase}/api/oauth`,
  basePath: "/api/oauth",
  secret: oauthSecret,
  database: pool,
  trustedOrigins: [appOrigin, apiBase],
  user: { modelName: "oauth_users" },
  account: { modelName: "oauth_accounts" },
  verification: { modelName: "oauth_verifications" },
  session: {
    modelName: "oauth_sessions",
    expiresIn: 3600,
    additionalFields: {
      grantId: { type: "string", required: false, input: false },
      grantFlow: { type: "string", required: false, input: false },
    },
  },
  advanced: {
    useSecureCookies: apiBase.startsWith("https:"),
    defaultCookieAttributes: { sameSite: "lax" },
  },
  plugins: [
    jwt(),
    oauthProvider(oauthOptions),
    {
      id: "neon-session-bridge",
      endpoints: {
        neonBridge: createAuthEndpoint(
          "/neon-bridge",
          { method: "GET", query: z.object({ ticket: z.string() }) },
          async (ctx) => {
            const {
              rows: [ticket],
            } = await pool.query(
              "DELETE FROM oauth_login_tickets WHERE token_hash=$1 AND expires_at>clock_timestamp() RETURNING *",
              [hash(ctx.query.ticket)],
            );
            if (!ticket)
              throw new APIError("UNAUTHORIZED", {
                message: "Login ticket expired. Return to the app.",
              });
            let user = await ctx.context.internalAdapter.findUserById(
              ticket.user_id,
            );
            if (!user)
              user = await ctx.context.internalAdapter.createUser(
                {
                  id: ticket.user_id,
                  name: ticket.name,
                  email: `${hash(ticket.user_id)}@identity.margin.invalid`,
                  emailVerified: true,
                },
                { method: "custom" },
              );
            const session = await ctx.context.internalAdapter.createSession(
              user.id,
              false,
              {
                grantId: ticket.grant_id,
                grantFlow: flowHash(new URLSearchParams(ticket.oauth_query)),
              },
            );
            await setSessionCookie(ctx, { session, user });
            const query = new URLSearchParams(ticket.oauth_query);
            for (const key of ["sig", "exp", "ba_iat", "ba_pl", "ba_param"])
              query.delete(key);
            query.set("prompt", "consent");
            throw ctx.redirect(
              `${apiBase}/api/oauth/oauth2/authorize?${query}`,
            );
          },
        ),
        tokenIdentity: createAuthEndpoint(
          "/token-identity",
          { method: "POST", body: z.object({ token: z.string() }) },
          async (ctx) => {
            const payload = await getOAuthProviderApi(
              ctx,
              oauthOptions,
            ).requireActiveAccessToken(ctx.body.token);
            const audiences = Array.isArray(payload.aud)
              ? payload.aud
              : [payload.aud];
            if (!audiences.includes(resource))
              throw new APIError("UNAUTHORIZED", {
                message: "Wrong MCP resource.",
              });
            return ctx.json(payload);
          },
        ),
      },
    },
  ],
});
export const metadata = oauthProviderAuthServerMetadata(oauth);
// The provider exposes request headers to postLogin policy. Supply a server-owned
// fingerprint of this authorization request; never trust a caller's header.
export async function handleOAuth(request: Request) {
  const url = new URL(request.url),
    headers = new Headers(request.headers);
  headers.delete(flowHeader);
  let params: URLSearchParams | undefined;
  if (url.pathname.endsWith("/oauth2/authorize")) params = url.searchParams;
  else if (
    ["/oauth2/consent", "/oauth2/continue"].some((path) =>
      url.pathname.endsWith(path),
    )
  ) {
    const body = await request
      .clone()
      .json()
      .catch(() => null);
    if (typeof body?.oauth_query === "string")
      params = new URLSearchParams(body.oauth_query);
  }
  if (params) headers.set(flowHeader, flowHash(params));
  return oauth.handler(new Request(request, { headers }));
}
export async function createLoginTicket(identity: Identity, query: string) {
  if (!(await verifyOAuthQueryParams(query, oauthSecret!)))
    fail(400, "invalid_oauth", "OAuth request is invalid or expired.");
  const params = new URLSearchParams(query);
  const clientId = params.get("client_id");
  if (!clientId) fail(400, "invalid_oauth", "OAuth client is missing.");
  const requested = (params.get("scope") ?? "document:read")
    .split(" ")
    .filter((scope) => scope.startsWith("document:"))
    .map((scope) => scope.slice(9));
  if (!requested.includes("read")) requested.push("read");
  const ticket = secretToken("ticket");
  await transaction(pool, async (client) => {
    if (identity.kind !== "person" || identity.expiresAt <= Date.now())
      fail(401, "unauthorized", "Sign in to connect an agent.");
    if (
      requested.some(
        (scope) => !["read", "edit", "write", "create"].includes(scope),
      )
    )
      fail(400, "invalid_oauth", "Unknown agent permission.");
    const {
      rows: [clientInfo],
    } = await client.query(
      'SELECT name FROM oauth_clients WHERE "clientId"=$1',
      [clientId],
    );
    const {
      rows: [grant],
    } = await client.query(
      `INSERT INTO agent_grants(user_id,label,oauth_client_id,scopes,expires_at)
      VALUES($1,$2,$3,$4,clock_timestamp()+interval '30 days') RETURNING id`,
      [
        identity.userId,
        clientInfo?.name?.slice(0, 80) || "Hosted agent",
        clientId,
        requested,
      ],
    );
    await client.query(
      "INSERT INTO oauth_login_tickets(token_hash,user_id,name,grant_id,oauth_query,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '2 minutes')",
      [hash(ticket), identity.userId, identity.name, grant.id, query],
    );
  });
  return `${apiBase}/api/oauth/neon-bridge?ticket=${encodeURIComponent(ticket)}`;
}
export async function verifyOAuthIdentity(token: string): Promise<Identity> {
  const payload = await oauth.api.tokenIdentity({ body: { token } });
  if (!payload.sub || !payload.exp || typeof payload.grant_id !== "string")
    fail(401, "invalid_grant", "Invalid agent token.");
  const {
    rows: [grant],
  } = await pool.query(
    "SELECT *,expires_at>clock_timestamp() AS valid FROM agent_grants WHERE id=$1 AND user_id=$2",
    [payload.grant_id, payload.sub],
  );
  if (!grant || grant.revoked_at || !grant.valid)
    fail(401, "invalid_grant", "Agent approval was revoked.");
  if (payload.client_id !== grant.oauth_client_id)
    fail(
      401,
      "invalid_grant",
      "OAuth client does not match the agent approval.",
    );
  const scopes = String(payload.scope ?? "")
    .split(" ")
    .filter((scope) => scope.startsWith("document:"))
    .map((scope) => scope.slice(9));
  return {
    principal: `grant:${grant.id}`,
    userId: payload.sub,
    grantId: grant.id,
    name: grant.label,
    kind: "agent",
    scopes,
    expiresAt: payload.exp * 1000,
  };
}
