# Carriage

A collaborative Markdown editor for Neon Realtime. Milkdown edits a shared Yjs document; every accepted update is an insert in Postgres. Neon Realtime delivers those inserts to collaborators. Browser users sign in with Neon Auth. Agents use the same write service through MCP on Neon Functions.

[Try the live demo](https://carriage-neon.vercel.app/) · [Neon Realtime documentation](https://neon.com/docs/realtime/overview) · [Agent setup guide](docs/AGENT_GUIDE.md)

Carriage is named after a typewriter carriage.

Vercel hosts the React/Vite frontend. The API, OAuth provider, MCP endpoint, and compaction run on Neon Functions. The browser connects directly to Neon Auth and Realtime.

## Run locally

Requires Node.js 24, Git and Corepack on your PATH. The SDK and CLI use unpublished Neon preview packages pinned to neon-pkgs commit `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4`. The bootstrap script builds them in `.cache/neon-pkgs` and packs the SDK dependencies into `.sdk`.

```sh
git clone https://github.com/samwillis/carriage.git
cd carriage
npm run sdk:bootstrap
# Or pack an existing built checkout instead:
# node scripts/local-sdk.mjs /path/to/built/neon-pkgs
npm ci
cp .env.example .env.local
# Fill .env.local with your Postgres, Neon Auth and Realtime configuration.
# Set OAUTH_SECRET to a random secret of at least 32 characters.
# Set NEON_CLI_PATH to the absolute CLI path printed by sdk:bootstrap.
npm run env:public
npm run db:migrate
npm run dev
```

Use a Neon branch with Auth and Realtime enabled, and allow `http://localhost:5180` in both services. The staging setup below can provision a branch for this demo.

Open <http://localhost:5180>. The API runs on loopback port 3080. Sign up, create a document, and open its URL in another window. Share invites grant editor or viewer access to another signed-in account. The document menu's **Markdown source** action shows the current source; **Export Markdown** downloads it.

All server credentials stay in ignored environment files. `env:public` writes only public Auth, Realtime, and API configuration. The Realtime secret never enters a browser build.

## Preview infrastructure and deployment

This checkout is linked to the **Sam organization in Neon staging**, project `frosty-hat-96438417`, branch `br-frosty-poetry-w25lx1wr`, PG18 in `aws-us-east-2`.

Staging requires both hosts. A CLI profile selects credentials; it does not select the environment:

```sh
NEON_API_HOST=https://console-stage.neon.build/api/v2 \
NEON_OAUTH_HOST=https://oauth2-stage.neon.build \
neon login --profile staging
```

`scripts/neon.mjs` pins both staging hosts and rejects other profiles. To provision another project, set `NEON_CLI_PATH` to the built CLI and `NEON_ORG_ID` to your staging organization in `.env.local`. `scripts/provision.mjs` creates an isolated staging project and retains its response in `.cache/project.json` so rerunning resumes that project. Do not remove that file to retry a failed provisioning step. Complete the Auth configuration in `.env.local` after enabling Auth on the branch.

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

Set `APP_ORIGIN` to the Vercel frontend origin and `API_BASE_URL` to the actual Function origin reported by the CLI. Keep those values and server secrets in a separate ignored deployment file, such as `.cache/deploy.env`, so local development keeps its ports and OAuth issuer. Apply the backend configuration with that file. Add the frontend origin to Neon Auth’s trusted domains; `neon.ts` includes it in the Realtime allowlist. The old Function homepage redirects document and invite links to Vercel. The MCP endpoint and OAuth issuer remain on Neon.

Vercel’s `vercel.json` builds the static frontend and rewrites frontend routes (including `/oauth/connect`) to `index.html`. Its install command builds the pinned unpublished SDK packages before `npm ci`, refreshing checksums for those generated tarballs on the build platform. Registry dependency versions and checksums stay locked. Only these public build variables belong in Vercel:

| Variable                  | Value                       |
| ------------------------- | --------------------------- |
| `VITE_API_BASE_URL`       | Neon Function origin        |
| `VITE_NEON_AUTH_BASE_URL` | Managed Neon Auth URL       |
| `VITE_NEON_REALTIME_URL`  | Neon Realtime WebSocket URL |

Never upload database credentials, `OAUTH_SECRET`, or the Realtime signing secret to Vercel. `.vercelignore` excludes local credential files, cached accounts, and SDK artifacts.

The Vercel project is `carriage` in the `samwillis-projects` team. Deploy from this checkout:

```sh
vercel link --project carriage --scope samwillis-projects
node --env-file=.cache/deploy.env --import tsx scripts/migrate.ts
node --env-file=.cache/deploy.env scripts/neon.mjs config plan
node --env-file=.cache/deploy.env scripts/neon.mjs deploy --no-env-pull --update-existing
# Configure the three public variables above in Vercel, then:
vercel deploy --prod --scope samwillis-projects
```

GitHub auto-deployment requires the Vercel GitHub integration to have access to [`samwillis/carriage`](https://github.com/samwillis/carriage). CLI deployment works independently of that integration. Preview origins need explicit Auth, API CORS and Realtime authorization before they can use the backend. Local production builds can use `node scripts/public-env.mjs .cache/deploy.env` to write the public browser configuration while retaining local development settings.

## Connect an agent

Use **Agent connections** in the sidebar to connect ChatGPT, Claude, Cursor, Claude Code, Codex or another MCP client to your account. Use **Share** on a document to copy its ID or a document-specific agent prompt, or open MCP setup. See the [agent guide](docs/AGENT_GUIDE.md) for setup and troubleshooting.

The demo's [MCP endpoint](https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build/mcp) runs on Neon Functions, separately from the Vercel frontend. Use this endpoint when configuring an MCP client.

- **Access token:** create an account connection, copy the configuration for your client, and approve read, edit, create or full-write permissions. Tokens are hashed in Postgres, expire after seven days by default, and can be revoked.
- **Browser sign-in:** add the public `/mcp` URL to a connector supporting OAuth authorization code, PKCE and dynamic registration. Sign in through Neon Auth and approve access to the account’s documents. The maintained Better Auth OAuth provider handles codes, refresh rotation and registration. Access tokens bind the MCP resource, the requesting client and a live account grant.

Every new OAuth authorization request requires approval for that client, including a second client in the same browser. Approvals bind the client, PKCE challenge, state, scopes and resource. Every document tool rechecks current membership and the grant’s scopes, expiry and revocation. Viewer documents stay read-only. Connections cover current and future accessible documents. Document-specific connections have been removed; their old credentials no longer work.

Migrations `004`–`006` remove document-specific credentials and OAuth state, drop the obsolete document column, and add the live connection metadata table. Apply all migrations before deploying the current backend. When upgrading an old document-scoped deployment, pause its writes during the upgrade because migration `005` is incompatible with that backend. Migrations use a shared ledger and lock so already-applied schema changes are not replayed.

```sh
node --env-file=.cache/deploy.env --import tsx scripts/migrate.ts
node --env-file=.cache/deploy.env scripts/neon.mjs deploy --no-env-pull --update-existing
vercel deploy --prod --scope samwillis-projects
```

Tools: `list_documents`, `create_document`, `read_document`, `edit_document`, and `write_document`. Discovery returns paginated metadata, with an optional title filter. Creation assigns ownership to the account and uses a durable receipt and transaction advisory lock so concurrent retries return the same document. New documents appear through the sidebar's live query. Start with an outline, then read selected blocks. References use Yjs relative positions anchored inside live block elements. Targeted operations require the returned block hash; text replacements also require the selected text and occurrence. The hash guards formatting and context. Batches preflight every operation and reject overlaps atomically. Full replacements require an unchanged document revision. Reuse the request ID and exact input after a transport failure.

## Persistence and compaction

Four separate unordered queries subscribe to snapshots, updates, metadata, and presence on one Realtime client. ACL joins keep membership in each query. There is no `UNION ALL` or `ORDER BY` in live SQL. A consistent HTTP bootstrap after the subscriptions become live closes hydration and reconnect gaps. Raw update rows merge into Yjs; pruning a compacted row never deletes editor content.

The document sidebar uses an account-scoped Realtime query over document metadata and membership. New documents, titles and permissions update without polling. The browser sorts by modification time because `ORDER BY` queries are not yet incremental in Realtime. Its sealed capability renews every 30 seconds on the existing connection.

Share subscribes to members and invitation metadata while open; Agent connections subscribes to account connection metadata. Invitation queries require a current owner membership, and connection queries include only the signed-in account. Tokens and token hashes are excluded. Local timers use server time to remove expired invitations and connections; passing time does not emit a database change. Closing a dialog stops its queries and timers.

Migration `006` creates a connection metadata table maintained by a database trigger in the grant transaction. This avoids snapshot fallback in the preview query engine caused by the legacy column dropped from `agent_grants`; existing credentials stay in place. The metadata table contains no tokens or hashes.

Save progress and the live connection are tracked separately. A query baseline refresh keeps the existing socket connected; only a connection-loss event shows “Reconnecting.” HTTP write failures show “Retrying save.” The four 60-second query capabilities renew together every 30 seconds. Presence is written on initial hydration, cursor changes, and heartbeats; refreshing a baseline does not write presence again.

The browser keeps a full replica, journal, and immutable in-flight batch in IndexedDB under user/document/schema keys. Each edit reaches storage before upload. Only one upload runs per provider. Retries preserve request ID and bytes; Postgres receipts resolve ambiguous outcomes. Missing causal dependencies generate a separate recovery batch. Rejected replicas pause and retain their journal. Export local work before leaving; a paused replica is not silently reset.

A committed write claims compaction at **200 updates**, **256 KiB**, or **60 seconds of pending age**. Age is evaluated on writes. A fixed cutoff, lease, and epoch let later appends proceed. Reconstruction and Markdown serialization happen outside the document lock. Publication verifies the epoch, source revision, and database wall-clock lease, then atomically publishes the snapshot and removes only incorporated updates. Workers renew leases and perform at most three passes. `waitUntil` is not durable delivery: a crashed idle worker is reclaimed on the next write.

Presence is a leased Postgres record per browser session or agent grant. Clicking the compact header avatars opens a participant list with names, activity and a jump-to-selection button. Browser sessions share avatar and cursor colors and distinguish another session on the same account. Typing updates promptly and clears after three seconds; hidden, unfocused or inactive sessions show Idle and clear their cursors. Leaving a document sends a sequenced tombstone, so delayed heartbeats cannot restore it; failed disconnect requests fall back to lease expiry.

Browser cursors and selections use Yjs relative positions carried over Neon Realtime and rendered with y-prosemirror awareness. Selected-block agent reads and targeted edits also publish relative selections; edits publish presence and document updates in the same transaction. Agent edit highlights clear after five seconds. Agent presence lasts up to 45 seconds after the last document operation, bounded by credential expiry. Agents appear only in documents they use. Cursor movement is throttled, never appends document updates and never triggers compaction. Monotonic sequences reject delayed older browser requests. Client clocks use a server offset; expired rows disappear locally without a nonincremental `now()` predicate.

## Verification

```sh
npm run typecheck
npm test                         # local unit and migration tests
TEST_DATABASE_URL=postgres://... npm test  # also runs transaction/concurrency tests
npm run build
```

The integration scripts under `scripts/*-smoke.*` exercise actual staging services. Set `SMOKE_APP_URL` to the frontend origin and `SMOKE_API_URL` to the Neon Function origin. They use an ignored test account and cache; they are development harnesses, not application endpoints. Browser smoke checks produce desktop/mobile screenshots. MCP checks create and remove a temporary document and revoke their test grant.

Supported content is common Markdown plus GFM lists/tables/strikethrough. HTML and unsafe link/image schemes are rejected. Mixed-format text ranges require separate operations or a guarded block replacement. Limits: 128 KiB Markdown, 1 MiB encoded Yjs state, 256 KiB per update, 32 agent operations, six CAS attempts. Concurrent edits in different blocks can retry internally; changes to the same guarded block return a target conflict.

This is a launch demo. Large documents, broad account recovery UX, and production abuse controls are outside its current scope. OAuth is protocol-tested with an independent MCP SDK client; each hosted product still needs its own connector smoke check.
