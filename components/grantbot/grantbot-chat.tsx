"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  ClipboardPaste,
  FileText,
  Link2,
  Loader2,
  MessagesSquare,
  Paperclip,
  Pencil,
  Plus,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { BRAND } from "@/lib/brand";
import { stripControlChars, truncateSafely, attachKindFor, isTextAttachable, MAX_ATTACH_CHARS, MAX_ATTACH_BYTES } from "@/lib/grantbot/label";
import { BLANK_CONVERSATION } from "@/lib/grantbot/wire";
import type { GrantBotMsg, GrantBotThread } from "@/lib/grantbot/wire";

// ── THE COMPOSER SURVIVES THE EXPAND NAVIGATION ──
//
// Expanding is a real route change: the corner panel unmounts and the full page mounts a
// fresh chat, so an unsent draft (or a pasted email thread, which is the expensive one to
// retype) went in the bin -- at exactly the moment someone reaches for more room to keep
// writing. sessionStorage rather than a query param: pasted call notes have no business in
// a URL that gets logged, bookmarked and shared. Per client, because the draft is about
// that client.
const draftKey = (clientId: string) => `grantbot:draft:${clientId}`;

interface StashedDraft {
  draft: string;
  pasted: string;
  pasteLabel: string;
  // The file-vs-paste discriminator has to ride the stash too, else a file attachment restores as a
  // manual paste on the other surface and dumps its raw body back into the panel (it's a chip, not text).
  attachedFile: { name: string; type: string } | null;
}

function stashDraft(clientId: string, d: StashedDraft) {
  if (typeof window === "undefined") return;
  try {
    if (!d.draft && !d.pasted && !d.pasteLabel && !d.attachedFile) {
      window.sessionStorage.removeItem(draftKey(clientId));
      return;
    }
    window.sessionStorage.setItem(draftKey(clientId), JSON.stringify(d));
  } catch {
    // Private mode / quota. Losing a draft is the status quo, not a reason to break the panel.
  }
}

// Read-and-clear: a restored draft belongs to the surface that picks it up, and leaving it
// behind would resurrect it on the next mount after it had been sent.
function takeDraft(clientId: string): StashedDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(draftKey(clientId));
    if (!raw) return null;
    window.sessionStorage.removeItem(draftKey(clientId));
    const parsed = JSON.parse(raw) as Partial<StashedDraft>;
    const af = parsed.attachedFile;
    return {
      draft: typeof parsed.draft === "string" ? parsed.draft : "",
      pasted: typeof parsed.pasted === "string" ? parsed.pasted : "",
      pasteLabel: typeof parsed.pasteLabel === "string" ? parsed.pasteLabel : "",
      attachedFile:
        af && typeof af.name === "string" && typeof af.type === "string"
          ? { name: af.name, type: af.type }
          : null,
    };
  } catch {
    return null;
  }
}

// The wire shapes and the blank-conversation token live in lib/grantbot/wire.ts, with the
// one mapper that produces them for both surfaces. Re-exported here because the two pages
// and the launcher already import this module.
export type { GrantBotMsg, GrantBotThread } from "@/lib/grantbot/wire";

// ONLY what the component reads. The prompt's size and the gap count are rendered by the
// full page's own header chips, straight from `buildSystemPrompt` -- they were in this prop
// for the cost card that the full-page restyle deleted, and a field declared here that
// nothing dereferences reads as a dependency the chat does not have.
export interface GrantBotPromptMeta {
  instructionsVersion: string;
  methodologyVersion: string;
}

// Server-rendered transcript, for the surface that has one.
export interface GrantBotInitial {
  conversationId: string | null;
  conversations: GrantBotThread[];
  messages: GrantBotMsg[];
}

// The chat. Deliberately plain: a transcript, a box, and a separate paste field.
//
// ── THE PASTE FIELD IS SEPARATE FROM THE MESSAGE BOX, ON PURPOSE ──
//
// Pasting a client email into the same box as the question would make the two indistinguishable
// by the time they reach the model -- and the whole defence rests on untrusted text being
// delimited. A second field means the SERVER applies the frame (framePastedContent), so the
// markers cannot be forged by typing them, and the staffer can see which half of what they sent
// is being treated as evidence rather than instruction.
//
// ── TWO VARIANTS, ONE COMPONENT, ONE CONVERSATION ──
//
// `full` is the page: a 224px thread rail beside the transcript, with prompt starters under it.
// `corner` is the launcher panel on the client record: the rail collapses behind a toggle,
// because 404px of chat is for asking. The prompt's size and version stamps are not in here on
// either surface -- the full page carries them in its own header band, and the corner shows none,
// since the cost model is a debugging question the Context pack tab answers properly.
//
// The variants differ in CHROME ONLY. Same store, same turn route, same conversation -- expanding
// the corner panel navigates to the full page carrying the conversation id, so what you were
// reading is what you keep reading.
//
// ── NO router.refresh() ANYWHERE IN HERE ──
//
// The thread list and its ordering live server-side, so the page version used to re-render itself
// after every send to pick them up. In the corner panel that would re-render the entire client
// dashboard underneath -- masthead, report rows, drafts, the lot -- on every message. So the list
// is refetched from /api/grantbot/context instead, which is the two queries actually needed.
export function GrantBotChat({
  clientId,
  clientName,
  variant,
  initial,
  promptMeta,
  initialConversationId,
  initialBlank = false,
  onConversationChange,
  onTurnComplete,
}: {
  clientId: string;
  clientName: string;
  variant: "corner" | "full";
  initial?: GrantBotInitial;
  promptMeta?: GrantBotPromptMeta;
  // Corner only: open ON a thread (returning from the full page collapses back to the one you
  // were in). Ignored when `initial` is supplied.
  initialConversationId?: string | null;
  // Corner only: open on a BLANK conversation. Distinct from `initialConversationId: null`,
  // which means "no preference, give me the most recent thread" -- collapsing back from an
  // unsent conversation has to be able to ask for neither.
  initialBlank?: boolean;
  // Lets the launcher keep the expand target pointed at the live conversation without owning
  // conversation state itself.
  onConversationChange?: (id: string | null) => void;
  // Fired after a turn the server processed (ok, no error), whether or not the reader is still on
  // the thread -- a turn can WRITE a document artifact, so the artifact pane refetches on this.
  onTurnComplete?: () => void;
}) {
  const isCorner = variant === "corner";
  const [convId, setConvId] = useState<string | null>(initial?.conversationId ?? null);
  const [conversations, setConversations] = useState<GrantBotThread[]>(initial?.conversations ?? []);
  const [messages, setMessages] = useState<GrantBotMsg[]>(initial?.messages ?? []);
  const [draft, setDraft] = useState("");
  const [pasted, setPasted] = useState("");
  const [pasteLabel, setPasteLabel] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  // Non-null when the current attachment came from a FILE upload (vs a manual paste): it renders as a
  // chip (filename + type) instead of dumping the raw text into an editable panel, and the discriminator
  // keeps a file and a manual paste from being shown the same way (they share the one `pasted` slot).
  const [attachedFile, setAttachedFile] = useState<{ name: string; type: string } | null>(null);
  const [showThreads, setShowThreads] = useState(false);
  // Inline thread rename. renamingId is the thread whose title is being edited (null = none);
  // renameDraft is the in-progress text. A rename edits only the conversation title (metadata) --
  // never a stored message -- so it does not break the append-only transcript.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // A monotonic token for the CURRENT rename attempt, bumped every time an edit opens (startRename)
  // or ends (cancelRename). It is how a commit tells "this attempt" from a later one on the same
  // row: keying the guards on the conversation id alone couldn't distinguish an Escape-and-reopen
  // (or a row switch) from the still-pending original. Same shape as epochRef for a send.
  const renameEpoch = useRef(0);
  // The attempt epoch a commit is in flight for (null = none). Blocks the Enter-then-blur
  // double-write of the SAME attempt, while a fresh attempt (a new epoch) is never blocked.
  const renameInFlight = useRef<number | null>(null);
  // Lets Escape cancel without a trailing blur re-saving the abandoned draft.
  const skipBlurCommit = useRef(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  // A binary (PDF/.docx) attach round-trips to the server extractor, so the picker is busy while it
  // parses — the attach button shows a spinner and refuses a second pick until it resolves.
  const [attaching, setAttaching] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Finalize an attachment once its TEXT exists — whether read client-side (a text file) or extracted
  // server-side (a PDF/.docx via /api/grantbot/extract). ONE finalize site so the two sources produce
  // an identical chip + framed body and cannot drift.
  const finalizeAttachment = useCallback((text: string, truncated: boolean, rawName: string, mime: string) => {
    // Bake the truncation note into the BODY, not the label: the paste label is an editable field a
    // staffer may reword, so a note living only there can be edited away, leaving the model to answer
    // from a partial document believing it complete. In the body it survives -- mirrors web-fetch.ts's
    // frameFetchResult, which appends its note to the text the model reads.
    const body = truncated
      ? `${text}\n\n[The attachment was longer than the limit and was truncated -- treat it as partial, and say so if the answer might depend on the rest.]`
      : text;
    // The label rides the untrusted-content frame's marker line, so strip every line-breaking char a
    // crafted filename could carry (POSIX allows them) before it could forge a fence -- stripControlChars
    // is the same helper framePastedContent uses server-side, so the editable label the staffer sees
    // matches exactly what is sent.
    const name = stripControlChars(rawName) || "attached file";
    // A short type badge for the chip, from the extension (preferred) or the MIME subtype.
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toUpperCase() : "";
    const typeLabel = ext || (mime ? (mime.split("/").pop() ?? "").toUpperCase() : "") || "FILE";
    setPasted(body);
    setPasteLabel(name);
    // A FILE renders as a chip (#5/#6), not the raw-text paste panel; close the manual panel so the
    // two never show at once over the shared `pasted` slot.
    setShowPaste(false);
    setAttachedFile({ name, type: typeLabel });
  }, []);

  // Map a server extract failure to a plain-language banner. Never shows a guessed body: a scanned
  // PDF / unreadable file becomes advice to paste instead, not an invented answer.
  function extractFailureMessage(reason: unknown, kind: "pdf" | "docx"): string {
    switch (reason) {
      case "pdf_no_text":
        return "That PDF has no selectable text — it looks scanned. Paste the text in, or attach a text export.";
      case "pdf_form_unreadable":
        return "That looks like a fillable form (XFA/LiveCycle) whose data couldn't be read. Paste the text in instead.";
      case "docx_no_text":
        return "That Word document had no readable text. Paste the text in instead.";
      case "docx_too_large":
        return "That Word file expands too large to read safely — paste the text in instead.";
      case "pdf_parse_failed":
        return "Couldn't read that PDF (it may be corrupt or password-protected). Paste the text in instead.";
      case "docx_parse_failed":
        return "Couldn't read that file — only modern .docx works (not the older .doc). Save as .docx or paste the text in.";
      case "too_large":
        return "That file is too large to attach (limit 5 MB). Paste the relevant section instead.";
      case "empty":
        return "That file looks empty.";
      default:
        return `Couldn't read that ${kind === "pdf" ? "PDF" : "Word document"} — try again, or paste the text in instead.`;
    }
  }

  // "Attach a file" quick action: turn a file into text and drop it into the SAME paste-attachment
  // channel the paste panel uses -- the server frames it as untrusted pasted content (framePastedContent),
  // so this adds no new trust surface. TEXT files (email threads, notes, a NOFO saved to .txt) are read
  // client-side; PDF / .docx are extracted server-side (the parsers are node-only) via
  // /api/grantbot/extract and come back as text. Images (PNG/JPG) are the next follow-on (issue #465) —
  // they need the vision path, not text extraction. Bounded so a huge file can't blow the context window.
  const handleFileUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // allow re-picking the same file
      if (!file) return;
      setError(null); // a new pick clears any prior "too large" / "couldn't read" banner
      // A fresh pick supersedes any extraction still in flight (its late result will be dropped by the
      // token check below), so the last file the reader chose is the one that attaches.
      const token = (attachTokenRef.current += 1);
      const isCurrent = () => attachTokenRef.current === token;
      if (file.size > MAX_ATTACH_BYTES) {
        setError("That file is too large to attach (limit 5 MB). Paste the relevant section instead.");
        return;
      }

      // PDF / .docx: the client can't parse these (readAsText garbles them), so send the bytes to the
      // staff-gated node extractor and finalize with the TEXT it returns. The frame + caps + failure
      // handling are identical to the text path — only the source of the text differs.
      const kind = attachKindFor(file.name, file.type);
      if (kind) {
        setAttaching(true);
        const fd = new FormData();
        fd.append("file", file);
        fetch("/api/grantbot/extract", { method: "POST", body: fd })
          .then((r) => r.json().catch(() => null))
          .then((res: { ok?: boolean; text?: string; truncated?: boolean; reason?: unknown } | null) => {
            if (!isCurrent()) return; // superseded by a newer pick / cancel / thread switch — drop it
            if (res?.ok && typeof res.text === "string") {
              finalizeAttachment(res.text, !!res.truncated, file.name, file.type);
            } else {
              setError(extractFailureMessage(res?.reason, kind));
            }
          })
          .catch(() => {
            if (isCurrent()) setError("Couldn't read that file — try again, or paste the text in instead.");
          })
          // Only the CURRENT request owns the busy flag; a superseded one clearing it would unstick a
          // newer pick's spinner (thread switches also clear it directly).
          .finally(() => {
            if (isCurrent()) setAttaching(false);
          });
        return;
      }

      // Not a document (pdf/docx) — it must be genuinely TEXT to read client-side. readAsText never
      // throws on binary; it silently yields mojibake, so a non-text binary (a legacy .doc, an image
      // picked via "All files", anything else) is REFUSED with a typed banner rather than attached as
      // garbage — the same "never a guessed body" contract the server extractor holds.
      if (!isTextAttachable(file.name, file.type)) {
        setError("Couldn't read that file — attach a PDF, a Word .docx, or a text file (a legacy .doc isn't supported), or paste the text in.");
        return;
      }

      // Text-based file: read it in the browser, no round-trip. readAsText is async, so this path
      // ALSO sets `attaching` (like the binary branch) — otherwise Send/Enter/Paste, gated on
      // `attaching`, would stay live during the read and a quick send would go out before onload,
      // stranding the file's text on a later turn. Only the current read clears the flag (isCurrent);
      // a superseded read leaves it to whoever superseded it (a new pick, removeAttachment, a switch).
      setAttaching(true);
      const reader = new FileReader();
      reader.onload = () => {
        if (!isCurrent()) return; // a thread switch / newer pick during the read supersedes this one
        setAttaching(false);
        const text = typeof reader.result === "string" ? reader.result : "";
        const { text: sliced, truncated } = truncateSafely(text, MAX_ATTACH_CHARS);
        finalizeAttachment(sliced, truncated, file.name, file.type);
      };
      reader.onerror = () => {
        if (!isCurrent()) return; // a superseded read's error must not overwrite the current context
        setAttaching(false);
        setError("Couldn't read that file. Try a PDF, Word .docx, or a text file — or paste the text in instead.");
      };
      reader.readAsText(file);
    },
    [finalizeAttachment],
  );

  // WHICH TRANSCRIPT IS ON SCREEN, as a number that changes whenever it is replaced.
  //
  // `send()` closes over convId and then awaits a multi-second model call. Its success handler
  // appends with a functional updater, which applies to whatever `messages` is current when it
  // runs -- not the transcript the question was asked in. Switching threads or starting a new
  // conversation mid-flight therefore filed the answer under the thread you switched TO,
  // producing an assistant bubble with no question above it. (Nothing was lost: the turn route
  // persists the reply against the conversation it was sent for, so reopening that thread shows
  // it correctly.) Switching stays available during a turn -- disabling the thread list for the
  // length of an LLM call would be the worse trade -- so instead every send captures the epoch
  // it belongs to and drops its UI updates if the transcript moved on.
  const epochRef = useRef(0);
  // The attachment epoch, same shape as epochRef but for the async file-extract round-trip: bumped on
  // every new pick, on removeAttachment, and on a thread switch. A binary extraction that resolves
  // after its token is stale (a newer pick, a cancel, or a thread change happened while it was in
  // flight) drops its result instead of clobbering the composer or landing the document in the wrong
  // thread. Without it, `attaching` guarding only the current pick is not enough.
  const attachTokenRef = useRef(0);

  // The composer's attachment as it is RIGHT NOW, readable from an async handler.
  //
  // Clearing the paste fields after a send is only correct if they still hold what that send
  // consumed. A turn takes seconds, and nothing stops the reader preparing the next question's
  // attachment while it runs -- so an unconditional clear on the response deletes work that was
  // never sent. send()'s own closure cannot tell: it captured the old values, which is exactly
  // what the comparison needs to be made against.
  const pasteRef = useRef({ pasted: "", pasteLabel: "" });
  useEffect(() => {
    pasteRef.current = { pasted, pasteLabel };
  }, [pasted, pasteLabel]);

  // Opening a thread (mount, expand, or a switch) must land the reader AT the latest turn with NO
  // animation -- a smooth scroll from the top on open is the "animate-down" we don't want, and it
  // fires again every time the corner panel re-opens. So the first paint of a transcript jumps
  // instantly (behavior "auto"); only once the reader has actually SENT in this on-screen thread do
  // new turns scroll smoothly to follow the conversation. didUserSend flips true on a send and resets
  // to false on every thread switch / new conversation (loadThread / newConversation), so a switch
  // opens instantly too. Keyed on a real send, NOT "have I scrolled once", so an async transcript
  // (re)load after mount -- the corner's fetch-on-open, or the full page re-fetching its own thread --
  // still lands instantly instead of animating.
  const didUserSend = useRef(false);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: didUserSend.current ? "smooth" : "auto", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    onConversationChange?.(convId);
  }, [convId, onConversationChange]);

  // FULL PAGE ONLY: keep ?c naming the conversation actually on screen, INCLUDING when that is
  // a blank one. Arriving at ?c=new and then sending creates a conversation the URL does not
  // know about; clicking New conversation goes the other way and leaves the URL naming a thread
  // that is no longer on screen. Either way a reload, a shared link, or the Collapse control
  // (which reads this param at click time) lands somewhere the reader is not -- so the blank
  // case writes the sentinel rather than skipping the sync.
  //
  // replaceState rather than router.replace for the usual reason -- the param is read on the
  // server only on first render, and a re-render here would rebuild the page around a live
  // conversation.
  useEffect(() => {
    if (isCorner || typeof window === "undefined") return;
    const want = convId ?? BLANK_CONVERSATION;
    const url = new URL(window.location.href);
    if (url.searchParams.get("c") === want) return;
    url.searchParams.set("c", want);
    window.history.replaceState(window.history.state, "", url.toString());
  }, [isCorner, convId]);

  // Restore a draft stashed by the surface we just came from (expand / collapse). Mount only,
  // and read-and-clear, so it lands exactly once.
  useEffect(() => {
    const stashed = takeDraft(clientId);
    if (!stashed) return;
    setDraft(stashed.draft);
    setPasted(stashed.pasted);
    setPasteLabel(stashed.pasteLabel);
    setAttachedFile(stashed.attachedFile);
    // A file restores as its chip (attachedFile); only a MANUAL paste reopens the editable panel.
    if (!stashed.attachedFile && (stashed.pasted || stashed.pasteLabel)) setShowPaste(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the composer into sessionStorage so a route change cannot swallow it. Cheap enough
  // to do on every keystroke, and it self-clears when the fields go empty.
  useEffect(() => {
    stashDraft(clientId, { draft, pasted, pasteLabel, attachedFile });
  }, [clientId, draft, pasted, pasteLabel, attachedFile]);

  // ONE fetch of the context route, both callers. They differ only in what they do with the
  // result, so the query-param spelling and the error shape live here rather than in two
  // places that have to be edited in lockstep.
  const fetchContext = useCallback(
    async (opts: { conversationId?: string | null; threadsOnly?: boolean }) => {
      const qs = new URLSearchParams({ clientId });
      if (opts.conversationId) qs.set("conversationId", opts.conversationId);
      if (opts.threadsOnly) qs.set("threadsOnly", "1");
      const res = await fetch(`/api/grantbot/context?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        return { ok: false as const, error: data.error ?? `Request failed (${res.status}).` };
      }
      return { ok: true as const, data };
    },
    [clientId],
  );

  // Load (or switch to) a thread. Also the mount path for the corner panel, which is handed no
  // transcript: `null` means "the most recent thread for this client", which is what the full
  // page picks too, so the two surfaces open on the same conversation.
  const loadThread = useCallback(
    async (conversationId: string | null) => {
      epochRef.current += 1;
      // A file extracting when the reader switches threads must not land in the new one; supersede it
      // and clear the busy state so the destination thread starts clean.
      attachTokenRef.current += 1;
      setAttaching(false);
      // A switch/open opens the destination AT its latest turn with no animation (see the scroll effect).
      didUserSend.current = false;
      setLoading(true);
      setError(null);
      try {
        const result = await fetchContext({ conversationId });
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setConversations(result.data.conversations ?? []);
        setConvId(result.data.conversationId ?? null);
        setMessages(result.data.messages ?? []);
        setShowThreads(false);
      } catch {
        setError("Could not reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [fetchContext],
  );

  // The thread list alone, for a panel opening on a deliberately blank conversation: the rail
  // still needs its entries, but there is no transcript to fetch.
  const loadThreadsOnly = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchContext({ threadsOnly: true });
      if (result.ok) setConversations(result.data.conversations ?? []);
    } catch {
      // The composer works with an empty rail; a failed list is not worth a banner here.
    } finally {
      setLoading(false);
    }
  }, [fetchContext]);

  // The corner panel's first open. `initial` present (the full page) means the server already did
  // this work, so nothing is fetched.
  useEffect(() => {
    if (initial) return;
    if (initialBlank) void loadThreadsOnly();
    else void loadThread(initialConversationId ?? null);
    // Mount only: re-running on a changed initialConversationId would yank the thread out from
    // under someone who has since switched threads inside the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Thread ordering after a send, without re-rendering the page this is mounted on. `threadsOnly`
  // because that is all this reads -- without it the route also loaded and serialised a full
  // transcript that went straight in the bin, on the send path of all places.
  const refreshThreads = useCallback(async () => {
    try {
      const result = await fetchContext({ threadsOnly: true });
      if (result.ok) setConversations(result.data.conversations ?? []);
    } catch {
      // A stale thread list is not worth an error banner over a message that sent fine.
    }
  }, [fetchContext]);

  async function send() {
    const text = draft.trim();
    // No-op while a file is still extracting (matching the Send button + Enter's disabled state): a
    // send here would snapshot the pre-extraction `pasted` and submit the question WITHOUT the
    // document, then the late finalizeAttachment would strand the result on a later turn.
    if (!text || sending || attaching) return;
    setSending(true);
    setError(null);
    // The transcript this question belongs to. Every UI write below checks it first -- see the
    // epochRef note above.
    const epoch = epochRef.current;
    const stillMine = () => epochRef.current === epoch;

    // The attachment THIS turn consumes, and a check for whether the composer still holds it.
    // A turn takes seconds; if the reader has since prepared the next question's paste, clearing
    // the fields would delete something that was never sent.
    const sentPasted = pasted;
    const sentPasteLabel = pasteLabel;
    const attachmentUntouched = () =>
      pasteRef.current.pasted === sentPasted && pasteRef.current.pasteLabel === sentPasteLabel;
    const clearAttachment = () => {
      if (!attachmentUntouched()) return;
      setPasted("");
      setPasteLabel("");
      setShowPaste(false);
      setAttachedFile(null);
    };

    // Optimistic: the question appears immediately, marked pending by the spinner below rather
    // than by a fake assistant bubble. A placeholder answer that later turns into an error reads
    // as though GrantBot said something and then took it back.
    const mine: GrantBotMsg = {
      id: `local-${Date.now()}`,
      role: "user",
      text: pasted.trim() ? `${text}\n\n[+ pasted content]` : text,
      error: null,
      usage: null,
      instructionsVersion: null,
      methodologyVersion: null,
    };
    // From here on this on-screen thread follows the conversation with a smooth scroll; before the
    // first send it opened instantly at the bottom (see the scroll effect).
    didUserSend.current = true;
    setMessages((m) => [...m, mine]);
    setDraft("");

    try {
      const res = await fetch("/api/grantbot/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          conversationId: convId,
          message: text,
          pasted: pasted.trim() ? { body: pasted, describedAs: pasteLabel || undefined } : null,
        }),
      });
      const data = await res.json();
      // THE ANSWER IS ALREADY SAFE ON THE SERVER whether or not it can be shown. If the reader
      // has moved to another thread, every write below would land in the wrong transcript, so
      // the only thing left to do is refresh the rail (which is thread-scoped, not
      // message-scoped) and let the correct thread render it when reopened.
      const turnOk = res.ok && !data.error;
      if (!stillMine()) {
        // The turn still went out, so the attachment it consumed should not sit in the composer
        // waiting to be re-framed and re-sent with the next message -- unless the reader has
        // already replaced it, which clearAttachment checks.
        if (turnOk) {
          clearAttachment();
          onTurnComplete?.();
        }
        void refreshThreads();
        return;
      }
      if (data.conversationId && data.conversationId !== convId) setConvId(data.conversationId);
      if (!res.ok || data.error) {
        setError(data.error ?? `Request failed (${res.status}).`);
      } else {
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            role: "assistant",
            text: data.text,
            error: null,
            usage: data.usage ?? null,
            instructionsVersion: promptMeta?.instructionsVersion ?? null,
            methodologyVersion: promptMeta?.methodologyVersion ?? null,
          },
        ]);
        // Same guard on the ordinary path: staying in the thread does not stop someone lining up
        // the next question's attachment while this answer is still coming back.
        clearAttachment();
        onTurnComplete?.();
      }
      void refreshThreads();
    } catch {
      if (stillMine()) setError("Could not reach the server.");
    } finally {
      setSending(false);
    }
  }

  function newConversation() {
    // Same epoch bump as a thread switch: an in-flight answer must not land in the blank
    // transcript this creates.
    epochRef.current += 1;
    // Likewise supersede an in-flight extraction and clear the busy state — a document being read
    // when the reader starts a new conversation belongs to neither.
    attachTokenRef.current += 1;
    setAttaching(false);
    // Same as a thread switch: the blank transcript opens instantly, not with a scroll animation.
    didUserSend.current = false;
    setConvId(null);
    setMessages([]);
    setError(null);
    setShowThreads(false);
  }

  function startRename(c: GrantBotThread) {
    skipBlurCommit.current = false;
    renameEpoch.current += 1; // a fresh edit attempt -- any in-flight commit is now for an old epoch
    setRenamingId(c.id);
    setRenameDraft(c.title ?? "");
  }
  function cancelRename() {
    renameEpoch.current += 1; // ends this attempt: a commit still in flight can no longer touch state
    setRenamingId(null);
    setRenameDraft("");
  }
  async function commitRename(c: GrantBotThread) {
    const epoch = renameEpoch.current;
    // Re-entrancy guard for THIS attempt (Enter + a trailing blur). Keyed to the epoch, so a fresh
    // attempt on the same row -- e.g. Escape then reopen -- is a new epoch and is never blocked by
    // the stale in-flight one (the bug: an id-keyed guard silently swallowed the reopened edit).
    if (renameInFlight.current === epoch) return;
    const title = renameDraft.replace(/\s+/g, " ").trim();
    // No change (or emptied) is a cancel, not a write -- an empty title would blank the row. This is
    // synchronous with the epoch capture, so we are still on this attempt: cancel it outright.
    if (!title || title === (c.title ?? "")) {
      cancelRename();
      return;
    }
    renameInFlight.current = epoch;
    try {
      const res = await fetch("/api/grantbot/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, conversationId: c.id, title }),
      });
      if (res.ok) {
        // The server owns the title; refetch the list to pick it up (never router.refresh()).
        // refreshThreads (not loadThreadsOnly) so the transcript does not flash a loading state.
        await refreshThreads();
      } else {
        setError("Could not rename the conversation.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      // Only clear tracking + close the editor if we are STILL on this attempt. A request that
      // finishes after the user Escaped or switched rows (a newer epoch) must clobber neither the
      // newer editor nor the newer in-flight marker; the stale renameInFlight is harmless since
      // epochs are monotonic and never re-match a future attempt.
      if (renameEpoch.current === epoch) {
        renameInFlight.current = null;
        cancelRename();
      }
    }
  }

  // THREADS. A thread can be RENAMED (a hover pencil → an inline input) but not deleted: rename
  // edits only the conversation TITLE, which is metadata, so the append-only TRANSCRIPT is intact
  // -- no stored answer is rewritable. Delete stays out (0080 gives no DELETE policy).
  //
  // Two presentations of one list. On the page it is a RAIL: a filled New button, a Recent
  // eyebrow, and cards whose active state is a 3px orange left edge rather than a navy fill --
  // a rail that inverts a whole row competes with the transcript beside it. In the corner it
  // stays the compact stack, because it occupies the transcript's space while open and has to
  // give it straight back. Either way a row is now a wrapper holding a load button + a rename
  // pencil (siblings, never nested -- a button in a button is invalid), or the rename input.
  const renameInput = (c: GrantBotThread) => (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void commitRename(c);
      }}
      className="px-3 py-2"
    >
      <input
        autoFocus
        value={renameDraft}
        onChange={(e) => setRenameDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            // Neutralise the blur that unmounting the input would otherwise fire as a commit.
            skipBlurCommit.current = true;
            cancelRename();
          }
        }}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            return;
          }
          void commitRename(c);
        }}
        maxLength={80}
        aria-label="Conversation title"
        className="w-full rounded-lg border border-edge bg-white px-2 py-1 text-[12px] text-brand-navy focus:outline-none focus:ring-1 focus:ring-brand-orange"
      />
    </form>
  );
  const renamePencil = (c: GrantBotThread, active: boolean) => (
    <button
      type="button"
      onClick={() => startRename(c)}
      aria-label="Rename conversation"
      title="Rename"
      className={`absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-lg opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
        active ? "text-white/70 hover:bg-white/15" : "text-ink-subtle hover:bg-brand-navy/5 hover:text-brand-navy"
      }`}
    >
      <Pencil className="h-3.5 w-3.5" />
    </button>
  );
  const threadList = isCorner ? (
    <div className="space-y-2">
      <button
        type="button"
        onClick={newConversation}
        className="flex w-full items-center gap-1.5 rounded-pill border border-edge bg-white px-3.5 py-1.5 text-[12.5px] font-medium text-brand-navy hover:border-brand-navy/30"
      >
        <Plus className="h-3.5 w-3.5" /> New conversation
      </button>
      {conversations.map((c) => {
        const active = c.id === convId;
        return (
          <div
            key={c.id}
            className={`group relative rounded-xl transition-colors ${
              active
                ? "bg-brand-navy text-white"
                : // The corner's transcript ground is white, so a white row has no edge to it.
                  "bg-surface-sunken text-brand-navy/80 hover:bg-white hover:text-brand-navy"
            }`}
          >
            {renamingId === c.id ? (
              renameInput(c)
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void loadThread(c.id)}
                  className="block w-full px-3 py-2 pr-8 text-left text-[12.5px] leading-snug"
                >
                  <span className="line-clamp-2">{c.title ?? "Untitled"}</span>
                  <span className={active ? "text-white/60" : "text-ink-subtle"}>
                    {c.lastMessageAt.slice(0, 10)}
                  </span>
                </button>
                {renamePencil(c, active)}
              </>
            )}
          </div>
        );
      })}
      {conversations.length === 0 && (
        <p className="px-1 text-[12px] text-ink-subtle">No conversations yet.</p>
      )}
    </div>
  ) : (
    <>
      <button
        type="button"
        onClick={newConversation}
        className="flex h-[38px] w-full shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand-navy text-[13px] font-semibold text-white transition-colors hover:bg-brand-navyHover"
      >
        <Plus className="h-3.5 w-3.5" /> New conversation
      </button>
      <p className="mb-0.5 mt-1.5 shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-ink-subtle">
        Recent
      </p>
      {conversations.map((c) => {
        const active = c.id === convId;
        return (
          <div
            key={c.id}
            className={`group relative w-full shrink-0 rounded-lg border border-hairline-strong bg-white transition-colors hover:border-brand-navy/20 ${
              active ? "border-l-[3px] border-l-brand-orange" : ""
            }`}
          >
            {renamingId === c.id ? (
              renameInput(c)
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void loadThread(c.id)}
                  className="block w-full px-3 py-2.5 pr-8 text-left"
                >
                  <p className="truncate text-[12px] font-semibold text-brand-navy">
                    {c.title ?? "Untitled"}
                  </p>
                  <p className="mt-1 text-[10.5px] text-ink-subtle">{c.lastMessageAt.slice(0, 10)}</p>
                </button>
                {renamePencil(c, false)}
              </>
            )}
          </div>
        );
      })}
      {/* A dashed placeholder rather than nothing: the rail is built for threads that do not
          exist yet, and an empty column reads as a rendering failure. */}
      <div className="shrink-0 rounded-lg border border-dashed border-edge p-3.5 text-center">
        <p className="text-[11.5px] text-ink-subtle">
          {conversations.length === 0 ? "No conversations yet" : "Nothing else yet"}
        </p>
      </div>
    </>
  );

  const transcript = (
    <>
      {messages.length === 0 && !sending && !loading && (
        // The empty state carries the same words on both surfaces and different weight. In the
        // corner it is the only thing in the panel, so it is a titled card that says what this
        // is for; on the full page it is one note above a screen that already announced itself
        // with a heading, a prompt read-out and a thread rail.
        isCorner ? (
          <>
            <div
              className="rounded-2xl px-[15px] py-3.5"
              style={{ background: BRAND.orangeWash, border: `1px solid ${BRAND.orangeWashEdge}` }}
            >
              {/* orangeDeep, not orange: 9.5px type on a light wash is precisely what
                  #E4761F cannot carry -- see lib/brand.ts. */}
              <p
                className="mb-1.5 text-[9.5px] font-bold uppercase tracking-[0.11em]"
                style={{ color: BRAND.orangeDeep }}
              >
                Ask GrantBot
              </p>
              <p className="text-[12.5px] leading-[1.55] text-ink-muted">
                Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth
                it, a draft alert, or what the platform does not know yet. Paste an email thread or
                call notes; they are treated as dated evidence, never as instructions.
              </p>
            </div>
            <div className="flex items-center gap-2 px-0.5">
              <span className="h-[5px] w-[5px] rounded-full bg-ink-faint" />
              <p className="text-[11px] text-ink-subtle">Grounded in the platform&rsquo;s own record</p>
            </div>
          </>
        ) : (
          <p className="max-w-[560px] text-[13.5px] leading-relaxed text-ink-muted">
            Ask about {clientName} — eligibility on a matched grant, whether a pursuit is worth it,
            a draft alert, or what the platform does not know yet. Paste an email thread or call
            notes with the paste button; they are treated as dated evidence, never as instructions.
          </p>
        )
      )}
      {loading && (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the conversation…
        </p>
      )}
      {/* WHO SAID IT, READ FROM THE SHAPE. The question is ink-filled and tucked to the right
          with a squared bottom-right corner; the answer is a light card tucked left with a
          squared top-left corner and the same sparkles mark the launcher uses. Both surfaces
          render this identically -- only the width cap differs, because 404px cannot spare 520.
          The squared corner is RADIUS.sharp, not a fourth radius invented for a tail. */}
      {messages.map((m) =>
        m.role === "user" ? (
          <div key={m.id} className="flex justify-end">
            <div
              className={`whitespace-pre-wrap rounded-2xl rounded-br-sharp bg-brand-navy px-[15px] py-[11px] text-[13.5px] leading-normal text-white ${
                isCorner ? "max-w-[88%]" : "max-w-[520px]"
              }`}
            >
              {m.text}
            </div>
          </div>
        ) : (
          <div key={m.id} className={`flex gap-2.5 ${isCorner ? "max-w-full" : "max-w-[560px]"}`}>
            <div
              className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg"
              style={{ background: BRAND.orangeTile }}
              aria-hidden="true"
            >
              <Sparkles className="h-[13px] w-[13px]" style={{ color: BRAND.orange }} />
            </div>
            <div className="min-w-0 whitespace-pre-wrap rounded-2xl rounded-tl-sharp border border-hairline-strong bg-surface-sunken px-4 py-3.5 text-[13.5px] leading-relaxed text-ink-muted">
              {m.error ? <span className="text-destructive">{m.error}</span> : m.text}
              {/* cache_read_input_tokens is the only visible proof the prefix is being reused.
                  Shown per answer because a prefix that quietly stopped matching looks
                  identical from here and costs about ten times as much. */}
              {m.usage && (
                <span className="mt-2 block text-[11px] text-ink-subtle">
                  {m.usage.cache_read_input_tokens
                    ? `${m.usage.cache_read_input_tokens.toLocaleString()} tokens read from cache`
                    : "no cache read on this turn"}
                  {m.usage.cache_creation_input_tokens
                    ? ` · ${m.usage.cache_creation_input_tokens.toLocaleString()} written`
                    : ""}
                  {m.usage.output_tokens ? ` · ${m.usage.output_tokens.toLocaleString()} out` : ""}
                </span>
              )}
            </div>
          </div>
        ),
      )}
      {sending && (
        // The dots are decoration and say nothing the label does not, so they are motion-safe
        // and aria-hidden; the sentence is the accessible status.
        <div className="flex items-center gap-2.5 pl-[36px]">
          <span className="flex gap-1" aria-hidden="true">
            <span className="h-[5px] w-[5px] rounded-full bg-ink-subtle motion-safe:animate-typing-dot" />
            <span className="h-[5px] w-[5px] rounded-full bg-ink-subtle motion-safe:animate-typing-dot [animation-delay:0.15s]" />
            <span className="h-[5px] w-[5px] rounded-full bg-ink-subtle motion-safe:animate-typing-dot [animation-delay:0.3s]" />
          </span>
          <span className="text-[11px] text-ink-subtle">
            Reading {clientName}&rsquo;s record…
          </span>
        </div>
      )}
      <div ref={endRef} />
    </>
  );

  // Clear the current attachment — the chip's × button, and the mode-switch when the reader opens
  // manual paste while a file chip is up (the two share the one `pasted` slot).
  const removeAttachment = () => {
    // Supersede any in-flight extraction so a late result cannot re-attach a document the reader just
    // cleared — AND clear the busy flag, like loadThread/newConversation. Without the reset, clearing
    // the chip while a *second* pick is extracting would strand `attaching` true (its request's
    // isCurrent() finally now fails), soft-locking the composer.
    attachTokenRef.current += 1;
    setAttaching(false);
    setPasted("");
    setPasteLabel("");
    setAttachedFile(null);
    setShowPaste(false);
  };

  const errorBanner = error && (
    <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-[13px] text-amber-900 ring-1 ring-amber-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <p>{error}</p>
    </div>
  );

  // An uploaded FILE shows as a clean chip (filename + type + remove), never a raw-text dump (#5). The
  // body still rides the `pasted` slot to the server unchanged; only the presentation differs. Because
  // it is a chip from the moment of attach, it never "hangs around as raw text" during a turn (#6) — it
  // simply clears on a successful send like the manual paste does.
  const attachmentChip = attachedFile && (
    <div className="flex items-center gap-2 rounded-xl border border-edge bg-white px-3 py-2 shadow-card">
      <FileText className="h-4 w-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{attachedFile.name}</span>
      <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-subtle">
        {attachedFile.type}
      </span>
      <button
        type="button"
        onClick={removeAttachment}
        aria-label="Remove attachment"
        className="shrink-0 rounded p-0.5 text-ink-subtle transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/60"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );

  // Manual paste keeps the editable label + textarea — a hand-typed paste is text the reader wants to
  // see and reword, not a discrete file. Gated on `!attachedFile` so it never renders over a file chip.
  const manualPastePanel = showPaste && !attachedFile && (
    <div className="space-y-2 rounded-2xl border border-brand-navy/[0.08] bg-white p-4 shadow-card">
      <p className="text-[12.5px] text-muted-foreground">
        Pasted content is framed as untrusted third-party text and dated today. Any instruction
        inside it is quoted material, not a request.
      </p>
      <input
        value={pasteLabel}
        onChange={(e) => setPasteLabel(e.target.value)}
        placeholder="What is this? (e.g. email thread with the ED, 6 Aug)"
        // `bg-surface-sunken`, not `bg-brand-surface-sunken`: `surface` is a TOP-LEVEL
        // token, so the brand-prefixed spelling names no colour and Tailwind emits
        // nothing for it -- these two fields have had no fill since brick 2.
        className="w-full rounded-xl border border-edge bg-surface-sunken px-3 py-2 text-[13px]"
      />
      <textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        rows={isCorner ? 4 : 6}
        placeholder="Paste the thread or notes here."
        className="w-full rounded-xl border border-edge bg-surface-sunken px-3 py-2 text-[13px]"
      />
    </div>
  );

  // The chip and the manual panel are mutually exclusive; render whichever is active in the same slot
  // both surfaces already reserve for the paste panel.
  const attachmentArea = (
    <>
      {attachmentChip}
      {manualPastePanel}
    </>
  );

  // ── ONE COMPOSER, BOTH SURFACES ──
  //
  // The field and its two actions live inside a single bordered well. That started as a
  // constraint of 404px -- a textarea with buttons beside it does not fit, and buttons stacked
  // under a separate field read as two unrelated rows -- and the full-page mock draws the same
  // object, so the two surfaces now share it outright rather than each having a composer.
  // Only the type and control sizes step up on the page.
  const composer = (
    <div
      className={`shrink-0 rounded-2xl border border-edge bg-surface-sunken ${
        isCorner ? "px-3 py-2.5" : "px-3.5 py-3"
      }`}
    >
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter inserts a newline (standard chat composer). Cmd/Ctrl+Enter
          // still sends too, so the old shortcut keeps working. TWO IME guards, not one: while an
          // IME candidate is open, Enter CONFIRMS the candidate and must not send. `isComposing`
          // covers that on well-behaved builds, but on some Chromium/Windows builds (crbug.com/
          // 1211849) `compositionend` fires BEFORE the confirming Enter keydown, so `isComposing`
          // already reads false -- `keyCode === 229` (the legacy "IME is processing" sentinel) is
          // still set on that keydown and catches it. send() itself no-ops on empty/while-sending
          // (matching the Send button's disabled state), so a bare Enter on an empty draft does
          // nothing.
          if (
            e.key === "Enter" &&
            !e.shiftKey &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault();
            void send();
          }
        }}
        rows={isCorner ? 2 : 3}
        placeholder={`Ask about ${clientName}…`}
        // Transparent and border-free: the well around it is the input's visible edge, so a
        // second box inside the first is just a box inside a box.
        className={`mb-2.5 w-full resize-none bg-transparent leading-snug text-ink placeholder:text-ink-subtle focus:outline-none ${
          isCorner ? "text-[13px]" : "text-[13.5px]"
        }`}
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Attach lives in the SHARED composer, so it is present in BOTH the corner and the full
              surface (#4) — it used to be a page-only starter. Icon-only to fit the 404px corner. */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={attaching}
            aria-label={attaching ? "Reading file…" : "Attach a file"}
            aria-busy={attaching}
            className={`inline-flex items-center justify-center rounded-lg border border-edge bg-white text-ink-muted transition-colors hover:text-ink disabled:opacity-60 ${
              isCorner ? "h-7 w-7" : "h-8 w-8"
            }`}
          >
            {attaching ? (
              <Loader2 className={`animate-spin ${isCorner ? "h-3 w-3" : "h-3.5 w-3.5"}`} />
            ) : (
              <Paperclip className={isCorner ? "h-3 w-3" : "h-3.5 w-3.5"} />
            )}
          </button>
          <button
            type="button"
            onClick={() => {
              // Manual paste and a file chip share the one slot; opening manual paste drops any file.
              if (attachedFile) removeAttachment();
              setShowPaste((s) => !s);
            }}
            // Disabled while a file is extracting: opening paste mid-extraction would have its content
            // silently overwritten by the late finalizeAttachment (both write the one `pasted` slot).
            disabled={attaching}
            aria-pressed={showPaste}
            className={`inline-flex items-center gap-1.5 rounded-lg border border-edge bg-white font-semibold text-ink-muted transition-colors hover:text-ink disabled:opacity-60 ${
              isCorner ? "h-7 px-2.5 text-[11.5px]" : "h-8 px-3 text-[12.5px]"
            }`}
          >
            <ClipboardPaste className={isCorner ? "h-3 w-3" : "h-3.5 w-3.5"} />
            {pasted.trim() && !attachedFile ? "Paste attached" : "Paste"}
          </button>
        </div>
        <button
          type="button"
          onClick={() => void send()}
          // Also disabled while a file is extracting — sending then would submit the question without
          // the document (send() guards this too; the disabled state makes it visible).
          disabled={sending || attaching || !draft.trim()}
          // orangeFill, NOT orange: this is white type on a solid orange field, which is
          // 3.04:1 on #E4761F and fails AA -- the exact case lib/brand.ts adds orangeFill
          // for. Both mocks specify #E4761F here; both surfaces depart from it the same way,
          // because a Send button that is one shade different between them would be worse
          // than either choice.
          className={`inline-flex items-center gap-1.5 rounded-lg bg-brand-orangeFill font-semibold text-white transition-colors hover:bg-brand-orangeFillHover disabled:opacity-45 ${
            isCorner ? "h-7 px-3 text-[11.5px]" : "h-8 px-4 text-[12.5px]"
          }`}
        >
          <ArrowUp className={isCorner ? "h-3.5 w-3.5" : "h-4 w-4"} /> Send
        </button>
      </div>
      {/* Hidden picker driven by the composer's attach button — present in BOTH surfaces (#4),
          unlike the page-only starter it replaces. Text files read client-side; PDF / .docx are
          extracted server-side (/api/grantbot/extract). Images (PNG/JPG) are the next follow-on
          (issue #465) — they need the vision path, not text extraction. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.docx,.txt,.md,.eml,.csv,.json,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*"
        onChange={handleFileUpload}
        className="hidden"
      />
    </div>
  );

  // Quick actions, page only (no room at 404px), mapped to GrantBot's actual capabilities. They
  // PREFILL the composer and nothing else -- no route, no send, no model call until the staffer
  // reads what was typed and presses Send (putting words in someone's mouth on a grant surface is
  // different from offering them). Attach is no longer here — it moved into the shared composer so
  // both surfaces have it (#4). The draft/assess capabilities activate their tools server-side only
  // when GRANTBOT_ARTIFACTS_ENABLED / GRANTBOT_WEB_FETCH_ENABLED are on; the prompt is real either
  // way, and the model answers in text when a flag is off.
  const starters: { icon: LucideIcon; label: string; action: () => void }[] = [
    {
      icon: FileText,
      label: "Draft a document",
      action: () =>
        setDraft(
          `Draft a document for ${clientName} — a concept proposal, report, or letter. Start with a concept proposal for the grant we're discussing.`,
        ),
    },
    {
      icon: Link2,
      label: "Assess a grant link",
      action: () =>
        setDraft(`Assess this grant against ${clientName} and triage the fit — here's the link: `),
    },
  ];

  if (isCorner) {
    return (
      // Three fixed bands and one scrolling one, so the transcript is the only thing that
      // moves: the toolbar and the composer stay put while an answer arrives.
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-hairline-strong bg-surface-sunken px-[18px] py-3">
          <button
            type="button"
            onClick={() => setShowThreads((s) => !s)}
            aria-pressed={showThreads}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg bg-brand-navy px-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-brand-navyHover"
          >
            <MessagesSquare className="h-3 w-3" /> Conversations
          </button>
          <button
            type="button"
            onClick={newConversation}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-edge px-2.5 text-[12px] font-semibold text-brand-navy transition-colors hover:bg-white"
          >
            <Plus className="h-3 w-3" /> New
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-[18px] py-4">
          {showThreads ? threadList : transcript}
        </div>

        <div className="flex-shrink-0 space-y-2 border-t border-hairline-strong bg-white px-4 pb-3.5 pt-3">
          {errorBanner}
          {attachmentArea}
          {composer}
        </div>
      </div>
    );
  }

  // ── THREE REGIONS, THREE OWNERS OF SCROLL ──
  //
  // The bug this replaces: the whole page scrolled as one document, so the composer and the
  // thread rail slid out of view as a conversation grew -- you had to scroll back up to type.
  // A chat surface has to behave like one: the transcript is the only thing that moves.
  //
  // How it holds: this root is `min-h-0 flex-1` inside the page's own full-height column, so it
  // gets a definite height rather than growing with its content. The rail and the transcript
  // then each carry their OWN overflow-y-auto, which is what makes them independent -- a wheel
  // over the transcript cannot move the rail, and the rail scrolls only under its own cursor.
  // The composer is a shrink-0 sibling below the transcript, so it is pinned by construction
  // rather than by position:fixed and needs no compensating padding.
  //
  // min-h-0 is the load-bearing part and the easiest thing to drop: a flex child's default
  // min-height:auto refuses to shrink below its content, which silently hands the scroll back
  // to the page and restores the exact bug.
  return (
    <div className="flex min-h-0 w-full flex-1 gap-5">
      <aside className="flex w-56 shrink-0 flex-col gap-2 overflow-y-auto pr-0.5">
        {threadList}
      </aside>

      {/* min-h-0 here as well as on the transcript: this column is stretched to the row's
          height, and without it a long transcript can still force it taller than the row and
          hand the scroll back up the tree. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-2xl bg-white px-[26px] py-6 shadow-card">
          {transcript}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {starters.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={s.action}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-pill border border-edge bg-white px-3 text-[12px] font-semibold text-brand-navy transition-colors hover:border-brand-navy/25"
            >
              <s.icon className="h-3 w-3" style={{ color: BRAND.orange }} />
              {s.label}
            </button>
          ))}
        </div>

        {errorBanner}
        {attachmentArea}
        {composer}
      </div>
    </div>
  );
}
