import { createRealtimeClient } from "@neon/realtime/client";
import { api, ApiError, type Session } from "./api";
import type { DocumentSummary } from "../shared/contracts";

export function subscribeDocuments(
  session: Session,
  onDocuments: (rows: DocumentSummary[]) => void,
  onError: (message: string) => void,
) {
  let closed = false,
    generation = 0;
  let client: ReturnType<typeof createRealtimeClient> | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function failed(error: unknown, attempt: number) {
    if (closed || attempt !== generation) return;
    generation++;
    clearInterval(renewal);
    client?.close();
    onError(
      error instanceof Error ? error.message : "Document list sync delayed.",
    );
    if (error instanceof ApiError && [401, 403].includes(error.status)) return;
    retry = setTimeout(() => void connect(), 3000);
  }

  async function connect() {
    const attempt = ++generation;
    try {
      const [config, sealed] = await Promise.all([
        api("/api/config"),
        api("/api/documents/live", session),
      ]);
      if (closed || attempt !== generation) return;
      client = createRealtimeClient({
        url: config.realtimeUrl,
        logger: (entry) => {
          if (
            entry.event === "connection_failed" ||
            entry.event === "connection_reconnect_exhausted"
          )
            failed(new Error(entry.message), attempt);
        },
      });
      if (closed || attempt !== generation) {
        client.close();
        return;
      }
      const subscription = client.subscribe<DocumentSummary>(sealed);
      subscription.onChange((change) => {
        if (closed || attempt !== generation) return;
        if (change.status === "error") failed(change.error, attempt);
        else if (change.status === "live" && change.data) {
          onDocuments(
            [...change.data].sort(
              (a, b) =>
                new Date(b.updated_at).getTime() -
                  new Date(a.updated_at).getTime() || a.id.localeCompare(b.id),
            ),
          );
          onError("");
        }
      });
      if (closed || attempt !== generation) return;
      let renewing = false;
      // Renew the 60-second capability without replacing the live query.
      renewal = setInterval(() => {
        if (closed || renewing || attempt !== generation) return;
        renewing = true;
        void api("/api/documents/live", session)
          .then((next) => {
            if (!closed && attempt === generation)
              return subscription.renew(next);
          })
          .catch((error) => failed(error, attempt))
          .finally(() => {
            renewing = false;
          });
      }, 30_000);
    } catch (error) {
      failed(error, attempt);
    }
  }
  void connect();
  return () => {
    closed = true;
    generation++;
    clearInterval(renewal);
    clearTimeout(retry);
    client?.close();
  };
}
