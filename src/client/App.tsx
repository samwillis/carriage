import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Plus,
  Search,
  ArrowUpRight,
  ArrowLeft,
  MoreHorizontal,
  Share2,
  Bot,
  FileText,
  Code2,
  Download,
  Check,
  WifiOff,
  PanelLeft,
  LogOut,
  X,
  Bold,
  Italic,
  Heading2,
  List,
  Undo2,
  Redo2,
  Activity,
  Copy,
} from "lucide-react";
import type { Editor } from "@milkdown/kit/core";
import { api, post, type Session } from "./api";
import { auth, currentSession } from "./auth";
import { DocumentProvider } from "./provider";
import { WritingEditor, format, type Format } from "./editor";
import { renderDocument } from "../shared/codec";
import type { DocumentInfo } from "../shared/contracts";
const welcome = `# Getting started\n\n- Open this document in another window to try live editing.\n- Use Share to invite someone.\n- Use Connect agent to let an agent read or edit this document.\n\nStart writing here.\n`;
export function App() {
  const [session, setSession] = useState<Session | null>(null),
    [loaded, setLoaded] = useState(false),
    [documents, setDocuments] = useState<DocumentInfo[]>([]),
    [selected, setSelected] = useState<string | null>(
      new URLSearchParams(location.search).get("doc"),
    );
  const [query, setQuery] = useState(""),
    [dialog, setDialog] = useState(false),
    [error, setError] = useState(""),
    [title, setTitle] = useState(""),
    [sidebar, setSidebar] = useState(false);
  useEffect(() => {
    void currentSession()
      .then(setSession)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const refresh = async (s = session) => {
    if (!s) return;
    const rows = await api<DocumentInfo[]>("/api/documents", s);
    setDocuments(rows);
    setSelected((current) => current ?? rows[0]?.id ?? null);
  };
  useEffect(() => {
    if (session)
      void (async () => {
        const invite = new URLSearchParams(location.search).get("invite");
        if (invite) {
          const accepted = await api(
            "/api/invites/accept",
            session,
            post({ token: invite }),
          );
          setSelected(accepted.document_id);
          history.replaceState({}, "", `/?doc=${accepted.document_id}`);
        }
        await refresh(session);
      })().catch((e) => setError(e.message));
  }, [session]);
  async function create() {
    try {
      const d = await api<DocumentInfo>(
        "/api/documents",
        session!,
        post({ title: title.trim() || "Untitled document", markdown: welcome }),
      );
      await refresh();
      setSelected(d.id);
      history.replaceState({}, "", `/?doc=${d.id}`);
      setDialog(false);
      setTitle("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!loaded) return <div className="boot">Opening your workspace…</div>;
  if (!session) return <Login onSession={setSession} />;
  if (location.pathname === "/oauth/connect")
    return <OAuthConnect session={session} documents={documents} />;
  return (
    <div className={`workspace ${sidebar ? "sidebar-open" : ""}`}>
      <aside className="sidebar">
        <a className="wordmark" href="/">
          margin
          <span className="brand-dot" />
        </a>
        <button className="new-document" onClick={() => setDialog(true)}>
          <Plus size={17} />
          New document
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search documents"
            placeholder="Find a document…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav>
          {documents
            .filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))
            .map((d) => (
              <button
                key={d.id}
                className={`document-link ${selected === d.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(d.id);
                  setSidebar(false);
                  history.replaceState({}, "", `/?doc=${d.id}`);
                }}
              >
                <FileText size={16} />
                <span>{d.title}</span>
                {d.role === "viewer" && <small>View</small>}
              </button>
            ))}
          {query &&
            !documents.some((d) =>
              d.title.toLowerCase().includes(query.toLowerCase()),
            ) && <p className="sidebar-empty">No documents found.</p>}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="profile"
            onClick={() =>
              void (async () => {
                await auth?.signOut();
                setSession(null);
              })()
            }
          >
            <span className="avatar self">{session.name.slice(0, 1)}</span>
            <span>{session.name}</span>
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <main className="main">
        <button
          className="mobile-menu icon-button"
          aria-label="Open sidebar"
          onClick={() => setSidebar(!sidebar)}
        >
          <PanelLeft size={19} />
        </button>
        {error && (
          <div className="app-error" role="alert">
            {error}
            <button className="icon-button" onClick={() => setError("")}>
              <X size={15} />
            </button>
          </div>
        )}
        {selected ? (
          <Document
            key={`${session.userId}:${selected}`}
            id={selected}
            session={session}
            onRename={() => void refresh()}
          />
        ) : (
          <div className="empty-state">
            <h1>No documents yet</h1>
            <p>Create a document to start writing.</p>
            <button className="primary" onClick={() => setDialog(true)}>
              <Plus size={16} />
              Create your first document
            </button>
          </div>
        )}
      </main>
      {dialog && (
        <Modal title="New document" onClose={() => setDialog(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label className="field">
              Document title
              <input
                autoFocus
                maxLength={200}
                placeholder="e.g. Ideas for the launch"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <button className="primary" type="submit">
              Create document <ArrowUpRight size={16} />
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Login({ onSession }: { onSession: (s: Session) => void }) {
  const [register, setRegister] = useState(false),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [local, setLocal] = useState(false);
  useEffect(() => {
    void api("/api/config")
      .then((c) => setLocal(c.localAuth))
      .catch((e) => setError(e.message));
  }, []);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (local) {
        const d = await api("/api/local-login", undefined, post({ name }));
        onSession({
          userId: d.userId,
          name: d.name,
          token: async () => d.token,
        });
      } else {
        if (!auth)
          throw new Error(
            "Neon Auth is not configured. Generate the public environment file.",
          );
        const result = register
          ? await auth.signUp.email({ name, email, password })
          : await auth.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message);
        const session = await currentSession();
        if (!session)
          throw new Error(
            "Check your email to finish signing up, then sign in.",
          );
        onSession(session);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-story">
        <a href="/" className="wordmark">
          margin
          <span className="brand-dot" />
        </a>
        <div>
          <h1>
            Great ideas
            <br />
            need a little
            <br />
            <em>room.</em>
          </h1>
          <p>
            A shared writing space for you, your team,
            <br />
            and the agents that help you get there.
          </p>
        </div>
        <a
          className="story-footer"
          href="https://neon-next-git-thruflo-realtime-3-integration-neondatabase.vercel.app/docs/realtime/"
          target="_blank"
          rel="noreferrer"
        >
          Neon Realtime demo <ArrowUpRight size={14} />
        </a>
      </div>
      <div className="login-form">
        <div className="login-box">
          <h2>{register ? "Create an account" : "Sign in"}</h2>
          <p>
            {register
              ? "Save and share your documents."
              : "Open your documents."}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {(register || local) && (
              <label className="field">
                Your name
                <input
                  autoComplete="name"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            {!local && (
              <>
                <label className="field">
                  Email address
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label className="field">
                  Password
                  <input
                    type="password"
                    minLength={8}
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "Opening…" : register ? "Create your account" : "Sign in"}
              <ArrowUpRight size={17} />
            </button>
          </form>
          {!local && (
            <p className="auth-switch">
              {register ? "Already have an account?" : "New to Margin?"}{" "}
              <button onClick={() => setRegister(!register)}>
                {register ? "Sign in" : "Create an account"}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
function Document({
  id,
  session,
  onRename,
}: {
  id: string;
  session: Session;
  onRename: () => void;
}) {
  const [provider] = useState(() => new DocumentProvider(id, session));
  const state = useSyncExternalStore(provider.subscribe, provider.getSnapshot);
  const [editor, setEditor] = useState<Editor | null>(null),
    [source, setSource] = useState(false),
    [inspector, setInspector] = useState(false),
    [modal, setModal] = useState<"share" | "agent" | null>(null),
    [markdown, setMarkdown] = useState(""),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    void provider.start();
    return () => provider.close();
  }, [provider]);
  useEffect(() => {
    const changed = () => {
      try {
        setMarkdown(renderDocument(provider.doc));
      } catch {}
    };
    provider.doc.on("update", changed);
    changed();
    return () => provider.doc.off("update", changed);
  }, [provider, state.ready]);
  const readOnly = state.document?.role === "viewer" || state.paused;
  const people = state.presence.filter(
    (p) => p.session_id !== provider.sessionId,
  );
  const presenceLabel = (p: (typeof people)[number]) =>
    `${p.label}${p.kind === "person" && p.user_id === session.userId ? " · another browser or tab" : ""} · ${p.activity}`;
  const words = markdown.trim() ? markdown.trim().split(/\s+/).length : 0;
  function download() {
    const url = URL.createObjectURL(
      new Blob([markdown], { type: "text/markdown" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${state.document?.title ?? "document"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function saveTitle() {
    try {
      await api(`/api/documents/${id}`, session, {
        method: "PATCH",
        body: JSON.stringify({ title }),
      });
      setRename(false);
      onRename();
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <div className="document-shell">
      <header className="document-header">
        <div className="document-heading">
          <strong>{state.document?.title ?? "Opening document…"}</strong>
          <div className="save-state">
            <span
              className={`status-dot ${state.pending ? "pending" : ""} ${state.paused ? "paused" : ""}`}
            />
            {!navigator.onLine && <WifiOff size={13} />} {state.status}
            {state.document?.role === "viewer" && (
              <span className="role-pill">View only</span>
            )}
          </div>
        </div>
        <div className="header-actions">
          {people.length > 0 && (
            <div
              className="presence"
              role="group"
              aria-label={`${people.length + 1} connected ${people.length ? "sessions" : "session"}, including you`}
              title={[
                `${session.name} · you`,
                ...people.map(presenceLabel),
              ].join("\n")}
            >
              <span className="presence-avatars">
                {people.slice(0, 3).map((p) => (
                  <span
                    className={`avatar ${p.kind === "agent" ? "agent" : ""}`}
                    key={p.session_id}
                    title={presenceLabel(p)}
                  >
                    {p.kind === "agent" ? (
                      <Bot size={14} />
                    ) : (
                      p.label.slice(0, 1)
                    )}
                  </span>
                ))}
                <span className="avatar self" title={`${session.name} · you`}>
                  {session.name.slice(0, 1)}
                </span>
              </span>
              <span className="presence-count" aria-hidden="true">
                {people.length + 1} here
              </span>
            </div>
          )}
          <button className="secondary" onClick={() => setModal("share")}>
            <Share2 size={15} />
            Share
          </button>
          <button className="primary small" onClick={() => setModal("agent")}>
            <Bot size={15} />
            Connect agent
          </button>
          <details
            className="document-menu"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget))
                e.currentTarget.open = false;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.open = false;
                e.currentTarget.querySelector("summary")?.focus();
              }
            }}
          >
            <summary
              className="icon-button"
              aria-label="Document actions"
              title="Document actions"
            >
              <MoreHorizontal size={20} />
            </summary>
            <div
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("button"))
                  e.currentTarget.closest("details")!.open = false;
              }}
            >
              <button
                disabled={readOnly}
                onClick={() => {
                  setTitle(state.document?.title ?? "");
                  setRename(true);
                }}
              >
                Rename document
              </button>
              <button onClick={() => setSource(!source)}>
                <Code2 size={15} />
                {source ? "Back to editor" : "Markdown source"}
              </button>
              <button onClick={download}>
                <Download size={15} />
                Export Markdown
              </button>
              <button onClick={() => setInspector(!inspector)}>
                <Activity size={15} />
                {inspector ? "Hide sync details" : "Show live sync details"}
              </button>
            </div>
          </details>
        </div>
      </header>
      {(state.error || message) && (
        <div
          className={`sync-notice ${state.paused ? "error" : ""}`}
          role="alert"
        >
          {state.error || message}
          {state.paused && (
            <button onClick={download}>
              Export local copy <Download size={14} />
            </button>
          )}
          {state.paused && (
            <button
              onClick={() =>
                void provider.recoveryExport().then((data) => {
                  const url = URL.createObjectURL(
                    new Blob([JSON.stringify(data)], {
                      type: "application/json",
                    }),
                  );
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `margin-recovery-${id}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                })
              }
            >
              Recovery file
            </button>
          )}
          {message && (
            <button onClick={() => setMessage("")}>
              <X size={14} />
            </button>
          )}
        </div>
      )}
      <div className="writing-area">
        <div className="paper">
          {!source && (
            <div className="format-toolbar">
              {(
                [
                  { action: "bold", icon: Bold, label: "Bold · ⌘ B" },
                  { action: "italic", icon: Italic, label: "Italic · ⌘ I" },
                  { action: "heading", icon: Heading2, label: "Heading" },
                  { action: "list", icon: List, label: "Bullet list" },
                  { action: "undo", icon: Undo2, label: "Undo · ⌘ Z" },
                  { action: "redo", icon: Redo2, label: "Redo · ⌘ ⇧ Z" },
                ] as const
              ).map(({ action, icon: Icon, label }) => (
                <button
                  key={action}
                  title={label}
                  aria-label={label}
                  disabled={readOnly}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => format(editor, action as Format)}
                >
                  <Icon size={17} />
                </button>
              ))}
            </div>
          )}
          {state.ready ? (
            <>
              {source ? (
                <div className="source-view">
                  <div>
                    <span>Markdown source</span>
                    <button
                      onClick={() =>
                        void navigator.clipboard.writeText(markdown)
                      }
                    >
                      <Copy size={13} />
                      Copy
                    </button>
                  </div>
                  <pre>{markdown}</pre>
                </div>
              ) : (
                <WritingEditor
                  provider={provider}
                  readOnly={readOnly}
                  onEditor={setEditor}
                />
              )}
            </>
          ) : (
            <div className="document-loading">
              <span className="loading-line" />
              <span className="loading-line short" />
              <p>Loading document…</p>
            </div>
          )}
          <div className="paper-footer">
            <span>{words.toLocaleString()} words</span>
          </div>
        </div>
        {inspector && (
          <aside className="inspector">
            <div>
              <h3>Sync details</h3>
              <button
                className="icon-button"
                onClick={() => setInspector(false)}
              >
                <X size={16} />
              </button>
            </div>
            <p>Edits are stored in Postgres and synced by Neon Realtime.</p>
            <dl>
              <dt>Committed revision</dt>
              <dd>{state.document?.head ?? "—"}</dd>
              <dt>Snapshot revision</dt>
              <dd>{state.document?.snapshot_revision ?? "—"}</dd>
              <dt>Updates to compact</dt>
              <dd>{state.document?.pending_count ?? "—"}</dd>
              <dt>Pending bytes</dt>
              <dd>
                {Number(state.document?.pending_bytes ?? 0).toLocaleString()}
              </dd>
              <dt>Local queue</dt>
              <dd>{state.pending}</dd>
              <dt>Compaction</dt>
              <dd>{state.document?.compaction_until ? "Running" : "Ready"}</dd>
            </dl>
            <div className="inspector-people">
              <span className="section-label">On this document</span>
              <p>
                {session.name} <small>You</small>
              </p>
              {people.map((p) => (
                <p key={p.session_id}>
                  {p.label}
                  <small>{p.activity}</small>
                </p>
              ))}
            </div>
          </aside>
        )}
      </div>
      <footer className="workspace-footer">
        <a
          href="https://neon-next-git-thruflo-realtime-3-integration-neondatabase.vercel.app/docs/realtime/"
          target="_blank"
          rel="noreferrer"
        >
          Neon Realtime demo <ArrowUpRight size={12} />
        </a>
      </footer>
      {modal === "share" && (
        <ShareDialog
          id={id}
          session={session}
          role={state.document?.role ?? "viewer"}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "agent" && (
        <AgentDialog
          id={id}
          session={session}
          readOnly={readOnly}
          onClose={() => setModal(null)}
        />
      )}
      {rename && (
        <Modal title="Rename document" onClose={() => setRename(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveTitle();
            }}
          >
            <label className="field">
              Title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <button className="primary">Save title</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </section>
    </div>
  );
}
function ShareDialog({
  id,
  session,
  role,
  onClose,
}: {
  id: string;
  session: Session;
  role: string;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<any[]>([]),
    [invites, setInvites] = useState<any[]>([]),
    [permission, setPermission] = useState("editor"),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const refresh = async () => {
    setMembers(await api(`/api/documents/${id}/members`, session));
    if (role === "owner")
      setInvites(await api(`/api/documents/${id}/invites`, session));
  };
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, []);
  return (
    <Modal
      title="Share document"
      subtitle="Invite someone to view or edit this document."
      onClose={onClose}
    >
      {role === "owner" && (
        <>
          <label className="field">
            Link permission
            <select
              value={permission}
              onChange={(e) => setPermission(e.target.value)}
            >
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
          </label>
          <button
            className="primary"
            onClick={() =>
              void api(
                `/api/documents/${id}/invites`,
                session,
                post({ role: permission }),
              )
                .then((d) => {
                  setUrl(d.url);
                  void refresh();
                })
                .catch((e) => setError(e.message))
            }
          >
            <Share2 size={15} />
            Create invitation link
          </button>
          {url && <CopyBox value={url} />}
          <small className="hint">Invitation links expire after 7 days.</small>
        </>
      )}
      <div className="dialog-list">
        <span className="section-label">People with access</span>
        {members.map((m) => (
          <div key={m.user_id}>
            <span>
              {m.user_id === session.userId
                ? `${session.name} (you)`
                : m.user_id}
            </span>
            <small>{m.role}</small>
            {role === "owner" && m.role !== "owner" && (
              <button
                onClick={() =>
                  void api(
                    `/api/documents/${id}/members/${encodeURIComponent(m.user_id)}`,
                    session,
                    { method: "DELETE" },
                  )
                    .then(refresh)
                    .catch((e) => setError(e.message))
                }
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {role === "owner" &&
        invites
          .filter((i) => !i.revoked_at)
          .map((i) => (
            <div className="grant-row" key={i.id}>
              <span>
                {i.role} invite
                <small>
                  Expires {new Date(i.expires_at).toLocaleDateString()}
                </small>
              </span>
              <button
                onClick={() =>
                  void api(`/api/documents/${id}/invites/${i.id}`, session, {
                    method: "DELETE",
                  }).then(refresh)
                }
              >
                Revoke
              </button>
            </div>
          ))}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-box">
      <code>{value}</code>
      <button
        aria-label="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}
function AgentDialog({
  id,
  session,
  readOnly,
  onClose,
}: {
  id: string;
  session: Session;
  readOnly: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState("hosted"),
    [config, setConfig] = useState<any>(null),
    [grants, setGrants] = useState<any[]>([]),
    [label, setLabel] = useState("My agent"),
    [scope, setScope] = useState(readOnly ? "read" : "edit"),
    [connection, setConnection] = useState<any>(null),
    [error, setError] = useState("");
  const refresh = async () =>
    setGrants(await api(`/api/documents/${id}/grants`, session));
  useEffect(() => {
    void api("/api/config").then(setConfig);
    void refresh();
  }, []);
  return (
    <Modal
      title="Connect agent"
      subtitle="Give an agent access to this document."
      onClose={onClose}
    >
      <div className="tabs">
        <button
          className={tab === "hosted" ? "active" : ""}
          onClick={() => setTab("hosted")}
        >
          Hosted agent
        </button>
        <button
          className={tab === "cli" ? "active" : ""}
          onClick={() => setTab("cli")}
        >
          CLI / local agent
        </button>
      </div>
      {tab === "hosted" ? (
        <>
          <p className="dialog-copy">
            Add this URL to your agent’s MCP connectors. Sign in, choose a
            document, and approve access.
          </p>
          <CopyBox value={config?.mcpUrl ?? "Loading…"} />
          <span className="section-label">Document ID</span>
          <CopyBox value={id} />
          <small className="hint">
            Access is limited to the document you choose.
          </small>
        </>
      ) : (
        <>
          <label className="field">
            Connection name
            <input
              value={label}
              maxLength={80}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="field">
            Agent permissions
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="read">Read only</option>
              {!readOnly && (
                <>
                  <option value="edit">Read + targeted edits</option>
                  <option value="write">Read + edits + full replacement</option>
                </>
              )}
            </select>
          </label>
          <button
            className="primary"
            onClick={() =>
              void api(
                `/api/documents/${id}/grants`,
                session,
                post({
                  label,
                  scopes:
                    scope === "read"
                      ? ["read"]
                      : scope === "edit"
                        ? ["read", "edit"]
                        : ["read", "edit", "write"],
                  days: 7,
                }),
              )
                .then((d) => {
                  setConnection(d);
                  void refresh();
                })
                .catch((e) => setError(e.message))
            }
          >
            Create connection <Bot size={16} />
          </button>
          {connection && (
            <>
              <p className="hint">
                Copy this now. The token is shown once and expires in 7 days.
              </p>
              <CopyBox
                value={JSON.stringify(
                  {
                    mcpServers: {
                      margin: {
                        url: connection.mcp_url,
                        headers: {
                          Authorization: `Bearer ${connection.token}`,
                        },
                      },
                    },
                  },
                  null,
                  2,
                )}
              />
              <span className="section-label">Document ID</span>
              <CopyBox value={id} />
            </>
          )}
        </>
      )}
      <div className="dialog-list">
        <span className="section-label">Connections</span>
        {grants
          .filter((g) => !g.revoked_at)
          .map((g) => (
            <div className="grant-row" key={g.id}>
              <span>
                {g.label}
                <small>
                  {g.scopes.join(" + ")} · expires{" "}
                  {new Date(g.expires_at).toLocaleDateString()}
                </small>
              </span>
              <button
                onClick={() =>
                  void api(`/api/grants/${g.id}`, session, { method: "DELETE" })
                    .then(refresh)
                    .catch((e) => setError(e.message))
                }
              >
                Revoke
              </button>
            </div>
          ))}
        {!grants.filter((g) => !g.revoked_at).length && (
          <p className="hint">No agents connected yet.</p>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </Modal>
  );
}
function OAuthConnect({
  session,
  documents,
}: {
  session: Session;
  documents: DocumentInfo[];
}) {
  const [id, setId] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const query = location.search.slice(1),
    scopes = new URLSearchParams(query).get("scope") ?? "document:read";
  return (
    <div className="oauth-page">
      <a className="wordmark" href="/">
        margin
        <span className="brand-dot" />
      </a>
      <section className="modal">
        <h2>Choose a document</h2>
        <p>
          You’re signed in as {session.name}. This agent is requesting: {scopes}
          .
        </p>
        <label className="field">
          Document
          <select value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Choose a document</option>
            {documents.map((d) => (
              <option value={d.id} key={d.id}>
                {d.title} ({d.role})
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={!id || busy}
          onClick={() => {
            setBusy(true);
            void api(
              "/api/oauth-ticket",
              session,
              post({ document_id: id, oauth_query: query }),
            )
              .then((d) => location.assign(d.url))
              .catch((e) => {
                setError(e.message);
                setBusy(false);
              });
          }}
        >
          Continue to approval <ArrowUpRight size={16} />
        </button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
