import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createDocument, encodeBase64 } from "../src/shared/codec";
import { SCHEMA_VERSION } from "../src/shared/contracts";
import { ApiError } from "../src/client/api";
import { DocumentProvider } from "../src/client/provider";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  createClient: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  freeze: vi.fn(),
  acknowledge: vi.fn(),
}));
vi.mock("../src/client/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
}));
vi.mock("@neon/realtime/client", () => ({
  createRealtimeClient: mocks.createClient,
}));
vi.mock("../src/client/journal", () => ({
  LocalJournal: class {
    load = mocks.load;
    append = mocks.append;
    freeze = mocks.freeze;
    acknowledge = mocks.acknowledge;
  },
}));

class Subscription {
  receive: (change: any) => void = () => {};
  resets: ((rows: any[]) => void)[] = [];
  onChange = (fn: typeof this.receive) => {
    this.receive = fn;
  };
  onStateChange = this.onChange;
  onReset = (fn: (rows: any[]) => void) => {
    this.resets.push(fn);
  };
  onBatch = () => {};
  renew = vi.fn(async () => {});
  emit(status: string, data?: any[]) {
    this.receive({ status, data });
  }
}
let provider: DocumentProvider;
let logger: (entry: any) => void;
let subscriptions: Map<string, Subscription>;
let boot: any;
const keys = ["snapshots", "updates", "metadata", "presence"];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function live(key: string) {
  subscriptions
    .get(key)!
    .emit("live", key === "metadata" ? [boot.document] : []);
}
async function start() {
  await provider.start();
  keys.forEach(live);
  await settle();
  expect(provider.state.ready).toBe(true);
  expect(provider.state.status).toBe("Saved");
}
const calls = (suffix: string) =>
  mocks.api.mock.calls.filter(([path]) => path.endsWith(suffix)).length;
function editLocally() {
  const paragraph = provider.doc
    .getXmlFragment("prosemirror")
    .get(1) as Y.XmlElement;
  (paragraph.get(0) as Y.XmlText).insert(0, "Edited ");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const doc = createDocument("# Status test\n\nA paragraph.");
  boot = {
    document: {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Test",
      role: "owner",
      head: 0,
      snapshot_revision: 0,
      schema_version: SCHEMA_VERSION,
    },
    snapshot: encodeBase64(Y.encodeStateAsUpdate(doc)),
    tail: [],
    server_time: Date.now(),
  };
  doc.destroy();
  subscriptions = new Map(keys.map((key) => [key, new Subscription()]));
  mocks.load.mockResolvedValue(undefined);
  mocks.append.mockResolvedValue(undefined);
  mocks.freeze.mockResolvedValue(null);
  mocks.acknowledge.mockResolvedValue(undefined);
  mocks.api.mockImplementation(async (path: string) => {
    if (path === "/api/config") return { realtimeUrl: "wss://example.invalid" };
    if (path.endsWith("/live"))
      return Object.fromEntries(keys.map((key) => [key, key]));
    if (path.endsWith("/bootstrap")) return boot;
    return { server_time: Date.now() };
  });
  mocks.createClient.mockImplementation((options) => {
    logger = options.logger;
    logger({ event: "connection_ready", level: "info" });
    return {
      subscribe: (key: string) => subscriptions.get(key),
      close: vi.fn(),
    };
  });
  provider = new DocumentProvider(boot.document.id, {
    userId: "test-user",
    name: "Writer",
    token: async () => "unused",
  });
});
afterEach(() => {
  provider.close();
  provider.doc.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("document connection and save status", () => {
  it("does not restore departed presence until a page returns from the browser cache", async () => {
    await start();
    const event = (name: string) =>
      vi
        .mocked(window.addEventListener)
        .mock.calls.find(([type]) => type === name)![1] as () => void;
    event("pagehide")();
    await settle();
    const afterLeave = calls("/presence");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls("/presence")).toBe(afterLeave);
    event("pageshow")();
    await vi.advanceTimersByTimeAsync(250);
    expect(calls("/presence")).toBe(afterLeave + 1);
  });
  it("reports typing promptly, clears it after a pause, and marks hidden sessions idle", async () => {
    await start();
    editLocally();
    await vi.advanceTimersByTimeAsync(250);
    const payload = () =>
      JSON.parse(
        mocks.api.mock.calls
          .filter(([path]) => path.endsWith("/presence"))
          .at(-1)![2].body,
      );
    expect(payload().activity).toBe("Editing");
    await vi.advanceTimersByTimeAsync(3000);
    expect(payload().activity).toBe("Viewing");
    vi.stubGlobal("document", {
      visibilityState: "hidden",
      hasFocus: () => false,
      removeEventListener: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(payload()).toMatchObject({ activity: "Idle", cursor: null });
    provider.close();
    expect(payload().leaving).toBe(true);
    expect(
      mocks.api.mock.calls
        .filter(([path]) => path.endsWith("/presence"))
        .at(-1)![2].keepalive,
    ).toBe(true);
  });
  it("renews all capabilities before their 60-second expiry without reconnecting", async () => {
    await start();
    expect(calls("/live")).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls("/live")).toBe(2);
    for (const sub of subscriptions.values())
      expect(sub.renew).toHaveBeenCalledOnce();
    expect(provider.state.connection).toBe("Connected");
    expect(provider.state.status).toBe("Saved");
    expect(mocks.createClient).toHaveBeenCalledOnce();
  });

  it("rehydrates a reset baseline without reporting a disconnect or writing more presence", async () => {
    await start();
    expect(calls("/presence")).toBe(1);
    const statuses: string[] = [];
    provider.subscribe(() => statuses.push(provider.state.status));
    const sub = subscriptions.get("metadata")!;
    sub.emit("stale");
    sub.resets.forEach((fn) => fn([]));
    live("metadata");
    await settle();
    expect(calls("/bootstrap")).toBe(2);
    expect(calls("/presence")).toBe(1);
    expect(statuses).not.toContain("Reconnecting");
    expect(provider.state.connection).toBe("Connected");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls("/presence")).toBe(2);
  });

  it("keeps a real disconnect visible while local edits are persisted, then recovers", async () => {
    await start();
    logger({
      event: "connection_lost",
      level: "warn",
      message: "Connection lost",
    });
    keys.forEach((key) => subscriptions.get(key)!.emit("stale"));
    editLocally();
    await settle();
    expect(mocks.append).toHaveBeenCalled();
    expect(provider.state.status).toBe("Reconnecting");
    expect(provider.state.connection).toBe("Reconnecting");
    logger({ event: "connection_recovered", level: "info" });
    keys.forEach(live);
    await settle();
    expect(provider.state.connection).toBe("Connected");
    expect(provider.state.status).toBe("Saved");
  });

  it("reports a retryable HTTP write failure as a save retry while the socket stays connected", async () => {
    await start();
    const batch = {
      id: crypto.randomUUID(),
      update: encodeBase64(Y.encodeStateAsUpdate(provider.doc)),
    };
    mocks.freeze.mockResolvedValue(batch);
    mocks.api.mockImplementation(async (path: string) => {
      if (path.endsWith("/updates"))
        throw new ApiError(503, "unavailable", "Retry this save.", true);
      return { server_time: Date.now() };
    });
    await provider.flush();
    expect(provider.state.connection).toBe("Connected");
    expect(provider.state.status).toBe("Retrying save…");
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    mocks.api.mockResolvedValue({});
    await provider.flush();
    expect(mocks.acknowledge).toHaveBeenCalledWith(batch.id);
    expect(provider.state.status).toBe("Saved");
  });

  it("keeps a terminal connection failure visible when the local queue changes", async () => {
    await start();
    logger({
      event: "connection_failed",
      level: "error",
      message: "Connection failed",
    });
    editLocally();
    await settle();
    expect(provider.state.status).toBe("Unavailable");
    expect(provider.state.error).toBe("Connection failed");
  });

  it("keeps a failed live query visible while edits are saved", async () => {
    await start();
    subscriptions
      .get("updates")!
      .receive({ status: "error", error: new Error("Query failed") });
    editLocally();
    await settle();
    expect(provider.state.connection).toBe("Connected");
    expect(provider.state.status).toBe("Live query unavailable");
    expect(provider.state.error).toBe("updates: Query failed");
    live("updates");
    await settle();
    expect(provider.state.status).toBe("Saved");
  });
});
