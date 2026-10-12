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
  Command,
  ChevronDown,
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
const welcome = `# A little space for big ideas\n\nGood writing starts with a conversation. This is a shared place to think out loud, find the right words, and make something together.\n\n## Make it yours\n\nInvite a collaborator, bring an agent, or just start writing. Everyone works on the same document, and your changes find their way here in real time.\n\n- Write with Markdown shortcuts\n- Share a link with your team\n- Connect an agent to help you edit\n\n> The best ideas rarely arrive fully formed. Leave a little room in the margin.\n`;
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
        <button className="workspace-label" onClick={() => setSidebar(false)}>
          <span className="workspace-icon">
            {session.name.slice(0, 1).toUpperCase()}
          </span>
          {session.name.split(" ")[0]}’s workspace
          <ChevronDown size={14} />
        </button>
        <button className="new-document" onClick={() => setDialog(true)}>
          <Plus size={17} />
          New document<span>⌘ N</span>
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
        <div className="sidebar-section">
          YOUR DOCUMENTS <span>{documents.length}</span>
        </div>
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
          <div className="neon-card">
            <span className="tiny-label">BUILT TOGETHER</span>
            <p>
              A shared page.
              <br />A thousand possibilities.
            </p>
            <a
              href="https://neon.tech/docs/realtime"
              target="_blank"
              rel="noreferrer"
            >
              Powered by Neon <ArrowUpRight size={14} />
            </a>
          </div>
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
            <span>
              {session.name}
              <small>Personal workspace</small>
            </span>
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
            <span className="eyebrow">YOUR NEXT IDEA STARTS HERE</span>
            <h1>
              Leave room
              <br />
              for possibility.
            </h1>
            <p>A calm place to write, with people and agents by your side.</p>
            <button className="primary" onClick={() => setDialog(true)}>
              <Plus size={16} />
              Create your first document
            </button>
          </div>
        )}
      </main>
      {dialog && (
        <Modal
          title="A fresh page"
          subtitle="Give your next idea a place to live."
          onClose={() => setDialog(false)}
        >
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
          <span className="eyebrow">THINK OUT LOUD. WRITE TOGETHER.</span>
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
        <span className="story-footer">
          POSTGRES AT HEART · NEON IN REAL TIME
        </span>
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
      </div>
      <div className="login-form">
        <div className="login-box">
          <span className="eyebrow">YOUR SHARED WRITING SPACE</span>
          <h2>{register ? "Start something good." : "Welcome back."}</h2>
          <p>
            {register
              ? "Make room for your next idea."
              : "Your words are right where you left them."}
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
              {busy
                ? "Opening…"
                : register
                  ? "Create your account"
                  : "Enter your workspace"}
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
          <div className="auth-footnote">
            <span className="neon-mark">N</span>Secure sign-in with Neon Auth
          </div>
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
        <div className="breadcrumbs">
          <span>Workspace</span>
          <span>/</span>
          <strong>{state.document?.title ?? "Opening document…"}</strong>
        </div>
        <div className="header-actions">
          <div
            className="presence"
            title={people.map((p) => `${p.label} · ${p.activity}`).join("\n")}
          >
            {people.slice(0, 3).map((p) => (
              <span
                className={`avatar ${p.kind === "agent" ? "agent" : ""}`}
                key={p.session_id}
              >
                {p.kind === "agent" ? <Bot size={14} /> : p.label.slice(0, 1)}
              </span>
            ))}
            <span className="avatar self" title={`${session.name} · you`}>
              {session.name.slice(0, 1)}
            </span>
          </div>
          <button className="secondary" onClick={() => setModal("share")}>
            <Share2 size={15} />
            Share
          </button>
          <button className="primary small" onClick={() => setModal("agent")}>
            <Bot size={15} />
            Connect agent
          </button>
        </div>
      </header>
      <div className="document-subheader">
        <div className="save-state">
          <span
            className={`status-dot ${state.pending ? "pending" : ""} ${state.paused ? "paused" : ""}`}
          />
          {!navigator.onLine && <WifiOff size={13} />} {state.status}
          {state.document?.role === "viewer" && (
            <span className="role-pill">View only</span>
          )}
        </div>
        <div className="view-controls">
          <button
            className={source ? "" : "active"}
            onClick={() => setSource(false)}
          >
            <FileText size={14} />
            Document
          </button>
          <button
            className={source ? "active" : ""}
            onClick={() => setSource(true)}
          >
            <Code2 size={14} />
            Markdown
          </button>
          <span className="divider" />
          <button
            className={inspector ? "active" : ""}
            onClick={() => setInspector(!inspector)}
            title="Show live sync details"
          >
            <Activity size={15} />
          </button>
          <button onClick={download} title="Export Markdown">
            <Download size={15} />
          </button>
        </div>
      </div>
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
          <div className="paper-meta">
            <span className="eyebrow">A WORK IN PROGRESS</span>
            <button
              className="icon-button"
              title="Rename document"
              disabled={readOnly}
              onClick={() => {
                setTitle(state.document?.title ?? "");
                setRename(true);
              }}
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
          <div className="paper-title-row">
            <span>{state.document?.title ?? "Opening…"}</span>
            <span className="collaborative-label">
              <span className="status-dot" />
              Live document
            </span>
          </div>
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
              <span>Markdown shortcuts welcome</span>
            </div>
          )}
          {state.ready ? (
            <>
              {source ? (
                <div className="source-view">
                  <div>
                    <span>MARKDOWN SOURCE</span>
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
              <p>Finding your latest words…</p>
            </div>
          )}
          <div className="paper-footer">
            <span>
              {words.toLocaleString()} words<span> · </span>
              {Math.max(1, Math.ceil(words / 200))} min read
            </span>
            <span>
              {state.pending ? (
                `${state.pending} local batch${state.pending === 1 ? "" : "es"} pending`
              ) : (
                <>
                  <Check size={13} />
                  All changes saved
                </>
              )}
            </span>
          </div>
        </div>
        {inspector && (
          <aside className="inspector">
            <div>
              <span className="eyebrow">UNDER THE SURFACE</span>
              <button
                className="icon-button"
                onClick={() => setInspector(false)}
              >
                <X size={16} />
              </button>
            </div>
            <h3>Your words, in motion.</h3>
            <p>
              Edits become Postgres rows. Neon Realtime brings them to every
              shared page.
            </p>
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
              <span className="tiny-label">ON THIS PAGE</span>
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
            <div className="tech-stack">
              Milkdown + Yjs
              <br />
              Postgres + Neon Realtime
              <br />
              Neon Auth + Neon Functions
            </div>
          </aside>
        )}
      </div>
      <footer className="workspace-footer">
        <span>
          <Command size={12} />
          Made for thinking together
        </span>
        <span className="neon-credit">
          <span className="status-dot" />
          Powered by Neon Realtime
        </span>
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
        <span className="eyebrow">MARGIN / TOGETHER</span>
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
      title="Better with company."
      subtitle="Invite someone into this document. They’ll sign in with their own Neon account."
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
        <span className="tiny-label">PEOPLE WITH ACCESS</span>
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
      title="An extra pair of hands."
      subtitle="Give an agent access to this page. It can read, suggest, and edit alongside you."
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
            Add this MCP server URL to your agent’s connectors. Sign in through
            Neon Auth, choose this document, and approve the requested
            permissions.
          </p>
          <CopyBox value={config?.mcpUrl ?? "Loading…"} />
          <span className="tiny-label">DOCUMENT ID</span>
          <CopyBox value={id} />
          <small className="hint">
            The agent uses OAuth with PKCE. Approval stays scoped to one
            document.
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
              <span className="tiny-label">DOCUMENT ID</span>
              <CopyBox value={id} />
            </>
          )}
        </>
      )}
      <div className="dialog-list">
        <span className="tiny-label">YOUR CONNECTIONS</span>
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
        <span className="eyebrow">AGENT CONNECTION</span>
        <h2>Choose a shared page.</h2>
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
