import {
  createRealtimeClient,
  type SealedLiveQuery,
} from "@neon/realtime/client";
import { api, ApiError, type Session } from "./api";

export function subscribeLiveQueries<Rows extends Record<string, unknown>>(
  session: Session,
  loadQueries: () => Promise<{
    [Key in keyof Rows]: SealedLiveQuery<Rows[Key]>;
  }>,
  handlers: { [Key in keyof Rows]: (rows: Rows[Key][]) => void },
  onError: (message: string) => void,
) {
  let closed = false,
    generation = 0;
  let client: ReturnType<typeof createRealtimeClient> | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const keys = Object.keys(handlers) as (keyof Rows & string)[];
  function failed(error: unknown, attempt: number) {
    if (closed || attempt !== generation) return;
    generation++;
    clearInterval(renewal);
    client?.close();
    onError(error instanceof Error ? error.message : "Live updates delayed.");
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      for (const key of keys) handlers[key]([]);
      return;
    }
    retry = setTimeout(() => void connect(), 3000);
  }
  async function connect() {
    const attempt = ++generation;
    try {
      const [config, sealed] = await Promise.all([
        api("/api/config"),
        loadQueries(),
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
      const subscriptions = keys.map((key) => {
        const sub = client!.subscribe<Rows[typeof key]>(sealed[key]);
        sub.onChange((change) => {
          if (closed || attempt !== generation) return;
          if (change.status === "error") failed(change.error, attempt);
          else if (change.status === "live" && change.data) {
            handlers[key]([...change.data]);
            onError("");
          }
        });
        return { key, sub };
      });
      if (closed || attempt !== generation) return;
      let renewing = false;
      renewal = setInterval(() => {
        if (closed || renewing || attempt !== generation) return;
        renewing = true;
        void loadQueries()
          .then((next) => {
            if (!closed && attempt === generation)
              return Promise.all(
                subscriptions.map(({ key, sub }) => sub.renew(next[key])),
              );
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
