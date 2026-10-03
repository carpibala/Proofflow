"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ClipboardPaste, Download, FileCheck2, FileText, Keyboard, Languages, RotateCw, Sparkles } from "lucide-react";
import {
  emptyDocument,
  plainText,
  positionFromOffset,
  reconcileText,
  replaceRange,
  type EditorDocument,
} from "@/lib/editor-document";
import { manualChangeSnippet } from "@/lib/change-preview";
import { translations, type Language } from "@/lib/i18n";
import ChangePreview from "./ChangePreview";
import RecordExplorer from "./RecordExplorer";

type EventType = "MANUAL_EDIT" | "PASTE" | "AI_INSERT";
type DraftEvent = {
  operationId: string;
  type: EventType;
  timestamp: string;
  snippet: string;
  contentAfter: EditorDocument;
  insertedText?: string;
  insertPosition?: { path: number[]; offset: number };
  replacedLength?: number;
  aiResponseId?: string;
};
type Draft = {
  title: string; document: EditorDocument; events: DraftEvent[];
  documentId?: string; serverVersion?: number; savedEventCount?: number;
  status?: "draft" | "finalized";
  pendingManual?: boolean;
};

const storageKey = "proofflow-local-draft-v1";
const languageKey = "proofflow-ui-language";
const manualIdleMs = 2000;

const newDraft = (): Draft => ({ title: "", document: emptyDocument(), events: [] });

function isDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<Draft>;
  return (
    typeof draft.title === "string" &&
    draft.document?.type === "doc" &&
    Array.isArray(draft.document.content) &&
    draft.document.content.every(
      (paragraph) =>
        paragraph.type === "paragraph" &&
        Array.isArray(paragraph.content) &&
        paragraph.content.every((node) => node.type === "text" && typeof node.text === "string"),
    ) &&
    Array.isArray(draft.events) &&
    (draft.pendingManual === undefined || typeof draft.pendingManual === "boolean")
  );
}

function insertedPunctuation(before: string, after: string): boolean {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return /[\p{P}\n]/u.test(after.slice(start, after.length - end));
}

function flushManualEdit(current: Draft): Draft {
  if (!current.pendingManual || current.status === "finalized") return current;
  const before = current.events.at(-1)?.contentAfter ?? emptyDocument();
  return {
    ...current,
    pendingManual: false,
    events: [...current.events, {
      operationId: crypto.randomUUID(),
      type: "MANUAL_EDIT",
      timestamp: new Date().toISOString(),
      snippet: manualChangeSnippet(plainText(before), plainText(current.document)),
      contentAfter: current.document,
    }],
  };
}

export default function ProofFlowEditor() {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [language, setLanguage] = useState<Language>("zh");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"connecting" | "saving" | "saved" | "error">("connecting");
  const [retryToken, setRetryToken] = useState(0);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const [reportRequested, setReportRequested] = useState(false);
  const [sideView, setSideView] = useState<"timeline" | "records">("timeline");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionStart = useRef<EditorDocument | null>(null);
  const creating = useRef(false);
  const saving = useRef(false);
  const draftRef = useRef(draft);
  const t = translations[language];

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = localStorage.getItem(languageKey);
        if (saved === "zh" || saved === "en") {
          setLanguage(saved);
          document.documentElement.lang = saved === "zh" ? "zh-CN" : "en";
        }
      } catch {
        // Language preference is optional when browser storage is unavailable.
      }
    });
    return () => { active = false; };
  }, []);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem(languageKey, next); } catch { /* Continue without persistence. */ }
  };

  useEffect(() => { draftRef.current = draft; }, [draft]);

  useEffect(() => {
    if (reportRequested && draft.documentId && !draft.pendingManual &&
        (draft.savedEventCount ?? 0) === draft.events.length && saveState === "saved") {
      router.push(`/report/${draft.documentId}`);
    }
  }, [reportRequested, draft.documentId, draft.pendingManual, draft.savedEventCount, draft.events.length, saveState, router]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed: unknown = JSON.parse(saved);
          if (isDraft(parsed)) setDraft(parsed);
        }
      } catch {
        // A corrupt local draft must not prevent editing.
      }
      setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (loaded) localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, loaded]);

  useEffect(() => {
    if (!loaded || !draft.pendingManual) return;
    const timeout = window.setTimeout(() => setDraft((current) => flushManualEdit(current)), manualIdleMs);
    return () => window.clearTimeout(timeout);
  }, [draft.document, draft.pendingManual, loaded]);

  useEffect(() => {
    if (draft.pendingManual) queueMicrotask(() => setSaveState("saving"));
  }, [draft.pendingManual]);

  useEffect(() => {
    const savePendingOnExit = () => {
      if (draftRef.current.pendingManual) {
        localStorage.setItem(storageKey, JSON.stringify(flushManualEdit(draftRef.current)));
      }
    };
    window.addEventListener("pagehide", savePendingOnExit);
    return () => window.removeEventListener("pagehide", savePendingOnExit);
  }, []);

  useEffect(() => {
    if (!loaded || !draft.documentId) return;
    let active = true;
    fetch(`/api/documents/${draft.documentId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Read failed: ${response.status}`);
        return response.json() as Promise<{ title: string; version: number; status: "draft" | "finalized"; contentJson: EditorDocument }>;
      })
      .then((server) => {
        if (!active) return;
        setDraft((current) => ({ ...current, status: server.status,
          ...(server.status === "finalized" && (current.savedEventCount ?? 0) === current.events.length &&
            current.serverVersion === server.version ? { document: server.contentJson, title: server.title } : {}),
        }));
        const current = draftRef.current;
        if (!saving.current && (current.savedEventCount ?? 0) === current.events.length) {
          setSaveState(server.version === current.serverVersion ? "saved" : "error");
        }
      })
      .catch(() => { if (active) setSaveState("error"); });
    return () => { active = false; };
  }, [draft.documentId, loaded]);

  useEffect(() => {
    if (!loaded || creating.current || draft.documentId) return;
    creating.current = true;
    fetch("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: draft.title || "Untitled document", editorSchemaVersion: 1, contentJson: emptyDocument() }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Create failed: ${response.status}`);
      return response.json() as Promise<{ id: string; version: number }>;
    }).then((created) => {
      setDraft((current) => ({
        ...current,
        documentId: created.id,
        serverVersion: created.version,
        savedEventCount: 0,
      }));
      if (!draftRef.current.pendingManual) setSaveState("saved");
    }).catch(() => { creating.current = false; setSaveState("error"); });
  }, [draft, loaded, retryToken]);

  useEffect(() => {
    if (!loaded || !draft.documentId || saving.current) return;
    if ((draft.savedEventCount ?? 0) >= draft.events.length) return;
    saving.current = true;
    queueMicrotask(() => setSaveState("saving"));
    const flush = async () => {
      while (true) {
        const current = draftRef.current;
        const index = current.savedEventCount ?? 0;
        const event = current.events[index];
        if (!event || !current.documentId) break;
        const { contentAfter, ...eventFields } = event;
        const response = await fetch(`/api/documents/${current.documentId}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ documentId: current.documentId, baseVersion: current.serverVersion ?? 0, event: eventFields, contentJson: contentAfter }),
        });
        if (!response.ok) throw new Error(`Save failed: ${response.status}`);
        const saved = await response.json() as { version: number };
        setDraft((latest) => ({ ...latest, serverVersion: saved.version, savedEventCount: index + 1 }));
        draftRef.current = { ...draftRef.current, serverVersion: saved.version, savedEventCount: index + 1 };
      }
      if (!draftRef.current.pendingManual) setSaveState("saved");
    };
    void flush().catch(() => setSaveState("error")).finally(() => { saving.current = false; });
  }, [draft, loaded, retryToken]);

  const recordManualEdit = (nextText: string) => {
    setDraft((current) => {
      if (current.status === "finalized") return current;
      const beforeText = plainText(current.document);
      const nextDocument = reconcileText(current.document, nextText);
      if (plainText(nextDocument) === beforeText) return current;
      const next = { ...current, document: nextDocument, pendingManual: true };
      return insertedPunctuation(beforeText, nextText) ? flushManualEdit(next) : next;
    });
  };

  const insertPasteText = (insertedText: string) => {
    if (!insertedText || draft.status === "finalized") return;
    setSaveState("saving");
    const input = textareaRef.current;
    const start = input?.selectionStart ?? plainText(draft.document).length;
    const end = input?.selectionEnd ?? start;
    setDraft((current) => {
      current = flushManualEdit(current);
      const operationId = crypto.randomUUID();
      const nextDocument = replaceRange(current.document, start, end, insertedText, { sourceOperationId: operationId });
      const event: DraftEvent = {
        operationId,
        type: "PASTE",
        timestamp: new Date().toISOString(),
        snippet: insertedText.replace(/\s+/g, " ").slice(0, 72),
        insertedText,
        insertPosition: positionFromOffset(current.document, start),
        ...(end > start ? { replacedLength: end - start } : {}),
        contentAfter: nextDocument,
      };
      return { ...current, document: nextDocument, events: [...current.events, event] };
    });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + insertedText.length, start + insertedText.length);
    });
  };

  const exportDraft = () => {
    const payload = {
      format: "proof-flow-json",
      editorSchemaVersion: 1,
      status: draft.documentId && (draft.savedEventCount ?? 0) === draft.events.length ? "server_saved_unverified" : "local_draft_unverified",
      documentId: draft.documentId ?? null,
      serverVersion: draft.serverVersion ?? null,
      savedEventCount: draft.savedEventCount ?? 0,
      title: draft.title,
      contentJson: draft.document,
      events: draft.events,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "proofflow-local-draft.json";
    link.click();
    URL.revokeObjectURL(url);
    setExported(true);
    window.setTimeout(() => setExported(false), 2500);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-primary">
          <div className="brand"><span className="brand-mark"><FileCheck2 size={20} strokeWidth={2.3} /></span><span>ProofFlow</span></div>
          <div className="topbar-document" title={draft.title || t.untitled}><FileText size={16} /><span>{draft.title || t.untitled}</span></div>
        </div>
        <div className="topbar-right">
          <div className="language-switch" role="group" aria-label={t.language}><Languages size={15} aria-hidden="true" /><button type="button" aria-pressed={language === "zh"} onClick={() => changeLanguage("zh")}>{t.chinese}</button><button type="button" aria-pressed={language === "en"} onClick={() => changeLanguage("en")}>{t.english}</button></div>
          <span className="draft-status" role="status"><span className={`status-dot ${draft.status === "finalized" ? "saved" : saveState}`} />{saveState === "error" ? t.saveError : draft.status === "finalized" ? t.frozen : saveState === "saving" ? t.saving : saveState === "connecting" ? t.connecting : t.saved}</span>
          {saveState === "error" && <button className="icon-button" onClick={() => { setSaveState("connecting"); setRetryToken((token) => token + 1); }} title={t.retrySave} aria-label={t.retrySave}><RotateCw size={17} /></button>}
          <button className="certificate-button" type="button" disabled={!draft.documentId || reportRequested} title={t.certificateHint} onClick={() => {
            setDraft((current) => flushManualEdit(current));
            setReportRequested(true);
          }}><FileCheck2 size={16} />{reportRequested ? t.reportOpening : t.certificate}</button>
          {reportRequested && saveState === "error" && <button className="icon-button" type="button" onClick={() => setReportRequested(false)} title={t.reportCancel} aria-label={t.reportCancel}>×</button>}
          <button className="export-button" onClick={exportDraft} title={t.exportDraftHint} aria-label={t.exportDraftHint}><Download size={17} />{t.exportDraft}</button>
        </div>
      </header>

      <main className="workspace">
        <section className="editor-pane" aria-label={t.editor}>
          <div className="pane-heading">
            <div className="heading-title"><FileText size={17} />{t.document}</div>
            <span className="pane-counter">{t.characters(plainText(draft.document).length)}</span>
          </div>
          <div className="editor-scroll">
            <div className="document-sheet">
              <input className="document-title" aria-label={t.title} title={t.titleHint} placeholder={t.untitled} value={draft.title} disabled={draft.status === "finalized"} onChange={(event) => {
                const title = event.currentTarget.value;
                setDraft((current) => ({ ...current, title }));
              }} />
              <textarea
                ref={textareaRef}
                className="document-input"
                aria-label={t.body}
                placeholder={t.bodyPlaceholder}
                disabled={draft.status === "finalized"}
                spellCheck={false}
                value={plainText(draft.document)}
                onChange={(event) => {
                  const nextText = event.target.value;
                  if (compositionStart.current) {
                    setDraft((current) => ({ ...current, document: reconcileText(current.document, nextText) }));
                  } else recordManualEdit(nextText);
                }}
                onCompositionStart={() => { compositionStart.current = draft.document; }}
                onCompositionEnd={(event) => {
                  const before = compositionStart.current;
                  compositionStart.current = null;
                  if (!before) return;
                  const nextText = event.currentTarget.value;
                  const nextDocument = reconcileText(before, nextText);
                  if (plainText(nextDocument) === plainText(before)) return;
                  setDraft((current) => {
                    const next = { ...current, document: nextDocument, pendingManual: true };
                    return insertedPunctuation(plainText(before), nextText) ? flushManualEdit(next) : next;
                  });
                }}
                onBlur={() => setDraft((current) => flushManualEdit(current))}
                onPaste={(event) => {
                  event.preventDefault();
                  insertPasteText(event.clipboardData.getData("text/plain"));
                }}
              />
              <div className="document-footer"><span>{t.characters(plainText(draft.document).length)}</span><span>{draft.documentId ? t.serverVersion(draft.serverVersion ?? 0) : t.waitingDocument}</span></div>
            </div>

            <section className="source-section" aria-label={t.source}>
              <div className="section-heading"><h2><FileText size={16} />{t.source}</h2></div>
              <div className="source-body">
                {plainText(draft.document) ? draft.document.content.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex}>{paragraph.content.length ? paragraph.content.map((node, index) => (
                    <span
                      key={index}
                      className={`source-span ${node.sourceOperationId ? "has-source" : ""} ${hoveredEventId === node.sourceOperationId ? "is-linked" : ""}`}
                      onMouseEnter={() => node.sourceOperationId && setHoveredEventId(node.sourceOperationId)}
                      onMouseLeave={() => setHoveredEventId(null)}
                      title={node.sourceOperationId ? t.operation(node.sourceOperationId) : undefined}
                    >{node.marks?.some((mark) => mark.type === "bold") ? <strong>{node.text}</strong> : node.text}</span>
                  )) : <br />}</p>
                )) : <span className="source-empty">{t.sourceEmpty}</span>}
              </div>
            </section>
          </div>
        </section>

        <aside className="side-pane" aria-label={t.sidePane}>
          <div className="timeline-panel">
            <div className="side-heading"><div className="side-tabs" role="tablist" aria-label={t.recordViews}><button type="button" role="tab" aria-selected={sideView === "timeline"} onClick={() => setSideView("timeline")}>{t.timeline}</button><button type="button" role="tab" aria-selected={sideView === "records"} onClick={() => setSideView("records")}>{t.records}</button></div>{sideView === "timeline" && <span className="event-count" title={t.localEvents(draft.events.length)}>{draft.events.length}</span>}</div>
            {sideView === "timeline" ? <div className="timeline-list" role="tabpanel" aria-label={t.timeline}>
              {draft.events.length ? [...draft.events].reverse().map((event, reverseIndex) => (
                <div
                  className={`timeline-item ${hoveredEventId === event.operationId ? "is-linked" : ""}`}
                  key={event.operationId}
                  onMouseEnter={() => setHoveredEventId(event.operationId)}
                  onMouseLeave={() => setHoveredEventId(null)}
                >
                  <time className="timeline-time" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString(language === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hour12: false })}</time>
                  <span className={`timeline-node ${event.type.toLowerCase()}`} />
                  <span className={`timeline-icon ${event.type.toLowerCase()}`}>{event.type === "PASTE" ? <ClipboardPaste size={17} /> : event.type === "AI_INSERT" ? <Sparkles size={17} /> : <Keyboard size={17} />}</span>
                  <div className="timeline-content"><strong>{t.events[event.type]}</strong>{event.type === "AI_INSERT" ? <p>{event.snippet}</p> : <ChangePreview language={language} type={event.type} before={draft.events[draft.events.length - reverseIndex - 2]?.contentAfter ?? emptyDocument()} after={event.contentAfter} fallback={event.snippet} insertedText={event.insertedText} insertPosition={event.insertPosition} replacedLength={event.replacedLength} />}<code>{event.operationId.slice(0, 8)}</code></div>
                </div>
              )) : <div className="timeline-empty">{t.timelineEmpty}</div>}
            </div> : <RecordExplorer language={language} documentId={draft.documentId} savedEventCount={draft.savedEventCount ?? 0} pendingCount={Math.max(0, draft.events.length - (draft.savedEventCount ?? 0)) + (draft.pendingManual ? 1 : 0)} onHover={setHoveredEventId} />}
          </div>
          <div className="side-footer">{t.localDemo}</div>
        </aside>
      </main>
      {exported && <div className="toast" role="status">{t.exported}</div>}
    </div>
  );
}
