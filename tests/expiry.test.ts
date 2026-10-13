import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isActive, watchExpiry } from "../src/client/expiry";
import type { ExpiringEntry } from "../src/shared/contracts";
let close: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  close?.();
  close = undefined;
  vi.useRealTimers();
});
it("expires entries without a database update, skipping revoked entries", () => {
  const start = Date.now();
  const entries = [
    { expires_at: new Date(start + 5000) },
    { expires_at: new Date(start + 10_000) },
    { expires_at: new Date(start + 3000), revoked_at: new Date(start) },
  ];
  let active: ExpiringEntry[] = [];
  const onTime = vi.fn((now: number) => {
    active = entries.filter((entry) => isActive(entry, now));
  });
  close = watchExpiry(entries, onTime).close;
  expect(active).toHaveLength(2);
  vi.advanceTimersByTime(4999);
  expect(active).toHaveLength(2);
  expect(onTime).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1);
  expect(active).toEqual([entries[1]]);
  vi.advanceTimersByTime(5000);
  expect(active).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it("uses server time and cancels its timer when the dialog closes", () => {
  const offset = 3600_000;
  const entries = [{ expires_at: new Date(Date.now() + offset + 5000) }];
  const onTime = vi.fn();
  const watcher = watchExpiry(entries, onTime, offset);
  close = watcher.close;
  vi.advanceTimersByTime(4999);
  expect(isActive(entries[0], onTime.mock.lastCall![0])).toBe(true);
  vi.advanceTimersByTime(1);
  expect(isActive(entries[0], onTime.mock.lastCall![0])).toBe(false);
  const future = watchExpiry(
    [{ expires_at: new Date(Date.now() + 30 * 86400_000) }],
    onTime,
  );
  expect(vi.getTimerCount()).toBe(1);
  future.close();
  const calls = onTime.mock.calls.length;
  future.refresh();
  vi.advanceTimersByTime(60_000);
  expect(onTime).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});
