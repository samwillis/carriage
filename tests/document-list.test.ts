import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeDocuments } from "../src/client/document-list";
import { ApiError } from "../src/client/api";
import { subscribeLiveQueries } from "../src/client/live-queries";

const mocks = vi.hoisted(() => ({ api: vi.fn(), createClient: vi.fn() }));
vi.mock("../src/client/api", async (original) => ({
  ...(await original<object>()),
  api: mocks.api,
}));
vi.mock("@neon/realtime/client", () => ({
  createRealtimeClient: mocks.createClient,
}));
const session = {
  userId: "writer",
  name: "Writer",
  token: async () => "unused",
};
let clients: {
  receive: (state: any) => void;
  renew: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}[];
let stop: (() => void) | undefined;
const rows = vi.fn(),
  errors = vi.fn();
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  clients = [];
  mocks.api.mockImplementation(async (path: string) =>
    path === "/api/config"
      ? { realtimeUrl: "wss://example.invalid" }
      : "sealed",
  );
  mocks.createClient.mockImplementation(() => {
    const subscription = {
      receive: (_: any) => {},
      renew: vi.fn(async () => {}),
      close: vi.fn(),
    };
    clients.push(subscription);
    return {
      close: subscription.close,
      subscribe: () => ({
        renew: subscription.renew,
        onChange: (fn: (state: any) => void) => {
          subscription.receive = fn;
        },
      }),
    };
  });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
describe("live document sidebar", () => {
  it("sorts live rows and publishes renames, removals and empty results", async () => {
    stop = subscribeDocuments(session, rows, errors);
    await settle();
    const older = {
      id: "older",
      title: "Older",
      updated_at: "2026-10-12T12:00:00Z",
      role: "owner",
    };
    const newer = {
      ...older,
      id: "newer",
      title: "Newer",
      updated_at: "2026-10-13T12:00:00Z",
    };
    const data = [older, newer];
    clients[0].receive({ status: "live", data });
    expect(rows).toHaveBeenLastCalledWith([newer, older]);
    expect(data).toEqual([older, newer]);
    clients[0].receive({ status: "stale", data: [] });
    expect(rows).toHaveBeenCalledOnce();
    clients[0].receive({
      status: "live",
      data: [{ ...older, title: "Renamed" }],
    });
    expect(rows.mock.lastCall?.[0]).toEqual([{ ...older, title: "Renamed" }]);
    clients[0].receive({ status: "live", data: [] });
    expect(rows).toHaveBeenLastCalledWith([]);
  });
  it("renews the capability without polling document rows or replacing the connection", async () => {
    stop = subscribeDocuments(session, rows, errors);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/config",
      "/api/documents/live",
    ]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(clients[0].renew).toHaveBeenCalledWith("sealed");
    expect(mocks.createClient).toHaveBeenCalledOnce();
  });
  it("retries failed queries and ignores results from a closed connection", async () => {
    stop = subscribeDocuments(session, rows, errors);
    await settle();
    const old = clients[0];
    old.receive({ status: "error", error: new Error("Retry") });
    expect(old.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(clients).toHaveLength(2);
    old.receive({ status: "live", data: [] });
    expect(rows).not.toHaveBeenCalled();
    clients[1].receive({ status: "live", data: [] });
    expect(rows).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenLastCalledWith("");
    stop();
    clients[1].receive({ status: "live", data: [] });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rows).toHaveBeenCalledOnce();
    expect(clients).toHaveLength(2);
  });
  it("does not open a connection if sign-out happens while sealing the query", async () => {
    let resolve!: (value: string) => void;
    mocks.api.mockImplementation(async (path: string) =>
      path === "/api/config"
        ? { realtimeUrl: "wss://example.invalid" }
        : new Promise<string>((r) => {
            resolve = r;
          }),
    );
    stop = subscribeDocuments(session, rows, errors);
    stop();
    resolve("sealed");
    await settle();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("stops retrying when authentication expires", async () => {
    mocks.api.mockRejectedValue(
      new ApiError(401, "credential_expired", "Sign in again."),
    );
    stop = subscribeDocuments(session, rows, errors);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenLastCalledWith("Sign in again.");
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("shares a connection for multiple dialog queries and renews them together", async () => {
    const members = { receive: (_: any) => {}, renew: vi.fn(async () => {}) };
    const invites = { receive: (_: any) => {}, renew: vi.fn(async () => {}) };
    const close = vi.fn();
    mocks.createClient.mockReturnValue({
      close,
      subscribe: (sealed: string) => {
        const sub = sealed === "members" ? members : invites;
        return {
          renew: sub.renew,
          onChange: (fn: any) => {
            sub.receive = fn;
          },
        };
      },
    });
    const onMembers = vi.fn(),
      onInvites = vi.fn();
    const load = vi.fn(
      async () => ({ members: "members", invites: "invites" }) as any,
    );
    stop = subscribeLiveQueries(
      session,
      load,
      { members: onMembers, invites: onInvites },
      errors,
    );
    await settle();
    members.receive({ status: "live", data: [{ user_id: "writer" }] });
    invites.receive({ status: "live", data: [] });
    expect(onMembers).toHaveBeenLastCalledWith([{ user_id: "writer" }]);
    expect(onInvites).toHaveBeenLastCalledWith([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(members.renew).toHaveBeenCalledWith("members");
    expect(invites.renew).toHaveBeenCalledWith("invites");
    expect(mocks.createClient).toHaveBeenCalledOnce();
    load.mockRejectedValue(new ApiError(403, "access_lost", "Access removed."));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onMembers).toHaveBeenLastCalledWith([]);
    expect(onInvites).toHaveBeenLastCalledWith([]);
    expect(close).toHaveBeenCalledOnce();
    members.receive({ status: "live", data: [{ user_id: "writer" }] });
    expect(onMembers).toHaveBeenLastCalledWith([]);
  });
});
