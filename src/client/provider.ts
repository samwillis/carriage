import * as Y from "yjs";
import { createRealtimeClient } from "@neon/realtime/client";
import { api, post, ApiError, type Session } from "./api";
import { LocalJournal } from "./journal";
import { PresenceAwareness } from "./presence";
import { decodeBase64, encodeBase64, renderDocument } from "../shared/codec";
import {
  SCHEMA_VERSION,
  LIMITS,
  type Bootstrap,
  type DocumentInfo,
  type Presence,
} from "../shared/contracts";
const REMOTE = Symbol("remote");
export interface SyncState {
  ready: boolean;
  status: string;
  pending: number;
  document: DocumentInfo | null;
  presence: Presence[];
  error: string | null;
  paused: boolean;
}
export class DocumentProvider {
  doc = new Y.Doc();
  journal: LocalJournal;
  sessionId = crypto.randomUUID();
  presence: PresenceAwareness;
  state: SyncState = {
    ready: false,
    status: "Connecting",
    pending: 0,
    document: null,
    presence: [],
    error: null,
    paused: false,
  };
  private listeners = new Set<() => void>();
  private closed = false;
  private saving = false;
  private hydrated = false;
  private persistence = Promise.resolve();
  private client: ReturnType<typeof createRealtimeClient> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private editedAt = 0;
  private serverOffset = 0;
  private presenceTimer: ReturnType<typeof setTimeout> | undefined;
  private presenceSending = false;
  private presenceAgain = false;
  private presenceLastSent = 0;
  private presenceSequence = 0;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;
  private publish(patch: Partial<SyncState>) {
    if (this.closed) return;
    if (patch.presence)
      this.presence.sync(patch.presence, Date.now() + this.serverOffset);
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  constructor(
    public id: string,
    public session: Session,
  ) {
    this.presence = new PresenceAwareness(
      this.doc,
      this.sessionId,
      session.userId,
      session.name,
    );
    this.presence.awareness.on("change", this.awarenessChanged);
    this.journal = new LocalJournal(
      `${session.userId}:${id}:${SCHEMA_VERSION}`,
    );
    this.doc.on("update", this.changed);
  }
  private changed = (update: Uint8Array, origin: unknown) => {
    if (this.closed || !this.hydrated) return;
    const state = Y.encodeStateAsUpdate(this.doc),
      local = origin !== REMOTE;
    if (local) {
      this.editedAt = Date.now();
      this.publish({ status: "Saving locally" });
    }
    this.persistence = this.persistence
      .then(async () => {
        await this.journal.append(state, local ? update : undefined);
        await this.count();
      })
      .catch((error) =>
        this.pause(
          `Local storage failed: ${String(error)}. Export your document before leaving.`,
        ),
      );
    if (local) this.scheduleFlush(180);
  };
  private async count() {
    const record = await this.journal.load();
    const pending = (record?.pending.length ?? 0) + (record?.inflight ? 1 : 0);
    this.publish({
      pending,
      status: this.state.paused
        ? "Paused"
        : !navigator.onLine
          ? "Offline"
          : pending
            ? "Saving…"
            : "Saved",
    });
  }
  private pause(error: string) {
    this.publish({ paused: true, error, status: "Paused", presence: [] });
    this.client?.close();
  }
  async start() {
    try {
      const saved = await this.journal.load();
      if (this.closed) return;
      if (saved) {
        Y.applyUpdate(this.doc, saved.state, REMOTE);
        for (const batch of [
          ...(saved.inflight ? [saved.inflight] : []),
          ...saved.pending,
        ])
          Y.applyUpdate(this.doc, decodeBase64(batch.update), REMOTE);
      }
      await this.connect();
      if (this.closed) return;
      this.timer = setInterval(() => {
        void this.heartbeat();
        void this.flush();
        this.publish({
          presence: this.state.presence.filter(
            (p) =>
              new Date(p.expires_at).getTime() > Date.now() + this.serverOffset,
          ),
        });
      }, 15_000);
      window.addEventListener("online", this.online);
      window.addEventListener("offline", this.offline);
    } catch (error) {
      if (!this.closed) {
        if (
          error instanceof ApiError &&
          [401, 403, 404].includes(error.status)
        ) {
          this.pause(error.message);
          return;
        }
        this.publish({ error: String(error), status: "Connecting" });
        this.retryTimer = setTimeout(() => void this.start(), 3000);
      }
    }
  }
  private online = () => {
    void this.heartbeat();
    void this.flush();
  };
  private offline = () => this.publish({ status: "Offline" });
  private async connect() {
    this.client?.close();
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    const config = await api("/api/config");
    const sealed = await api(`/api/documents/${this.id}/live`, this.session);
    if (this.closed) return;
    this.client = createRealtimeClient({
      url: config.realtimeUrl,
      logLevel: "warn",
    });
    const subscriptions = ["snapshots", "updates", "metadata", "presence"].map(
      (key) => ({
        key,
        sub:
          key === "updates"
            ? this.client!.subscribe<any>(sealed[key], { materialize: false })
            : this.client!.subscribe<any>(sealed[key]),
      }),
    );
    let bootstrapRunning = false,
      bootstrapAgain = false,
      initial = true,
      generation = 0;
    const statuses = new Map<string, string>();
    let bootstrapRetry: ReturnType<typeof setTimeout> | undefined;
    this.cleanups.push(() => clearTimeout(bootstrapRetry));
    const hydrate = async () => {
      if (this.closed || this.state.paused) return;
      clearTimeout(bootstrapRetry);
      if (bootstrapRunning) {
        bootstrapAgain = true;
        return;
      }
      bootstrapRunning = true;
      const startedGeneration = generation;
      try {
        const boot = await api<Bootstrap>(
          `/api/documents/${this.id}/bootstrap`,
          this.session,
        );
        if (this.closed || this.state.paused) return;
        if (generation !== startedGeneration) {
          bootstrapAgain = ["snapshots", "updates", "metadata"].every(
            (k) => statuses.get(k) === "live",
          );
          return;
        }
        if (boot.document.schema_version !== SCHEMA_VERSION)
          throw new ApiError(
            409,
            "schema_mismatch",
            "This document needs a newer editor. Export a recovery file before changing versions.",
          );
        if (
          boot.tail.length !==
          boot.document.head - boot.document.snapshot_revision
        )
          throw new Error("Document tail is incomplete.");
        this.serverOffset = boot.server_time - Date.now();
        Y.applyUpdate(this.doc, decodeBase64(boot.snapshot), REMOTE);
        for (const row of boot.tail)
          Y.applyUpdate(this.doc, decodeBase64(row.update), REMOTE);
        if (this.doc.store.pendingStructs || this.doc.store.pendingDs)
          throw new Error("Document is waiting for missing edits.");
        renderDocument(this.doc);
        this.hydrated = true;
        await this.journal.append(Y.encodeStateAsUpdate(this.doc));
        if (this.closed || this.state.paused) return;
        if (generation !== startedGeneration) {
          bootstrapAgain = ["snapshots", "updates", "metadata"].every(
            (k) => statuses.get(k) === "live",
          );
          return;
        }
        const latest = this.state.document;
        this.publish({
          ready: true,
          document:
            latest && latest.head >= boot.document.head
              ? { ...boot.document, ...latest }
              : boot.document,
          error: null,
        });
        initial = false;
        await this.count();
        void this.heartbeat();
        void this.flush();
      } catch (error) {
        if (
          error instanceof ApiError &&
          [401, 403, 404, 409].includes(error.status) &&
          !error.retryable
        )
          this.pause(error.message);
        else {
          this.publish({ error: String(error), status: "Reconnecting" });
          bootstrapRetry = setTimeout(() => void hydrate(), 1500);
        }
      } finally {
        bootstrapRunning = false;
        if (bootstrapAgain) {
          bootstrapAgain = false;
          void hydrate();
        }
      }
    };
    for (const { key, sub } of subscriptions) {
      if (key !== "presence")
        sub.onReset(() => {
          generation++;
        });
      if (key === "updates") {
        sub.onReset((rows) => {
          for (const item of rows)
            Y.applyUpdate(this.doc, item.row.update, REMOTE);
        });
        sub.onBatch((changes) => {
          for (const change of changes)
            if (change.type === "upsert")
              Y.applyUpdate(this.doc, change.row.update, REMOTE);
        });
      }
      const receive = (change: any) => {
        if (this.closed) return;
        const previous = statuses.get(key);
        statuses.set(key, change.status);
        if (
          key !== "presence" &&
          change.status === "stale" &&
          previous !== "stale"
        )
          generation++;
        if (change.status === "error")
          this.publish({
            error: `${key}: ${change.error?.message ?? "Live query failed"}`,
            status: "Live query unavailable",
          });
        if (change.error) {
          this.publish({
            error: change.error.message ?? "Live connection interrupted",
            status: "Reconnecting",
          });
        }
        if (change.status === "live" && change.data) {
          if (key === "snapshots")
            for (const row of change.data)
              Y.applyUpdate(this.doc, row.state, REMOTE);
          if (key === "metadata") {
            if (!change.data.length) {
              this.pause(
                "Document access was removed. Your local edits remain available to export.",
              );
              return;
            }
            this.publish({
              document: {
                ...this.state.document,
                ...change.data[0],
              } as DocumentInfo,
            });
          }
          if (key === "presence")
            this.publish({
              presence: change.data.filter(
                (p: Presence) =>
                  new Date(p.expires_at).getTime() >
                  Date.now() + this.serverOffset,
              ),
            });
        }
        if (
          key !== "presence" &&
          change.status === "live" &&
          ["snapshots", "updates", "metadata"].every(
            (k) => statuses.get(k) === "live",
          ) &&
          (initial || previous !== "live")
        )
          void hydrate();
        if (key !== "presence" && change.status === "stale")
          this.publish({ status: "Reconnecting" });
      };
      if (key !== "updates")
        (
          sub as import("@neon/realtime/client").MaterializedLiveQuerySubscription<any>
        ).onChange(receive);
      else sub.onStateChange(receive);
    }
    // Renew the four capabilities together. Resubscription installs fresh baselines;
    // hydration closes any gap while retaining the local replica and durable queue.
    const refresh = setInterval(() => {
      if (this.closed || this.state.paused) return;
      void api(`/api/documents/${this.id}/live`, this.session)
        .then(async (next) => {
          await Promise.all(
            subscriptions.map(({ key, sub }) => sub.renew(next[key])),
          );
        })
        .catch((error) => {
          if (
            error instanceof ApiError &&
            [401, 403, 404].includes(error.status)
          )
            this.pause(error.message);
          else this.publish({ status: "Reconnecting" });
        });
    }, 60_000);
    this.cleanups.push(() => clearInterval(refresh));
  }
  private cleanups: (() => void)[] = [];
  private scheduleFlush(ms = 1500) {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.flush(), ms);
  }
  async flush() {
    if (
      this.closed ||
      this.state.paused ||
      !this.hydrated ||
      this.saving ||
      !navigator.onLine
    )
      return;
    this.saving = true;
    let retry = false;
    try {
      await this.persistence;
      let batch;
      try {
        batch = await this.journal.freeze();
      } catch (error) {
        this.pause(
          `Local storage failed: ${String(error)}. Export your recovery file before leaving.`,
        );
        return;
      }
      if (!batch) return;
      if (decodeBase64(batch.update).length > LIMITS.updateBytes) {
        this.pause(
          "Your pending batch exceeds the demo limit. Export it before continuing.",
        );
        return;
      }
      try {
        await api(
          `/api/documents/${this.id}/updates`,
          this.session,
          post({ request_id: batch.id, update: batch.update }),
        );
        await this.journal.acknowledge(batch.id);
        await this.count();
        retry = true;
      } catch (error) {
        if (error instanceof ApiError && error.code === "missing_dependency") {
          const boot = await api<Bootstrap>(
              `/api/documents/${this.id}/bootstrap`,
              this.session,
            ),
            base = new Y.Doc();
          try {
            Y.applyUpdate(base, decodeBase64(boot.snapshot));
            for (const row of boot.tail)
              Y.applyUpdate(base, decodeBase64(row.update));
            await this.persistence;
            const record = await this.journal.load();
            const recovery = Y.encodeStateAsUpdate(
              this.doc,
              Y.encodeStateVector(base),
            );
            await this.journal.recover(
              batch.id,
              recovery,
              record?.pending.map((b) => b.id) ?? [],
            );
            retry = true;
          } finally {
            base.destroy();
          }
        } else if (
          error instanceof ApiError &&
          !error.retryable &&
          ![401, 429].includes(error.status)
        )
          this.pause(
            `${error.message} Your local work is preserved; export it before starting a fresh copy.`,
          );
        else {
          retry = true;
          this.publish({
            status: navigator.onLine ? "Reconnecting" : "Offline",
            error:
              error instanceof Error ? error.message : "Connection interrupted",
          });
        }
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        !error.retryable &&
        [403, 404].includes(error.status)
      )
        this.pause(error.message);
      else {
        retry = true;
        this.publish({
          status: "Reconnecting",
          error:
            error instanceof Error ? error.message : "Recovery will retry.",
        });
      }
    } finally {
      this.saving = false;
      if (retry && !this.closed) this.scheduleFlush();
    }
  }
  private awarenessChanged = (change: {
    added: number[];
    updated: number[];
    removed: number[];
  }) => {
    if (
      [...change.added, ...change.updated, ...change.removed].includes(
        this.doc.clientID,
      )
    )
      this.schedulePresence();
  };
  private schedulePresence() {
    if (this.closed || this.state.paused || this.presenceTimer) return;
    this.presenceTimer = setTimeout(
      () => {
        this.presenceTimer = undefined;
        void this.heartbeat();
      },
      Math.max(0, 250 - (Date.now() - this.presenceLastSent)),
    );
  }
  private async heartbeat() {
    if (this.closed || this.state.paused || !this.hydrated || !navigator.onLine)
      return;
    if (this.presenceSending) {
      this.presenceAgain = true;
      return;
    }
    this.presenceSending = true;
    this.presenceLastSent = Date.now();
    try {
      const result = await api(
        `/api/documents/${this.id}/presence`,
        this.session,
        post({
          session_id: this.sessionId,
          activity: Date.now() - this.editedAt < 10_000 ? "Editing" : "Viewing",
          cursor: this.presence.cursor(),
          sequence: ++this.presenceSequence,
        }),
      );
      this.serverOffset = result.server_time - Date.now();
    } catch {
      /* Next heartbeat retries. */
    } finally {
      this.presenceSending = false;
      if (this.presenceAgain) {
        this.presenceAgain = false;
        this.schedulePresence();
      }
    }
  }
  close() {
    this.closed = true;
    this.client?.close();
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    clearTimeout(this.presenceTimer);
    this.presence.awareness.off("change", this.awarenessChanged);
    this.presence.destroy();
    for (const fn of this.cleanups) fn();
    window.removeEventListener("online", this.online);
    window.removeEventListener("offline", this.offline);
    this.doc.off("update", this.changed);
    this.listeners.clear();
  }
  async recoveryExport() {
    await this.persistence;
    const journal = await this.journal.load();
    return {
      document_id: this.id,
      user_id: this.session.userId,
      schema_version: SCHEMA_VERSION,
      replica: encodeBase64(Y.encodeStateAsUpdate(this.doc)),
      journal: journal
        ? { ...journal, state: encodeBase64(journal.state) }
        : null,
    };
  }
}
