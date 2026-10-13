import { api, type Session } from "./api";
import { subscribeLiveQueries } from "./live-queries";
import type { DocumentSummary } from "../shared/contracts";

export function subscribeDocuments(
  session: Session,
  onDocuments: (rows: DocumentSummary[]) => void,
  onError: (message: string) => void,
) {
  return subscribeLiveQueries<{ documents: DocumentSummary }>(
    session,
    async () => ({ documents: await api("/api/documents/live", session) }),
    {
      documents: (rows) =>
        onDocuments(
          rows.sort(
            (a, b) =>
              new Date(b.updated_at).getTime() -
                new Date(a.updated_at).getTime() || a.id.localeCompare(b.id),
          ),
        ),
    },
    onError,
  );
}
