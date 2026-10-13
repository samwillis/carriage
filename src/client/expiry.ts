import { useEffect, useState } from "react";
import type { ExpiringEntry } from "../shared/contracts";

export function isActive(entry: ExpiringEntry, now: number) {
  return !entry.revoked_at && new Date(entry.expires_at).getTime() > now;
}
export function watchExpiry(
  entries: readonly ExpiringEntry[],
  onTime: (now: number) => void,
  serverOffset = 0,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const refresh = () => {
    clearTimeout(timer);
    if (closed) return;
    const now = Date.now() + serverOffset;
    onTime(now);
    const next = Math.min(
      ...entries
        .filter((entry) => isActive(entry, now))
        .map((entry) => new Date(entry.expires_at).getTime()),
    );
    if (Number.isFinite(next))
      timer = setTimeout(refresh, Math.min(next - now, 2 ** 31 - 1));
  };
  refresh();
  return {
    refresh,
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}
export function useExpiryClock(
  entries: readonly ExpiringEntry[],
  extra: ExpiringEntry | null = null,
  serverOffset = 0,
) {
  const [now, setNow] = useState(() => Date.now() + serverOffset);
  useEffect(() => {
    const watcher = watchExpiry(
      extra ? [...entries, extra] : entries,
      setNow,
      serverOffset,
    );
    window.addEventListener("focus", watcher.refresh);
    document.addEventListener("visibilitychange", watcher.refresh);
    return () => {
      watcher.close();
      window.removeEventListener("focus", watcher.refresh);
      document.removeEventListener("visibilitychange", watcher.refresh);
    };
  }, [entries, extra, serverOffset]);
  return now;
}
