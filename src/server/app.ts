import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { pool, transaction } from "./db";
import { documents } from "./documents";
import {
  authenticate,
  localAuthEnabled,
  localToken,
  hash,
  secretToken,
  type Identity,
} from "./identity";
import { AppError, fail } from "./errors";
import { documentId, requestId, presenceInput } from "../shared/contracts";
import { sealDocument } from "./live";
import {
  oauth,
  metadata,
  apiBase,
  appOrigin,
  resource,
  createLoginTicket,
  handleOAuth,
} from "./oauth";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { handleMcp } from "./mcp";
export const app = new Hono<{ Variables: { identity: Identity } }>();
app.use(
  "*",
  cors({
    origin: [appOrigin, "http://127.0.0.1:5180"],
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Session-Id",
    ],
    exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
    credentials: true,
  }),
);
app.use(
  "*",
  bodyLimit({
    maxSize: 400 * 1024,
    onError: (c) =>
      c.json(
        {
          code: "request_limit",
          error: "Request is too large.",
          retryable: false,
        },
        413,
      ),
  }),
);
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
app.onError((error, c) => {
  if (error instanceof AppError)
    return c.json(
      { code: error.code, error: error.message, retryable: error.retryable },
      error.status as any,
    );
  if (error instanceof z.ZodError)
    return c.json(
      {
        code: "invalid_request",
        error: "Invalid request.",
        details: error.issues,
        retryable: false,
      },
      400,
    );
  console.error("Request failed", error);
  return c.json(
    {
      code: "internal_error",
      error: "Request failed. Retry with the same request ID.",
      retryable: true,
    },
    500,
  );
});
app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "carriage",
    auth: localAuthEnabled ? "local" : "neon",
    realtime: !!(
      process.env.REALTIME_SECRET ?? process.env.NEON_REALTIME_SECRET
    ),
  }),
);
// Preserve existing document, invite and OAuth bookmarks after moving the UI.
for (const path of ["/", "/oauth/connect"])
  app.get(path, (c) => {
    const target = new URL(path, appOrigin);
    target.search = new URL(c.req.url).search;
    return c.redirect(target.toString(), 307);
  });
app.get("/api/config", (c) =>
  c.json({
    authUrl: process.env.NEON_AUTH_BASE_URL ?? null,
    localAuth: localAuthEnabled,
    realtimeUrl:
      process.env.REALTIME_URL ?? process.env.NEON_REALTIME_URL ?? null,
    mcpUrl: resource,
  }),
);
app.post("/api/local-login", async (c) => {
  if (
    !localAuthEnabled ||
    !["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  )
    fail(404, "not_found", "Not found.");
  const { name } = z
    .object({ name: z.string().min(1).max(50) })
    .parse(await c.req.json());
  return c.json({
    token: await localToken(name),
    name,
    userId: `local:${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
  });
});
app.all("/.well-known/oauth-authorization-server/*", (c) =>
  metadata(c.req.raw),
);
app.get("/.well-known/oauth-authorization-server", (c) => metadata(c.req.raw));
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource,
    authorization_servers: [`${apiBase}/api/oauth`],
    scopes_supported: [
      "document:read",
      "document:edit",
      "document:write",
      "document:create",
      "offline_access",
    ],
    bearer_methods_supported: ["header"],
  }),
);
app.all("/api/oauth/*", (c) => handleOAuth(c.req.raw));
app.all("/mcp", (c) => handleMcp(c.req.raw));
app.get("/oauth/consent", async (c) => {
  const query = new URL(c.req.url).search.slice(1);
  if (!(await verifyOAuthQueryParams(query, process.env.OAUTH_SECRET!)))
    fail(
      400,
      "invalid_oauth",
      "OAuth request expired. Reconnect from your agent.",
    );
  const session = await oauth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.redirect(`${appOrigin}/oauth/connect?${query}`);
  const {
    rows: [grant],
  } = await pool.query(
    'SELECT g.*,d.title,c.name AS client_name FROM agent_grants g LEFT JOIN documents d ON d.id=g.document_id LEFT JOIN oauth_clients c ON c."clientId"=g.oauth_client_id WHERE g.id=$1 AND g.user_id=$2',
    [session.session.grantId, session.user.id],
  );
  const params = new URLSearchParams(query);
  if (
    !grant ||
    grant.revoked_at ||
    new Date(grant.expires_at).getTime() <= Date.now() ||
    grant.oauth_client_id !== params.get("client_id")
  )
    fail(403, "grant_denied", "Agent approval is unavailable.");
  const text = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char]!,
    );
  return c.html(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect agent · Carriage</title><style>body{background:#eef1eb;color:#182821;font:16px system-ui;display:grid;place-items:center;min-height:90vh}main{max-width:420px;padding:40px;background:white;border-radius:20px}button{padding:12px 20px;border:0;border-radius:8px;background:#1f5341;color:white;margin-right:12px;cursor:pointer}p{line-height:1.6}small{overflow-wrap:anywhere}</style></head><body><main><h1>Connect agent</h1><p>Allow <strong>${text(grant.client_name ?? "this agent")}</strong> to access <strong>${text(grant.document_id ? grant.title : session.user.name + "’s documents")}</strong> with these permissions: ${text(grant.scopes.join(", "))}.</p><p>Existing document permissions still apply. You can revoke this connection from the Agent panel.</p><button id="accept">Allow connection</button><button id="deny">Decline</button><p id="error" role="alert"></p></main><script>const query=${JSON.stringify(query).replace(/</g, "\\u003c")};async function finish(accept){try{const r=await fetch('/api/oauth/oauth2/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accept,oauth_query:query})});const d=await r.json();if(!r.ok)throw new Error(d.message||d.error_description||'Connection failed');location.assign(d.redirect_uri||d.url);}catch(e){document.getElementById('error').textContent=e.message;}}document.getElementById('accept').onclick=()=>finish(true);document.getElementById('deny').onclick=()=>finish(false);</script></body></html>`,
  );
});
app.use("/api/*", async (c, next) => {
  c.set("identity", await authenticate(c.req.raw));
  await next();
});
app.get("/api/documents", async (c) =>
  c.json(await documents.list(c.get("identity"))),
);
app.post("/api/documents", async (c) => {
  const args = z
    .object({
      title: z.string().trim().min(1).max(200),
      markdown: z.string().default(""),
    })
    .parse(await c.req.json());
  return c.json(
    await documents.create(c.get("identity"), args.title, args.markdown),
    201,
  );
});
app.patch("/api/documents/:id", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const { title } = z
    .object({ title: z.string().trim().min(1).max(200) })
    .parse(await c.req.json());
  return c.json(
    await transaction(pool, async (client) => {
      await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      await documents.authorize(client, id, c.get("identity"), "edit", true);
      return (
        await client.query(
          "UPDATE documents SET title=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING id,title",
          [id, title],
        )
      ).rows[0];
    }),
  );
});
app.get("/api/documents/:id/bootstrap", async (c) =>
  c.json(
    await documents.bootstrap(
      documentId.parse(c.req.param("id")),
      c.get("identity"),
    ),
  ),
);
app.get("/api/documents/:id/live", async (c) =>
  c.json(
    await sealDocument(documentId.parse(c.req.param("id")), c.get("identity")),
  ),
);
app.get("/api/documents/:id/read", async (c) =>
  c.json(
    await documents.read(c.get("identity"), {
      document_id: documentId.parse(c.req.param("id")),
      mode: "full",
    }),
  ),
);
app.post("/api/documents/:id/updates", async (c) => {
  const args = z
    .object({ request_id: requestId, update: z.string().max(360 * 1024) })
    .parse(await c.req.json());
  return c.json(
    await documents.appendBrowser(
      documentId.parse(c.req.param("id")),
      c.get("identity"),
      args.request_id,
      args.update,
    ),
  );
});
app.get("/api/documents/:id/receipts/:request", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const auth = await documents.authorize(pool, id, c.get("identity"));
  const {
    rows: [receipt],
  } = await pool.query(
    "SELECT result FROM write_receipts WHERE document_id=$1 AND principal=$2 AND request_id=$3",
    [id, auth.principal, requestId.parse(c.req.param("request"))],
  );
  return c.json({ receipt: receipt?.result ?? null });
});
app.post("/api/documents/:id/presence", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  await documents.authorize(pool, id, identity);
  const args = presenceInput.parse(await c.req.json());
  await pool.query(
    `INSERT INTO document_presence(document_id,session_id,user_id,label,kind,activity,expires_at,cursor,cursor_version,updated_at)
     VALUES($1,$2,$3,$4,'person',$5,clock_timestamp()+CASE WHEN $8 THEN interval '0 seconds' ELSE interval '45 seconds' END,$6,COALESCE($7::bigint,1),clock_timestamp())
    ON CONFLICT(document_id,session_id) DO UPDATE SET label=excluded.label,activity=excluded.activity,expires_at=excluded.expires_at,cursor=excluded.cursor,updated_at=excluded.updated_at,cursor_version=CASE WHEN $7::bigint IS NULL THEN document_presence.cursor_version+1 ELSE excluded.cursor_version END WHERE document_presence.user_id=excluded.user_id AND ($7::bigint IS NULL OR document_presence.cursor_version<excluded.cursor_version)`,
    [
      id,
      args.session_id,
      identity.userId,
      identity.name,
      args.activity,
      args.cursor ? JSON.stringify(args.cursor) : null,
      args.sequence ?? null,
      args.leaving,
    ],
  );
  await pool.query(
    // Keep a short-lived tombstone so a late, older heartbeat cannot resurrect
    // a session that has explicitly left the document.
    "DELETE FROM document_presence WHERE document_id=$1 AND expires_at<clock_timestamp()-interval '2 minutes'",
    [id],
  );
  return c.json({ ok: true, server_time: Date.now() });
});
app.get("/api/documents/:id/grants", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  await documents.authorize(pool, id, identity);
  const { rows } = await pool.query(
    "SELECT id,label,scopes,expires_at,revoked_at,oauth_client_id FROM agent_grants WHERE document_id=$1 AND user_id=$2 ORDER BY created_at DESC",
    [id, identity.userId],
  );
  return c.json(rows);
});
app.post("/api/documents/:id/grants", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  const args = z
    .object({
      label: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(["read", "edit", "write"])).min(1),
      days: z.number().int().min(1).max(30).default(7),
    })
    .parse(await c.req.json());
  const token = secretToken("margin");
  const grant = await transaction(pool, async (client) => {
    await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id]);
    for (const scope of args.scopes)
      await documents.authorize(client, id, identity, scope, true);
    const {
      rows: [grant],
    } = await client.query(
      `INSERT INTO agent_grants(document_id,user_id,label,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6*interval '1 day')) RETURNING id,label,scopes,expires_at`,
      [id, identity.userId, args.label, hash(token), args.scopes, args.days],
    );
    return grant;
  });
  return c.json({ ...grant, token, mcp_url: resource }, 201);
});
app.get("/api/grants", async (c) => {
  const { rows } = await pool.query(
    `SELECT g.id,g.label,g.scopes,g.expires_at,g.revoked_at,g.oauth_client_id,g.document_id,d.title AS document_title
     FROM agent_grants g LEFT JOIN documents d ON d.id=g.document_id WHERE g.user_id=$1 ORDER BY g.created_at DESC`,
    [c.get("identity").userId],
  );
  return c.json(rows);
});
app.post("/api/grants", async (c) => {
  const identity = c.get("identity");
  const args = z
    .object({
      label: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(["read", "edit", "write", "create"])).min(1),
      days: z.number().int().min(1).max(30).default(7),
    })
    .parse(await c.req.json());
  const token = secretToken("margin");
  const {
    rows: [grant],
  } = await pool.query(
    `INSERT INTO agent_grants(user_id,label,token_hash,scopes,expires_at)
     VALUES($1,$2,$3,$4,clock_timestamp()+($5*interval '1 day')) RETURNING id,label,scopes,expires_at`,
    [
      identity.userId,
      args.label,
      hash(token),
      [...new Set(["read", ...args.scopes])],
      args.days,
    ],
  );
  return c.json({ ...grant, token, mcp_url: resource }, 201);
});
app.delete("/api/grants/:id", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  const { rowCount } = await pool.query(
    "UPDATE agent_grants SET revoked_at=clock_timestamp() WHERE id=$1 AND user_id=$2",
    [id, identity.userId],
  );
  if (!rowCount) fail(404, "not_found", "Agent connection not found.");
  await pool.query(
    "DELETE FROM document_presence WHERE session_id=$1 AND user_id=$2",
    [`grant:${id}`, identity.userId],
  );
  return c.json({ ok: true });
});
app.post("/api/oauth-ticket", async (c) => {
  const args = z
    .object({ oauth_query: z.string().max(8192) })
    .parse(await c.req.json());
  return c.json({
    url: await createLoginTicket(c.get("identity"), args.oauth_query),
  });
});
app.get("/api/documents/:id/members", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  await documents.authorize(pool, id, c.get("identity"));
  return c.json(
    (
      await pool.query(
        "SELECT user_id,role FROM document_members WHERE document_id=$1",
        [id],
      )
    ).rows,
  );
});
app.post("/api/documents/:id/invites", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  const args = z
    .object({ role: z.enum(["editor", "viewer"]) })
    .parse(await c.req.json());
  const token = secretToken("invite");
  const invite = await transaction(pool, async (client) => {
    await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id]);
    if (
      (await documents.authorize(client, id, identity, "edit", true)).role !==
      "owner"
    )
      fail(403, "owner_required", "Only the owner can invite people.");
    return (
      await client.query(
        `INSERT INTO document_invites(document_id,token_hash,role,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days') RETURNING id,role,expires_at`,
        [id, hash(token), args.role],
      )
    ).rows[0];
  });
  return c.json(
    { ...invite, url: `${appOrigin}/?invite=${encodeURIComponent(token)}` },
    201,
  );
});
app.get("/api/documents/:id/invites", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  if ((await documents.authorize(pool, id, c.get("identity"))).role !== "owner")
    fail(403, "owner_required", "Only the owner can manage invites.");
  return c.json(
    (
      await pool.query(
        "SELECT id,role,expires_at,revoked_at FROM document_invites WHERE document_id=$1",
        [id],
      )
    ).rows,
  );
});
app.delete("/api/documents/:id/invites/:invite", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  await transaction(pool, async (client) => {
    await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [id]);
    if (
      (await documents.authorize(client, id, c.get("identity"), "edit", true))
        .role !== "owner"
    )
      fail(403, "owner_required", "Only the owner can manage invites.");
    await client.query(
      "UPDATE document_invites SET revoked_at=clock_timestamp() WHERE id=$1 AND document_id=$2",
      [documentId.parse(c.req.param("invite")), id],
    );
  });
  return c.json({ ok: true });
});
app.post("/api/invites/accept", async (c) => {
  const { token } = z
    .object({ token: z.string().max(100) })
    .parse(await c.req.json());
  const identity = c.get("identity");
  const {
    rows: [existing],
  } = await pool.query(
    "SELECT document_id FROM document_invites WHERE token_hash=$1",
    [hash(token)],
  );
  if (!existing) fail(404, "invalid_invite", "Invitation is unavailable.");
  return c.json(
    await transaction(pool, async (client) => {
      await client.query("SELECT id FROM documents WHERE id=$1 FOR UPDATE", [
        existing.document_id,
      ]);
      const {
        rows: [invite],
      } = await client.query(
        "SELECT * FROM document_invites WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()",
        [hash(token)],
      );
      if (!invite)
        fail(410, "invalid_invite", "Invitation expired or was revoked.");
      await client.query(
        `INSERT INTO document_members(document_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(document_id,user_id) DO NOTHING`,
        [invite.document_id, identity.userId, invite.role],
      );
      return { document_id: invite.document_id };
    }),
  );
});
app.delete("/api/documents/:id/members/:user", async (c) => {
  const id = documentId.parse(c.req.param("id"));
  const identity = c.get("identity");
  await transaction(pool, async (client) => {
    const {
      rows: [document],
    } = await client.query(
      "SELECT owner_id FROM documents WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (
      (await documents.authorize(client, id, identity, "edit", true)).role !==
      "owner"
    )
      fail(403, "owner_required", "Only the owner can remove members.");
    if (c.req.param("user") === document.owner_id)
      fail(400, "owner_required", "The owner cannot be removed.");
    await client.query(
      "DELETE FROM document_members WHERE document_id=$1 AND user_id=$2",
      [id, c.req.param("user")],
    );
  });
  return c.json({ ok: true });
});
export default app;
