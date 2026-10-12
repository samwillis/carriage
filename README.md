# Margin

A collaborative Markdown editor for Neon Realtime. Milkdown edits a shared Yjs document; every accepted update is an insert in Postgres. Neon Realtime delivers those inserts to collaborators. Browser users sign in with Neon Auth. Agents use the same write service through MCP on Neon Functions.

The editor, API, OAuth provider, and MCP endpoint are deployed together on one Neon Function. The frontend is embedded at build time, so this demo does not need a separate hosting account.

[Open the staging demo](https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build/) · [MCP endpoint](https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build/mcp)

## Run locally

Requires Node 22.18+ and the unpublished Neon preview packages. The SDK and CLI are pinned to neon-pkgs commit `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4` (Realtime environment/config/SDK integration). Build in an isolated checkout; the setup used here is `/private/tmp/colab-neon-pkgs-20261012`.

```sh
# In this repository:
npm run sdk:bootstrap
# Or pack an existing built checkout instead:
# node scripts/local-sdk.mjs /path/to/built/neon-pkgs
npm ci
cp .env.example .env.local
# Fill .env.local with your branch credentials and a random OAUTH_SECRET.
npm run env:public
npm run db:migrate
npm run dev
```

Open <http://localhost:5180>. The API runs on loopback port 3080. Sign up, create a document, and open its URL in another window. Share invites grant editor or viewer access to another signed-in account. The Markdown tab exposes the current source; export downloads it.

All server credentials stay in ignored environment files. `env:public` writes only public Auth, Realtime, and API configuration. The Realtime secret never enters a browser build.

## Preview infrastructure and deployment

This checkout is linked to the **Sam organization in Neon staging**, project `frosty-hat-96438417`, branch `br-frosty-poetry-w25lx1wr`, PG18 in `aws-us-east-2`.

Staging requires both hosts. A CLI profile selects credentials; it does not select the environment:

```sh
NEON_API_HOST=https://console-stage.neon.build/api/v2 \
NEON_OAUTH_HOST=https://oauth2-stage.neon.build \
neon login --profile staging
```

`scripts/neon.mjs` pins both staging hosts and rejects other profiles. `scripts/provision.mjs` creates an isolated staging project and retains its response in `.cache/project.json` so rerunning resumes that project. Do not remove that file to retry a failed provisioning step.

```sh
node --env-file=.env.local scripts/provision.mjs
node --env-file=.env.local scripts/neon.mjs link \
  --project-id YOUR_PROJECT --branch YOUR_BRANCH --no-env-pull --no-config -y
npm run env:public
npm run db:migrate
npm run build
node --env-file=.env.local scripts/neon.mjs config plan
node --env-file=.env.local scripts/neon.mjs deploy --no-env-pull --update-existing
```

For a public deployment, set `APP_ORIGIN` and `API_BASE_URL` to the actual Function origin reported by the CLI, then redeploy. Add that origin to Neon Auth's trusted domains. `neon.ts` includes the application origin and local development origins in the Realtime allowlist. Do not guess a Function URL. A separate ignored deployment environment file lets local development keep its own ports and OAuth issuer.

## Connect an agent

The **Connect agent** panel supports both flows:

- **CLI/local:** create a document-scoped bearer token, copy the displayed MCP configuration, and give the agent the document ID. Tokens are hashed in Postgres, expire after seven days by default, and can be revoked.
- **Hosted:** add the public `/mcp` URL to a connector supporting OAuth authorization code, PKCE, and dynamic registration. The browser signs in through Neon Auth, selects a document, and approves scopes. A separate maintained Better Auth OAuth provider handles codes, refresh rotation, and client registration. Access tokens are bound to the MCP resource and to a live document grant.

Every new authorization request selects its document again, including a second client in the same browser. The approval binds the requesting client, PKCE challenge, state, scopes, and resource; agent access also checks the grant's client binding.

Tools: `read_document`, `edit_document`, and `write_document`. Start with an outline, then read selected blocks. References use Yjs relative positions anchored inside live block elements. Targeted operations require the returned block hash; text replacements also require the selected text and occurrence. The hash guards formatting and context. Batches preflight every operation and reject overlaps atomically. Full replacements require an unchanged document revision. Reuse the request ID and exact input after a transport failure.

## Persistence and compaction

Four separate unordered queries subscribe to snapshots, updates, metadata, and presence on one Realtime client. ACL joins keep membership in each query. There is no `UNION ALL` or `ORDER BY` in live SQL. A consistent HTTP bootstrap after the subscriptions become live closes hydration and reconnect gaps. Raw update rows merge into Yjs; pruning a compacted row never deletes editor content.

The browser keeps a full replica, journal, and immutable in-flight batch in IndexedDB under user/document/schema keys. Each edit reaches storage before upload. Only one upload runs per provider. Retries preserve request ID and bytes; Postgres receipts resolve ambiguous outcomes. Missing causal dependencies generate a separate recovery batch. Rejected replicas pause and retain their journal. Export local work before leaving; a paused replica is not silently reset.

A committed write claims compaction at **200 updates**, **256 KiB**, or **60 seconds of pending age**. Age is evaluated on writes. A fixed cutoff, lease, and epoch let later appends proceed. Reconstruction and Markdown serialization happen outside the document lock. Publication verifies the epoch, source revision, and database wall-clock lease, then atomically publishes the snapshot and removes only incorporated updates. Workers renew leases and perform at most three passes. `waitUntil` is not durable delivery: a crashed idle worker is reclaimed on the next write.

Presence is a leased Postgres record per browser session or agent grant, renewed by browser heartbeats and agent tool calls. Client clocks are adjusted from server time; expired rows disappear locally without a nonincremental `now()` predicate. This demo shows who is viewing or editing; it does not transmit cursor positions.

## Verification

```sh
npm run typecheck
npm test                         # codec and targeted edit tests
TEST_DATABASE_URL=postgres://... npm test  # also runs transaction/concurrency tests
npm run build
```

The integration scripts under `scripts/*-smoke.*` exercise actual staging services. They use an ignored test account and cache; they are development harnesses, not application endpoints. Browser smoke checks produce desktop/mobile screenshots. MCP checks create and remove a temporary document and revoke their test grant.

Supported content is common Markdown plus GFM lists/tables/strikethrough. HTML and unsafe link/image schemes are rejected. Mixed-format text ranges require separate operations or a guarded block replacement. Limits: 128 KiB Markdown, 1 MiB encoded Yjs state, 256 KiB per update, 32 agent operations, six CAS attempts. Concurrent edits in different blocks can retry internally; changes to the same guarded block return a target conflict.

This is a launch demo. Large documents, rich cursor awareness, broad account recovery UX, and production abuse controls are outside its current scope. OAuth is protocol-tested with an independent MCP SDK client; each hosted product still needs its own connector smoke check.
