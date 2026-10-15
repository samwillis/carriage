# Carriage

Carriage is a collaborative Markdown editor built with Neon Realtime. Write together, see each other's cursors and selections, and invite an AI agent to read or edit the same document.

Neon Realtime lets applications subscribe to SQL queries and receive changes to their results as data changes in Postgres. Carriage uses those live queries to keep documents, presence, sharing and the document list in sync.

[Try the demo](https://carriage-neon.vercel.app/) · [Neon Realtime docs](https://neon.com/docs/realtime/overview)

## Built on Neon

| Service            | How Carriage uses it                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Neon Realtime**  | Delivers document updates, cursors, presence and changes to document lists, sharing and agent connections. |
| **Neon Postgres**  | Stores Yjs updates, document snapshots, Markdown, memberships, invitations and agent access grants.        |
| **Neon Auth**      | Signs people in. The backend uses their identity to authorize document access and live queries.            |
| **Neon Functions** | Runs the write API, snapshot compaction, MCP server and agent OAuth endpoints.                             |

The React and Vite frontend is hosted on Vercel. The editor uses [Milkdown](https://milkdown.dev/) with [Yjs](https://yjs.dev/) for collaborative editing.

## Try it

Open the [demo](https://carriage-neon.vercel.app/), sign in and create a document. Open it in another browser window, or use **Share** to invite someone with editor or viewer access. Edits, cursors and selections appear across connected sessions.

To work with an agent, open **Agent connections** in the sidebar. Connect ChatGPT, Claude, Cursor, Claude Code, Codex or another MCP client, then ask it to find or create a document. Connections cover the documents your account can access, within the permissions you approve. Keep a document open to watch the agent's edits arrive.

The document's **Share** panel includes its ID and a prompt to give your agent. See the [agent setup guide](docs/AGENT_GUIDE.md) for client-specific instructions.

## How it works

### Editing and persistence

Milkdown edits a shared Yjs document in the browser. Yjs represents edits as binary updates that can be merged across collaborators. The browser sends those updates to the API on Neon Functions, which checks document permissions and inserts each accepted update into Postgres.

Neon Realtime delivers the inserted rows to subscribed browsers. Each browser applies them to its local Yjs document, updating the editor. An IndexedDB journal retains unsent edits across connection interruptions, and retries reuse request IDs to avoid duplicate writes.

The replication and local persistence logic is in [src/client/provider.ts](src/client/provider.ts).

### Live SQL queries

An open document subscribes to four queries on one Realtime client: its snapshot, remaining updates, metadata and presence. The backend signs queries for the authenticated user. Membership joins keep each query scoped to documents that user can access. For example, the update subscription reads:

```sql
SELECT u.update, u.revision
FROM document_updates u
JOIN document_members m ON m.document_id = u.document_id
WHERE u.document_id = $1 AND m.user_id = $2;
```

The sidebar subscribes to document metadata and membership changes. Sharing and agent connection dialogs subscribe while open. Sorting happens in the browser, keeping the live SQL unordered.

The queries are defined in [src/server/live.ts](src/server/live.ts).

### Snapshots and compaction

Edits are appended as individual rows. The write path starts compaction when pending updates reach **200 rows**, **256 KiB**, or **60 seconds of age**. The age threshold is checked when a write arrives.

Compaction merges updates into a Yjs snapshot and a Markdown representation. A worker claims a fixed cutoff under a database lease, builds the snapshot outside the document lock, then publishes it and removes the incorporated updates in one transaction. Collaborators can keep writing while compaction runs; newer updates remain in the update log.

The write path and compaction worker are in [src/server/documents.ts](src/server/documents.ts).

### Presence and agent editing

Presence lives in expiring Postgres rows and reaches collaborators through Realtime. Browser cursors and selections use Yjs relative positions, so they follow the text as it changes. The participant list shows people and agents, their activity, and a way to jump to their selection. Agent edit highlights clear after five seconds.

The MCP server exposes `list_documents`, `create_document`, `read_document`, `edit_document` and `write_document`. Agents can read an outline, retrieve selected blocks and apply targeted edits. Block hashes guard against overwriting a collaborator's changes; whole-document replacement requires a current revision. Agent writes use the same persistence path and publish presence alongside document changes.

Hosted clients can connect through OAuth and Neon Auth; token-based clients can use an account access token. Both respect document roles and the connection's permissions. The MCP server is in [src/server/mcp.ts](src/server/mcp.ts), with targeted editing in [src/server/editing.ts](src/server/editing.ts).

## Run locally

You'll need Node.js 24, Git, Corepack and a Neon branch with Auth and Realtime enabled. Add `http://localhost:5180` to the allowed origins for Auth and Realtime.

Clone the repository and install its dependencies:

```sh
git clone https://github.com/samwillis/carriage.git
cd carriage
npm run sdk:bootstrap -- --sdk-only
npm ci
cp .env.example .env.local
```

The bootstrap command builds the pinned Neon SDK packages used by the demo. Fill in `.env.local` with your branch's configuration:

| Variable                | Value                                                                         |
| ----------------------- | ----------------------------------------------------------------------------- |
| `DATABASE_URL`          | Your Neon Postgres connection string.                                         |
| `DATABASE_URL_UNPOOLED` | A direct Postgres connection string for migrations.                           |
| `NEON_AUTH_BASE_URL`    | Your branch's Neon Auth URL.                                                  |
| `NEON_AUTH_JWKS_URL`    | Its Auth JWKS URL, usually the Auth URL followed by `/.well-known/jwks.json`. |
| `NEON_REALTIME_URL`     | Your branch's Realtime WebSocket URL.                                         |
| `NEON_REALTIME_SECRET`  | Your branch's Realtime signing secret.                                        |
| `OAUTH_SECRET`          | A random secret of at least 32 characters for the agent OAuth provider.       |
| `APP_ORIGIN`            | `http://localhost:5180`                                                       |
| `API_BASE_URL`          | `http://localhost:3080`                                                       |

Keep `PUBLIC_API_BASE_URL` empty to use Vite's local API proxy. Server credentials stay in `.env.local`; the next command generates browser configuration containing only public URLs.

Apply the schema and start the app:

```sh
npm run env:public
npm run db:migrate
npm run dev
```

Open [localhost:5180](http://localhost:5180). The API runs locally on port 3080. Sign in, create a document and open it in a second window to try collaboration. Use **Markdown source** in the document menu to view the current Markdown, or **Export Markdown** to download it.
