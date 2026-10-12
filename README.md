# Carriage

A collaborative Markdown editor for Neon Realtime. Milkdown edits a shared Yjs document; every accepted update is an insert in Postgres. Neon Realtime delivers those inserts to collaborators. Browser users sign in with Neon Auth. Agents use the same write service through MCP on Neon Functions.

Carriage is named after a typewriter carriage.

Vercel hosts the React/Vite frontend. The API, OAuth provider, MCP endpoint, and compaction run on Neon Functions. The browser connects directly to Neon Auth and Realtime.

[Open Carriage](https://carriage-neon.vercel.app/) · [MCP endpoint](https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build/mcp)

## Run locally

Requires Node 24 and the unpublished Neon preview packages. The SDK and CLI are pinned to neon-pkgs commit `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4` (Realtime environment/config/SDK integration). Build in an isolated checkout; the setup used here is `/private/tmp/colab-neon-pkgs-20261012`.

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

Set `APP_ORIGIN` to the Vercel frontend origin and `API_BASE_URL` to the actual Function origin reported by the CLI. Keep those values and server secrets in a separate ignored deployment file, such as `.cache/deploy.env`, so local development keeps its ports and OAuth issuer. Apply the backend configuration with that file. Add the frontend origin to Neon Auth’s trusted domains; `neon.ts` includes it in the Realtime allowlist. The old Function homepage redirects document and invite links to Vercel. The MCP endpoint and OAuth issuer remain on Neon.

Vercel’s `vercel.json` builds the static frontend and rewrites frontend routes (including `/oauth/connect`) to `index.html`. Its install command builds the pinned unpublished SDK packages before `npm ci`, refreshing checksums for those generated tarballs on the build platform. Registry dependency versions and checksums stay locked. Only these public build variables belong in Vercel:

| Variable                  | Value                       |
| ------------------------- | --------------------------- |
| `VITE_API_BASE_URL`       | Neon Function origin        |
| `VITE_NEON_AUTH_BASE_URL` | Managed Neon Auth URL       |
| `VITE_NEON_REALTIME_URL`  | Neon Realtime WebSocket URL |

Never upload database credentials, `OAUTH_SECRET`, or the Realtime signing secret to Vercel. `.vercelignore` excludes local credential files, cached accounts, and SDK artifacts.

`carriage.vercel.app` was already taken, so this project uses `carriage-neon.vercel.app`. Deploy from this checkout:

```sh
vercel link --project carriage
# Configure the three public variables above in Vercel, then:
vercel deploy --prod
node --env-file=.cache/deploy.env scripts/neon.mjs config plan
node --env-file=.cache/deploy.env scripts/neon.mjs deploy --no-env-pull --update-existing
```

GitHub auto-deployment requires the Vercel GitHub integration to have access to `sam-willis_data/carriage`. CLI deployment works independently of that integration. Preview origins need explicit Auth, API CORS and Realtime authorization before they can use the backend. Local production builds can use `node scripts/public-env.mjs .cache/deploy.env` to write the public browser configuration while retaining local development settings.

## Connect an agent

Use **Agent connections** in the sidebar to connect ChatGPT, Claude, Cursor, Claude Code, Codex or another MCP client to your account. Use **Share** on a document to copy its ID or a document-specific agent prompt, or open MCP setup. See the [agent guide](docs/AGENT_GUIDE.md) for setup and troubleshooting.

- **Access token:** create an account connection, copy the configuration for your client, and approve read, edit, create or full-write permissions. Tokens are hashed in Postgres, expire after seven days by default, and can be revoked.
- **Browser sign-in:** add the public `/mcp` URL to a connector supporting OAuth authorization code, PKCE and dynamic registration. Sign in through Neon Auth and approve access to the account’s documents. The maintained Better Auth OAuth provider handles codes, refresh rotation and registration. Access tokens bind the MCP resource, the requesting client and a live account grant.

Every new OAuth authorization request requires approval for that client, including a second client in the same browser. Approvals bind the client, PKCE challenge, state, scopes and resource. Every document tool rechecks current membership and the grant’s scopes, expiry and revocation. Viewer documents stay read-only. New connections include accessible future documents; existing document-scoped grants keep their original restrictions until explicitly replaced.

Tools: `list_documents`, `create_document`, `read_document`, `edit_document`, and `write_document`. Discovery returns paginated metadata, with an optional title filter. Creation assigns ownership to the account and uses a durable receipt and transaction advisory lock so concurrent retries return the same document. New documents appear in the sidebar on its next refresh. Start with an outline, then read selected blocks. References use Yjs relative positions anchored inside live block elements. Targeted operations require the returned block hash; text replacements also require the selected text and occurrence. The hash guards formatting and context. Batches preflight every operation and reject overlaps atomically. Full replacements require an unchanged document revision. Reuse the request ID and exact input after a transport failure.

## Persistence and compaction

Four separate unordered queries subscribe to snapshots, updates, metadata, and presence on one Realtime client. ACL joins keep membership in each query. There is no `UNION ALL` or `ORDER BY` in live SQL. A consistent HTTP bootstrap after the subscriptions become live closes hydration and reconnect gaps. Raw update rows merge into Yjs; pruning a compacted row never deletes editor content.

Save progress and the live connection are tracked separately. A query baseline refresh keeps the existing socket connected; only a connection-loss event shows “Reconnecting.” HTTP write failures show “Retrying save.” The four 60-second query capabilities renew together every 30 seconds. Presence is written on initial hydration, cursor changes, and heartbeats; refreshing a baseline does not write presence again.

The browser keeps a full replica, journal, and immutable in-flight batch in IndexedDB under user/document/schema keys. Each edit reaches storage before upload. Only one upload runs per provider. Retries preserve request ID and bytes; Postgres receipts resolve ambiguous outcomes. Missing causal dependencies generate a separate recovery batch. Rejected replicas pause and retain their journal. Export local work before leaving; a paused replica is not silently reset.

A committed write claims compaction at **200 updates**, **256 KiB**, or **60 seconds of pending age**. Age is evaluated on writes. A fixed cutoff, lease, and epoch let later appends proceed. Reconstruction and Markdown serialization happen outside the document lock. Publication verifies the epoch, source revision, and database wall-clock lease, then atomically publishes the snapshot and removes only incorporated updates. Workers renew leases and perform at most three passes. `waitUntil` is not durable delivery: a crashed idle worker is reclaimed on the next write.

Presence is a leased Postgres record per browser session or agent grant. Clicking the compact header avatars opens a participant list with names, activity and a jump-to-selection button. Browser sessions share avatar and cursor colors and distinguish another session on the same account. Typing updates promptly and clears after three seconds; hidden, unfocused or inactive sessions show Idle and clear their cursors. Leaving a document sends a sequenced tombstone, so delayed heartbeats cannot restore it; failed disconnect requests fall back to lease expiry.

Browser cursors and selections use Yjs relative positions carried over Neon Realtime and rendered with y-prosemirror awareness. Selected-block agent reads and targeted edits also publish relative selections; edits publish presence and document updates in the same transaction. Agents appear only in documents they use, with recent read/edit activity that expires between tool calls. Cursor movement is throttled, never appends document updates and never triggers compaction. Monotonic sequences reject delayed older browser requests. Client clocks use a server offset; expired rows disappear locally without a nonincremental `now()` predicate.

## Verification

```sh
npm run typecheck
npm test                         # codec and targeted edit tests
TEST_DATABASE_URL=postgres://... npm test  # also runs transaction/concurrency tests
npm run build
```

The integration scripts under `scripts/*-smoke.*` exercise actual staging services. Set `SMOKE_APP_URL` to the frontend origin and `SMOKE_API_URL` to the Neon Function origin. They use an ignored test account and cache; they are development harnesses, not application endpoints. Browser smoke checks produce desktop/mobile screenshots. MCP checks create and remove a temporary document and revoke their test grant.

Supported content is common Markdown plus GFM lists/tables/strikethrough. HTML and unsafe link/image schemes are rejected. Mixed-format text ranges require separate operations or a guarded block replacement. Limits: 128 KiB Markdown, 1 MiB encoded Yjs state, 256 KiB per update, 32 agent operations, six CAS attempts. Concurrent edits in different blocks can retry internally; changes to the same guarded block return a target conflict.

This is a launch demo. Large documents, broad account recovery UX, and production abuse controls are outside its current scope. OAuth is protocol-tested with an independent MCP SDK client; each hosted product still needs its own connector smoke check.
