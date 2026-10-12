# Collaborative Markdown editor for Neon Realtime

Status: implemented launch demo, 12 October 2026. Core flows are verified on Neon staging. This document records the design; README.md contains the current setup and operating limits.

## Outcome

Demonstrate people and external agents editing the same private Markdown document. Postgres stores every accepted Yjs update; Neon Realtime delivers changes; Neon Functions serves the API, MCP, OAuth, and compaction; Neon Auth identifies users.

The demo must show concurrent edits, durable saves, reconnect recovery, access control, and compaction while editing continues. Both CLI agents using scoped bearer tokens and hosted MCP clients using OAuth are in scope.

## Proposed stack and scope

- React and Vite frontend, hosted separately from Neon Functions.
- Milkdown with CommonMark/GFM and its Yjs collaboration plugin.
- A custom Neon-backed Yjs provider using the supported Realtime SDK.
- Hono on Neon Functions, with a module-scope `pg` pool and a shared document service.
- Version-compatible, pinned Milkdown, Yjs, y-prosemirror, MCP, and Neon packages.
- A dedicated PG18 Neon project. `aws-eu-central-1` is the proposed region, subject to confirming the launch service availability and account.

Initial product scope: document creation and sharing, owner/editor/viewer roles, collaborative editing, a read-only Markdown source view, people/agent presence, agent connection controls, and a collapsible developer inspector.

Milkdown is a formatted Markdown editor. Exported Markdown may normalize source syntax. Exact source formatting, simultaneously editable raw Markdown, version-history UI, and high-frequency remote cursors are outside the initial scope.

## Core invariants

1. The persisted Yjs state is authoritative; Markdown is a derived projection.
2. Every accepted content mutation inserts an update through the same document service, including MCP mutations.
3. Document revisions are allocated under a short per-document row lock. Sequence allocation alone does not establish commit order. Compaction advances a separate snapshot revision without incrementing the content head.
4. A snapshot and its Markdown describe the same snapshot revision. Current reads reconstruct any newer tail.
5. Compaction preserves the accepted Yjs identities and causal state; it never reconstructs a document from Markdown. Removing transport-log rows never removes editor content.
6. Expensive decoding, parsing, transformation, and serialization happen outside the document write lock.
7. Reusable caches contain committed state. Speculative edits use disposable drafts.
8. Authorization is checked on every tool/write request, including receipt replay, and included in live-query predicates. Commit-time checks serialize with access changes.
9. Browser updates are validated against committed state before acceptance. Readers and validators never repair or mutate reusable caches.
10. Only a committed receipt resolves an uncertain write outcome. A terminally rejected local replica cannot continue uploading dependent edits.

## Data model

| Relation             | Responsibilities                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `documents`          | Title, schema version, committed head, snapshot revision, pending count/bytes/age, compaction claim state                               |
| `document_members`   | User access with owner/editor/viewer roles                                                                                              |
| `document_invites`   | Application-level invite links, allowed role, expiry, revocation, and authenticated acceptance                                          |
| `document_snapshots` | One encoded Yjs state in `bytea`, Markdown, revision, and schema version per document                                                   |
| `document_updates`   | Document revision, immutable mutation ID, binary update, actor/delegating user, and timestamps                                          |
| `write_receipts`     | Document/principal/request identity, canonical request hash, original committed result, retained independently of compacted update rows |
| `document_presence`  | One leased record per browser tab or agent session                                                                                      |
| `agent_grants`       | Approved documents, operation scopes, delegating user, expiry, and revocation                                                           |
| OAuth storage        | Clients, consent, codes, access/refresh credentials as required by the selected provider                                                |

Use primary keys and appropriate document/revision indexes. Keep snapshot blobs separate from frequently changing head/counter metadata. Store hashes of opaque credentials. Define update, document, bootstrap, and request limits during validation; supported fixtures must fit the pinned SDK's baseline/publication limits.

Sharing uses application-level invite links for editor/viewer roles, with expiry, owner revocation, and authenticated acceptance. No outbound email service is needed for the demo. Membership and invitation changes use the same document lock as content writes.

### Shared write admission and retry contract

Receipts are unique by document, stable authenticated principal, and request ID. Browser requests hash their frozen update bytes and relevant metadata. MCP requests hash canonical logical tool input, including references and preconditions; regenerated draft bytes are not the request identity. Refreshing a credential does not change the grant's stable principal.

After checking current access, consult receipts before evaluating old preconditions or preparing an edit. Repeat the lookup inside the commit transaction. A matching successful receipt returns the original result; reuse with different input fails. Keep receipts for the lifetime of the demo's documents so late offline retries remain defined. Resolve uncertain outcomes using the same request ID or an authorized receipt lookup, never a newly generated ID. An absent receipt alone does not prove that an in-flight attempt cannot still commit.

Browser binary updates use a disposable copy of consistent committed state for bounded decoding and shared-root/schema validation. Check the resulting structure and detect conversion-time repair, rather than trusting a supplied schema version or successful binary decoding alone. Perform preparation outside the write lock, then append only if the validated head remains current. Retry bounded contention as described for agent writes below.

The browser sends causally complete batches in sequence. Detect unresolved dependencies and return a distinct missing-dependency result; do not persist them as validated complete editor state. Recover by reconciling committed state and pending predecessors, without discarding dependent work. If a predecessor request cannot be restored but its causal state survives locally, resolve uncertain requests first, then create a separately identified, immutable recovery batch from the surviving local state against a fresh committed replica's state vector. Submit it through the same validation path before retrying dependent requests unchanged. Do this only when no terminal rejection occurred and the recovery batch fits the limits; otherwise preserve/export work and use fresh-replica recovery. Never change bytes under an existing request ID. Even a binary update with no visible Markdown change may carry required causal state and must be persisted if accepted.

## Realtime and browser provider

Use separate snapshot, outstanding-update, head/metadata, and presence queries on one client. Live queries have stable document/access parameters and contain neither `UNION ALL` nor `ORDER BY`. Yjs does not require ordered update delivery.

Use raw update delivery to avoid rebuilding a complete binary-row array on every change. Materialized snapshot/head subscriptions are useful for reading the SDK's already-installed cross-query state. Buffer callback delivery as necessary to apply an editor transaction coherently; an application-owned raw map is not automatically installed by the SDK before another raw callback.

Bootstrap and reconnect protocol:

1. Attach content subscriptions and buffer snapshot/update bytes. A new updates baseline or an authoritative reset/reconnect of either content subscription starts a hydration generation and invalidates earlier in-flight HTTP bootstrap results. Initial snapshot callbacks join the current generation rather than repeatedly restarting it.
2. Once the updates subscription is live, request `{snapshot, tail, head, schema_version}` from the primary database through Functions using one database snapshot: one statement or a `REPEATABLE READ` transaction.
3. Apply the result only if its generation is still current and the updates subscription remains live. Merge the bootstrap and buffered bytes into the existing local Yjs document, then mark that generation hydrated.
4. Consume snapshot resets/upserts and update-log resets/upserts as encoded Yjs updates with a remote origin. Treat log removals as transport cleanup. Initial snapshot callbacks must not repeatedly restart the hydration generation.
5. Repeat after authoritative reset/reconnect, preserving pending edits. Enable first-time editing only after initial hydration and verified edit access; a head metadata row alone is not proof that content is current. Track the health of both content subscriptions. A failed or stale snapshot stream must not leave the provider claiming current merely because the updates stream is live; restore the streams and hydrate, or explicitly repair through a consistent API load.

This handles independent initial query baselines as well as transactional steady-state publication. The same consistent-load operation serves MCP and compaction.

Observe local Yjs updates, coalesce briefly, and upload through authenticated Functions endpoints. Start with approximately 100 ms batching and tune from measurements. Freeze each batch's bytes when assigning its mutation ID; later edits belong to another batch. Upload sequentially per session, retry with the original ID and bytes, and tag remote application with an origin that prevents upload loops.

Persist local state and pending writes for reload/offline recovery, namespaced by authenticated user, document, and schema version. Journal local updates and frozen request envelopes durably before transmission; derive restored pending batches from that journal rather than independently persisted replica/outbox guesses. Keep one upload attempt in flight; send ordinary descendants only after predecessor commits are confirmed. A definite rejection enters the relevant recovery path, while an unknown outcome is retried or resolved under its original ID. Restore/reconcile the queue before permitting new edits after reload. A save acknowledgement means the insert committed. Show pending/offline status separately from Realtime connection status. Renew sealed capabilities before their current 60-second expiry. Logout or identity changes must not replay a previous user's queue.

Distinguish transient failures and unknown commit outcomes from terminal access/schema/size rejection. For terminal rejection, pause uploads and editing from that replica, preserve/export its unsaved content, resolve any uncertain receipts, and recover from committed state using a fresh local client ID. Never drop one rejected update and continue uploading its descendants, or merge the rejected replica into the recovered authoritative state. Reapply preserved work only as newly validated edits when access permits.

An empty access-filtered result must be confirmed through the API as access loss or deletion; it is not a new empty document. Stop fetching and editing on confirmed access loss and retain private offline state only according to the recovery/logout policy.

Initialize a document once on the server; reconnecting clients must not independently insert templates.

## Write-driven compaction

The append transaction checks configurable count/byte thresholds and, optionally, pending age. Proposed initial thresholds are 200 updates or 256 KiB; these are tuning values. Age is checked by document writes rather than a required periodic compactor, so it is not a wall-clock cleanup guarantee. Record pending age from the oldest outstanding committed update using database time.

If eligible and no valid worker lease exists, the write transaction claims a fixed batch with:

- monotonically increasing `compaction_epoch`;
- source snapshot revision;
- fixed cutoff at the committed head including this write;
- lease expiry using database time.

Register the claimed task with `waitUntil` immediately after a confirmed commit and before returning the write acknowledgement. Compaction failure must not turn a committed append into an apparent failed write; the receipt and lease make either outcome recoverable.

The worker copies the claimed snapshot and updates through the cutoff consistently, then reconstructs Yjs and renders Markdown outside the write lock. New edits receive revisions above the cutoff and continue normally. The worker renews its lease conditionally if needed.

Publication takes a short document-row lock and verifies the epoch, valid lease, and unchanged source snapshot revision. Check lease validity using database wall-clock time after acquiring the lock, rather than transaction-start time. In one transaction it publishes the new encoded state and Markdown, advances the snapshot revision, removes only incorporated updates, subtracts their actual count/bytes, recomputes pending age from the retained tail, and releases the claim. The content head is unchanged. Lease renewal, release, and failure cleanup must all match the current epoch.

Allow bounded subsequent passes if the residual tail is still eligible. Reclaim expired work on subsequent writes. An obsolete worker must never publish or clear a newer worker's claim.

Failure before publication leaves the old snapshot and tail intact. Failed decoding or rendering must not prune updates. `waitUntil` is not durable job delivery: after a worker crash following the final write, recovery can wait until the next write. Add durable delivery/recovery only if prompt idle cleanup becomes an acceptance requirement.

Use full encoded state updates for persisted snapshots, not `Y.snapshot()`. Binary merging alone does not produce Markdown or garbage-collect the document.

## Efficient agent editing

| Tool              | Contract                                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_documents`  | Find accessible documents by title, returning paginated metadata and current roles without document bodies.                                                                                                                       |
| `create_document` | Create a document owned by the account with optional Markdown. A durable request receipt and advisory lock deduplicate concurrent retries.                                                                                        |
| `read_document`   | Return full Markdown, outline, or selected blocks, with durable revision, schema version, opaque references, and hashes. Support an unchanged response when the caller already has the current revision.                          |
| `edit_document`   | Apply an atomic batch of text replacements, block replacements, insertions, or deletions with request ID and operation-specific preconditions. Distinguish target conflict, retryable contention, invalid input, and access loss. |
| `write_document`  | Whole-document Markdown replacement with a required unchanged document revision.                                                                                                                                                  |

Prefer outline/section reads and narrow edits. Sentence edits guard the selected text and relevant formatting/context; block replacements guard the whole block. Retry disjoint changes internally when practical, while keeping total retries/time bounded; sustained unrelated typing can still cause retryable contention. Preconditions protect committed state. Browser edits that have not reached Postgres can later merge according to Yjs rules, including after a full replacement.

Opaque references use public Yjs relative-position mechanisms anchored inside the actual block element. Bind them to their document/schema. Resolution must verify membership in the current document tree and expected content/type. Deleted or structurally replaced targets return a conflict rather than silently resolving to neighbouring text. Numeric ProseMirror or Markdown offsets remain internal.

Batch references and preconditions refer to the starting committed state. Preflight all targets, reject overlapping edits or operations that remove another operation's target, then map the validated transforms through earlier steps in a deterministic order. Define ordering for multiple insertions at one anchor. A failed operation rejects the whole batch.

Mutation algorithm:

1. Authenticate and check current access and existing receipts before obtaining committed state at head `H`.
2. Validate schema compatibility, resolve references, and preflight the entire operation batch. Validate any required document revision before treating a request as unchanged.
3. Build a disposable Yjs draft preserving the existing CRDT identities.
4. Apply ProseMirror transforms and reconcile each small operation separately inside one outer Yjs transaction. Parse replacement Markdown only where needed.
5. Capture the transaction's emitted update bytes.
6. In a short append transaction, acquire the authorization locks, recheck current access and receipts, and verify the durable head still equals `H`. Insert the update, original result receipt, and audit metadata and check compaction eligibility.
7. If the head advanced, discard the draft, catch up, and retry with bounded time/attempts and backoff while scoped preconditions hold. Return a target conflict if the target changed, or retryable contention if safe retries are exhausted. Full replacement never rebases.
8. Merge the generated bytes into a reusable cache only after successful persistence.

Reconcile small text operations individually because a single prefix/suffix diff for two distant paragraph edits can delete/reinsert the unchanged middle. Detect semantically unchanged tool requests before mutating Yjs; under the same access/head checks, store an unchanged receipt without an empty update, content revision, or compaction-counter increment. This optimization does not discard browser binary updates carrying causal state.

Create a versioned browser/server schema and Markdown codec module. Isolate unstable y-prosemirror reconciliation exports in an adapter. Perform projection/validation on disposable copies and detect conversion-time repair mutations; conversion must never corrupt a committed cache. Reject unsupported Markdown rather than silently dropping requested content. Parse completion alone does not establish that all requested structure was represented.

Use a bounded isolate-local cache of committed Yjs documents and projections. Serialize per-document cache hydration/publication or use immutable versioned entries. Pin an exact-`H` disposable state for each request, never regress a cache's revision, and advance its recorded head only when all committed state through that head is present; merging just the request's own update is insufficient if intervening writes are missing. Check the durable head and current access per request; fetch only missing updates, or the latest snapshot/tail if compaction removed the needed rows. Use durable revision, not state-vector equality, for freshness because delete-only changes are not captured by vector equality.

Draft creation and projection may remain linear in document size. Accept that for bounded demo documents first, and measure before optimizing. Selected reads reduce model context; they do not make arbitrary binary updates selectively loadable by section. Return changed-block previews after edits rather than serializing the whole document again.

## Human and agent authorization

Use Neon Auth for human login and verify its JWTs in Functions. Store document membership in application tables. Include membership in sealed live queries so access changes affect their results. Use MCP Streamable HTTP with request-scoped identity and stateless request handling; the selected adapter must work across Function isolates without in-memory session affinity.

Provide both agent connection paths:

- CLI: the signed-in user approves a revocable account bearer grant with read/edit/write/create scopes. Intersect document operations with current membership on every request. Existing document-scoped grants retain their restriction until explicitly replaced.
- Hosted MCP client: a maintained OAuth authorization-server implementation hosted on Functions uses Neon Auth in its login/consent interaction and issues resource-bound MCP credentials. Support the discovery/registration flow required by the chosen client, PKCE, token expiry/refresh, and revocation.

Managed Neon Auth does not itself provide the full external-client MCP OAuth flow. Verify a maintained provider with a compatible Fetch adapter and custom login/consent integration. The gate must exercise login/consent across the frontend, Neon Auth, and Functions origins, followed by a real hosted-client tool call and refresh/revocation. A copied human session JWT is not the hosted client's MCP credential. Store both the agent/client and authorizing human in mutation audit records.

Both paths resolve through the same grants and permission checks. Tokens bind to the intended MCP resource, approved account grant, client and scopes. Account grants cover current and future accessible documents; membership remains the per-document boundary. Tool handlers never trust request-supplied ownership or a mutable global current-user variable. Agent grants initially authorize MCP routes; they must not bypass tool scopes through generic browser update/sealing endpoints.

Serialize membership changes with the document row lock. Agent append transactions also lock/check their grant through commit; revocation takes a conflicting grant lock. Use document-then-grant order whenever an existing document is involved. Creation acquires a request advisory lock and the account grant lock, then inserts a new document; it never locks another existing document. Define authorization at this commit boundary: operations ordered after revocation fail, while already-committed data cannot be recalled. Read results are scoped to their authorized database snapshot.

After acquiring authorization locks, recheck grant and presented credential expiry using current database wall-clock time, not transaction-start `now()`. This final locked authorization check defines write admission; expired credentials cannot append or replay receipts. Receipt-only fast paths and reads also require valid credentials at their authorization check.

## Presence and demo interface

Presence uses one row per browser tab or agent session, with authenticated actor information, activity, and server-issued expiry. Proposed starting values: a 15-second browser heartbeat and a 45-second lease. Agent tool calls renew a lease; continuous agent-working status needs explicit heartbeat support.

Live queries select document presence without `now()`. The frontend expires records using server time; backend cleanup removes old rows opportunistically. Presence never enters the document update log. Browser cursors and selections carry Yjs relative positions in the presence row and render through y-prosemirror awareness. Movement is throttled to one request per 250 ms with one request in flight. Monotonic session sequences protect against delayed older writes; server-authenticated labels and session colors identify each browser.

The writing surface includes compact participant avatars, saving/connection status and sharing controls. Share provides the document ID and a document-specific agent prompt, with an MCP setup link. The sidebar manages account agent connections with client-specific token and OAuth guides. The inspector shows head/snapshot revisions, tail rows/bytes, compaction state, and the stored Markdown's revision.

## Implementation sequence and acceptance

### 1. Validate the risky integrations

- Identify and pin a compatible Neon CLI/config/env/Realtime checkout. Verify package and deployed Realtime-secret configuration rather than relying on differing PR descriptions.
- Prove headless schema/codecs, safe browser-update admission, and targeted Yjs editing with paragraphs, marks, links, lists, and GFM blocks.
- Prove separate subscription bootstrap, reconnect, and compaction handover against Realtime.
- Prove scoped-token access and one real hosted MCP client's OAuth flow using Neon Auth login.

Exit: provisioning/configuration, headless editing/admission, Realtime recovery, and both credential paths work with their selected versions. Record the supported document-size/concurrency envelope, remote-edit latency, validation/draft cost, and contention rate. Set performance budgets and limits from these measurements before the main build. Resolve a failed integration before building dependent UI.

### 2. Build the document service and persistence

- Versioned schema/migrations, membership/invites, initial snapshots, consistent loading, validated appends, receipts, and committed revisions.
- Fenced compaction claims and nonblocking worker publication.
- Shared authorization and document service used by HTTP and MCP.

Exit: writes/retries survive restarts and response loss; invalid updates cannot poison a document; writes serialize correctly with revocation; overlapping compaction and edits lose no content; expired workers cannot overwrite newer state; current reads include the tail observed in their database snapshot.

### 3. Build browser collaboration

- Milkdown provider, subscription renewal, local pending-write persistence, hydration generations, and rejected-replica recovery.
- Sharing and roles; read-only source view; saving and connection states.

Exit: two authenticated users edit concurrently, viewers cannot write, local undo behaves correctly, and an offline/reloaded tab reconciles after compaction without duplicate templates or content loss. Stale bootstrap results cannot mark the editor current; rejected or previous-user queues cannot silently resume.

### 4. Complete MCP editing and both connection flows

- Read/edit/write tools, scoped references and conflicts, disposable drafts, bounded cache, and audit records.
- Token-management UI and hosted-client OAuth consent/revocation.

Exit: an agent edits one section while a person edits another; changed/deleted targets conflict cleanly and contention is distinguishable; lost-response retries return the original result; no-op calls leave content revisions unchanged; revoked or cross-document access is denied through every exposed route.

### 5. Finish the launch demo

- Presence, Connect Agent UI, inspector, seeded example document, and setup/run documentation.
- Tune batching and compaction from measurements.
- Validate the demo in its deployed frontend/Functions/Realtime configuration.

Exit: demonstrate two people editing, an agent making a targeted change, compaction while editing continues, offline recovery, and grant revocation. Report remaining limitations and measured performance.

## Required verification cases

- Concurrent appends; lost-response and late offline retries before/after compaction; logical MCP versus binary browser receipt identity; ID reuse with changed input; absent receipts during in-flight attempts; out-of-order delivery and missing causal dependencies; reload between local journaling, batch creation, transmission, and acknowledgement.
- Invalid binary and valid-binary-invalid-schema rejection; causal-state-only updates; terminal rejection with dependent queued edits; previous-user/schema queues and safe recovery/export.
- Worker crashes before publication, lease expiry/reclaim, stale-worker publication/cleanup, newer tail retention, pending-age recomputation, and bounded compaction passes.
- Independent subscription baselines, snapshot resets/upserts, compaction during hydration, reset during an in-flight bootstrap, snapshot-stream failure while updates remain live, access-filtered empty results, and capability renewal.
- Disjoint agent edits under sustained typing versus same-target conflicts; deleted anchors; formatting/type changes; overlapping batch rejection; unchanged-middle identity preservation; atomic failure; full-write conflicts and no-ops.
- Cache eviction, concurrent cache hydration/publication, missing intervening updates after own-write commit, multiple Function isolates, failed/uncertain persistence, delete-only freshness, schema mismatch, and nonmutating projection/repair detection.
- Two-user isolation, viewer enforcement, token/OAuth document and tool scopes, write/revocation ordering, receipt replay after revocation, credential/lease expiry during lock waits, and hosted-client login/consent/refresh across deployment origins.

## Decisions to settle during validation

- Exact compatible dependency revisions and deployed Realtime environment handling.
- OAuth implementation/Fetch adapter and the first hosted client used for acceptance.
- Headless schema construction and the reconciliation adapter's supported operations.
- Measured batching/lease thresholds, document/concurrency limits, contention budgets, and whether idle compaction recovery requires durable delivery.
- Neon organization/project and frontend deployment target when implementation begins.

## Implementation decisions and validation

- The demo is named Carriage. A single Neon Function hosts the built frontend, API, MCP, and OAuth endpoints. Infrastructure is in Sam’s staging organization: PG18, `aws-us-east-2`, project `frosty-hat-96438417`, branch `br-frosty-poetry-w25lx1wr`.
- Preview SDK/CLI packages are pinned to `5e276fdb4114555eac89f6033b15e6ff5e9e7eb4`. Milkdown 7.22.2 and y-prosemirror 1.3.7 supply the browser and headless schema. Collaboration uses Yjs sync/undo plugins directly because this Milkdown kit has no packaged collaboration plugin.
- Live SQL uses four separate unordered ACL queries; all four are accepted by staging Realtime. Bootstrap generation checks prevent a reset during hydration from marking an older response current.
- Text operations require the whole target block’s hash as well as selected text. This guards formatting and context with a stronger precondition than the proposed sentence-only guard. Concurrent changes to another block retry; changes in the same block return a conflict. A mixed-format replacement must be split or use a block replacement.
- Hosted connections use Better Auth OAuth provider 1.7.7, with server-owned default resource links for dynamic clients. Neon login crosses to OAuth with a one-time ticket and top-level navigation. Each new authorization request approves account access again, using a server-owned fingerprint of its client, redirect, scopes, state, resource, and PKCE parameters. Agent access verifies the client's binding to the agent grant; access and refresh both check the live grant. MCP accepts agent credentials; human JWTs are reserved for the app API.
- Presence uses viewer/agent records with 45-second leases, 15-second browser heartbeats, and server-adjusted expiry filtering. Browser cursor and selection updates reuse these records, independent of document updates and compaction. Separate sessions on the same account get their own labeled cursors. A clickable participant list shows typing/idle or recent agent activity and can jump to a selection. Targeted agent reads and edits publish relative selections; completed edits publish presence in the same transaction as the update. Browser exit tombstones prevent older heartbeats from restoring a departed session.
- Write-driven defaults are 200 updates, 256 KiB, or 60 seconds of pending age, with a 30-second renewable fenced lease and three bounded passes. No scheduled idle compaction is required for this demo.
- Fourteen codec/Postgres tests pass, including disjoint CAS races, durable receipts, no-ops, full-write conflicts, deleted anchors, overlap rejection, missing causal predecessors, stale compaction workers, revoked access, and access-token expiry while waiting for a grant lock.
- Four additional cursor tests cover same-account awareness, expiry, older updates, relative anchoring, bounded payloads, and keeping presence out of document history. Deployed browser checks cover both directions, selection anchoring after concurrent insertion, reconnect, blur, different session colors, and rejection of older presence requests.
- Real service checks pass for two browser replicas, closed-window offline recovery, invitations to a second Neon Auth account, read-only viewers, Realtime membership removal, CLI MCP read/edit/write/retry/revocation, and concurrent person/agent edits with local-only undo. OAuth checks cover discovery, dynamic registration, Neon login, consent, PKCE, refresh, MCP read, access/refresh revocation, code replay rejection, and a second client in the same browser receiving its own account approval and correctly named consent.
- A deployed 205-write test compacted through revision 200 and retained five later inserts; the persisted reconstruction and a live Realtime observer both matched the writer. This sequential test took about 38 seconds, including network and database work; it is not a concurrency capacity claim.
- For a 300-paragraph, 53,010-byte Markdown sample (64,803-byte encoded Yjs state), ten local headless samples measured a median 10 ms block read and 5 ms targeted edit. The edit delta was 41 bytes. These measurements exclude database/network time and are a development baseline.

Remaining launch checks: connect the public endpoint from each intended hosted product, decide production abuse limits, and validate capacity beyond the two-user demo. The offline test covers closure before upload and recovery; it does not exhaustively fault-inject every IndexedDB/network boundary. `waitUntil` recovery remains write-driven after a crash.

## References

- [Realtime preview docs](https://neon-next-git-thruflo-realtime-3-integration-neondatabase.vercel.app/docs/realtime/)
- [Milkdown collaboration](https://milkdown.dev/docs/guide/collaborative-editing)
- [Neon Functions authentication and MCP OAuth](https://neon.com/docs/compute/functions/authentication#oauth-and-mcp-clients)
- [Neon SDK PR #799](https://github.com/neondatabase/neon-pkgs/pull/799), [config PR #780](https://github.com/neondatabase/neon-pkgs/pull/780), and [env PR #801](https://github.com/neondatabase/neon-pkgs/pull/801)
- Local examples: `/Users/sam.willis/Code/neon-examples/realtime`
- Local client/CLI source: `/Users/sam.willis/Code/neon-pkgs`
