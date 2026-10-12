import { openDB } from "idb";
import * as Y from "yjs";
import { encodeBase64 } from "../shared/codec";
export interface Batch {
  id: string;
  update: string;
}
export interface Journal {
  state: Uint8Array;
  pending: Batch[];
  inflight: Batch | null;
}
export const database = openDB("margin-local", 1, {
  upgrade(db) {
    db.createObjectStore("documents");
  },
});
export class LocalJournal {
  constructor(public key: string) {}
  async load(): Promise<Journal | undefined> {
    return (await database).get("documents", this.key);
  }
  async append(state: Uint8Array, update?: Uint8Array) {
    const db = await database,
      tx = db.transaction("documents", "readwrite");
    const record: Journal = (await tx.store.get(this.key)) ?? {
      state,
      pending: [],
      inflight: null,
    };
    record.state = state;
    if (update)
      record.pending.push({
        id: crypto.randomUUID(),
        update: encodeBase64(update),
      });
    await tx.store.put(record, this.key);
    await tx.done;
  }
  async freeze(): Promise<Batch | null> {
    const db = await database,
      tx = db.transaction("documents", "readwrite");
    const record: Journal | undefined = await tx.store.get(this.key);
    if (!record) {
      await tx.done;
      return null;
    }
    if (!record.inflight && record.pending.length) {
      const bytes = record.pending.map((b) =>
        Uint8Array.from(atob(b.update), (c) => c.charCodeAt(0)),
      );
      record.inflight = {
        id: crypto.randomUUID(),
        update: encodeBase64(Y.mergeUpdates(bytes)),
      };
      record.pending = [];
      await tx.store.put(record, this.key);
    }
    await tx.done;
    return record.inflight;
  }
  async acknowledge(id: string) {
    const db = await database,
      tx = db.transaction("documents", "readwrite"),
      record: Journal = await tx.store.get(this.key);
    if (record?.inflight?.id === id) {
      record.inflight = null;
      await tx.store.put(record, this.key);
    }
    await tx.done;
  }
  async recover(oldId: string, update: Uint8Array, consumed: string[]) {
    const db = await database,
      tx = db.transaction("documents", "readwrite"),
      record: Journal = await tx.store.get(this.key);
    if (record?.inflight?.id === oldId) {
      record.inflight = {
        id: crypto.randomUUID(),
        update: encodeBase64(update),
      };
      record.pending = record.pending.filter((b) => !consumed.includes(b.id));
      await tx.store.put(record, this.key);
    }
    await tx.done;
  }
}
