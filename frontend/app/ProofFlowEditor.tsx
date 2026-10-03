"use client";

import { useEffect, useRef, useState } from "react";
import { Bold, Download, FileCheck2, FileText, Plus, RotateCw, Sparkles } from "lucide-react";
import {
  emptyDocument,
  plainText,
  positionFromOffset,
  reconcileText,
  replaceRange,
  toggleBold,
  type EditorDocument,
} from "@/lib/editor-document";
import { samplePrompt, sampleResponse } from "@/lib/demo-ai";

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
type DemoResponse = { id: string; prompt: string; responseText: string; source: "demo_sample" };
type Draft = {
  title: string; document: EditorDocument; events: DraftEvent[];
  documentId?: string; serverVersion?: number; savedEventCount?: number;
  demoAiResponse?: DemoResponse;
  pendingManual?: boolean;
};

const storageKey = "proofflow-local-draft-v1";
const sampleResponseId = "local-demo-response-v1";
const manualIdleMs = 2000;

const newDraft = (): Draft => ({ title: "无标题文档", document: emptyDocument(), events: [] });

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

function finishesSentence(text: string, caret: number): boolean {
  return /[。！？.!?\n]["'”’）\]]?$/.test(text.slice(0, caret));
}

function flushManualEdit(current: Draft): Draft {
  if (!current.pendingManual) return current;
  const text = plainText(current.document);
  return {
    ...current,
    pendingManual: false,
    events: [...current.events, {
      operationId: crypto.randomUUID(),
      type: "MANUAL_EDIT",
      timestamp: new Date().toISOString(),
      snippet: text.slice(0, 72) || "文字已删除",
      contentAfter: current.document,
    }],
  };
}

function eventLabel(type: EventType): string {
  if (type === "PASTE") return "粘贴";
  if (type === "AI_INSERT") return "AI 插入";
  return "手动编辑";
}

export default function ProofFlowEditor() {
  const [draft, setDraft] = useState<Draft>(newDraft);
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState<"connecting" | "saving" | "saved" | "error">("connecting");
  const [retryToken, setRetryToken] = useState(0);
  const [hoveredEventId, setHoveredEventId] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const compositionStart = useRef<EditorDocument | null>(null);
  const creating = useRef(false);
  const saving = useRef(false);
  const draftRef = useRef(draft);

  useEffect(() => { draftRef.current = draft; }, [draft]);

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
        return response.json() as Promise<{ version: number; demoAiResponse: DemoResponse }>;
      })
      .then((server) => {
        if (!active) return;
        setDraft((current) => current.demoAiResponse ? current : { ...current, demoAiResponse: server.demoAiResponse });
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
      body: JSON.stringify({ title: draft.title || "无标题文档", editorSchemaVersion: 1, contentJson: emptyDocument() }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Create failed: ${response.status}`);
      return response.json() as Promise<{ id: string; version: number; demoAiResponse: DemoResponse }>;
    }).then((created) => {
      setDraft((current) => ({
        ...current,
        documentId: created.id,
        serverVersion: created.version,
        savedEventCount: 0,
        demoAiResponse: created.demoAiResponse,
        events: current.events.map((event) => event.aiResponseId === sampleResponseId
          ? { ...event, aiResponseId: created.demoAiResponse.id }
          : event),
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

  const recordManualEdit = (nextText: string, caret: number) => {
    setDraft((current) => {
      const nextDocument = reconcileText(current.document, nextText);
      if (plainText(nextDocument) === plainText(current.document)) return current;
      const next = { ...current, document: nextDocument, pendingManual: true };
      return finishesSentence(nextText, caret) ? flushManualEdit(next) : next;
    });
  };

  const insertText = (type: "PASTE" | "AI_INSERT", insertedText: string) => {
    if (!insertedText) return;
    setSaveState("saving");
    const input = textareaRef.current;
    const start = input?.selectionStart ?? plainText(draft.document).length;
    const end = input?.selectionEnd ?? start;
    setDraft((current) => {
      current = flushManualEdit(current);
      const operationId = crypto.randomUUID();
      const nextDocument = replaceRange(current.document, start, end, insertedText, {
        sourceOperationId: operationId,
        bold: type === "AI_INSERT",
      });
      const event: DraftEvent = {
        operationId,
        type,
        timestamp: new Date().toISOString(),
        snippet: insertedText.replace(/\s+/g, " ").slice(0, 72),
        insertedText,
        insertPosition: positionFromOffset(current.document, start),
        ...(end > start ? { replacedLength: end - start } : {}),
        ...(type === "AI_INSERT" ? { aiResponseId: current.demoAiResponse?.id ?? sampleResponseId } : {}),
        contentAfter: nextDocument,
      };
      return { ...current, document: nextDocument, events: [...current.events, event] };
    });
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + insertedText.length, start + insertedText.length);
    });
  };

  const handleBold = () => {
    const input = textareaRef.current;
    if (!input || input.selectionStart === input.selectionEnd) return;
    setSaveState("saving");
    setDraft((current) => {
      current = flushManualEdit(current);
      const nextDocument = toggleBold(current.document, input.selectionStart, input.selectionEnd);
      return {
        ...current,
        document: nextDocument,
        events: [
          ...current.events,
          {
            operationId: crypto.randomUUID(),
            type: "MANUAL_EDIT",
            timestamp: new Date().toISOString(),
            snippet: "加粗格式已更改",
            contentAfter: nextDocument,
          },
        ],
      };
    });
    input.focus();
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
      aiResponses: draft.events.some((event) => event.type === "AI_INSERT")
        ? [draft.demoAiResponse ?? { id: sampleResponseId, prompt: samplePrompt, responseText: sampleResponse, source: "local_demo" }]
        : [],
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
        <div className="brand"><span className="brand-mark"><FileCheck2 size={19} strokeWidth={2.4} /></span><span>ProofFlow</span></div>
        <div className="topbar-right">
          <span className="draft-status"><span className={`status-dot ${saveState}`} /> {saveState === "error" ? "保存失败" : saveState === "saving" ? "保存中" : saveState === "connecting" ? "连接中" : "正文已保存 · 未验证"}</span>
          {saveState === "error" && <button className="icon-button" onClick={() => { setSaveState("connecting"); setRetryToken((token) => token + 1); }} title="重试保存" aria-label="重试保存"><RotateCw size={17} /></button>}
          <button className="icon-button export-button" onClick={exportDraft} title="导出本地 JSON 草稿" aria-label="导出本地 JSON 草稿"><Download size={18} /></button>
          <button className="certificate-button" disabled title="尚未接通后端保存、验证及证书签发"><FileCheck2 size={16} />生成证书</button>
        </div>
      </header>

      <main className="workspace">
        <section className="editor-pane" aria-label="文档编辑器">
          <div className="pane-heading">
            <div className="heading-title"><FileText size={17} /> 文档</div>
            <span className="quiet-label">JSON editor · schema v1</span>
          </div>
          <div className="editor-scroll">
            <div className="document-sheet">
              <input className="document-title" aria-label="文档标题" title="标题变更暂仅保存在此浏览器" value={draft.title} onChange={(event) => {
                const title = event.currentTarget.value;
                setDraft((current) => ({ ...current, title }));
              }} />
              <div className="editor-toolbar"><button className="tool-button" title="加粗选中的文字" aria-label="加粗选中的文字" onMouseDown={(event) => event.preventDefault()} onClick={handleBold}><Bold size={17} /></button><span className="toolbar-divider" /><span className="toolbar-note">选中文字后可加粗</span></div>
              <textarea
                ref={textareaRef}
                className="document-input"
                aria-label="文档正文"
                placeholder="开始写作..."
                spellCheck={false}
                value={plainText(draft.document)}
                onChange={(event) => {
                  const nextText = event.target.value;
                  if (compositionStart.current) {
                    setDraft((current) => ({ ...current, document: reconcileText(current.document, nextText) }));
                  } else recordManualEdit(nextText, event.currentTarget.selectionStart);
                }}
                onCompositionStart={() => { compositionStart.current = draft.document; }}
                onCompositionEnd={(event) => {
                  const before = compositionStart.current;
                  compositionStart.current = null;
                  if (!before) return;
                  const nextText = event.currentTarget.value;
                  const nextDocument = reconcileText(before, nextText);
                  if (plainText(nextDocument) === plainText(before)) return;
                  setDraft((current) => ({
                    ...current,
                    document: nextDocument,
                    pendingManual: true,
                  }));
                  if (finishesSentence(nextText, event.currentTarget.selectionStart)) {
                    setDraft((current) => flushManualEdit(current));
                  }
                }}
                onBlur={() => setDraft((current) => flushManualEdit(current))}
                onPaste={(event) => {
                  event.preventDefault();
                  insertText("PASTE", event.clipboardData.getData("text/plain"));
                }}
              />
              <div className="document-footer"><span>{plainText(draft.document).length} 字符</span><span>{draft.documentId ? `正文服务端版本 ${draft.serverVersion ?? 0}` : "等待建立文档"}</span></div>
            </div>

            <section className="source-section" aria-label="来源标记预览">
              <div className="section-heading"><h2>来源标记</h2><span>悬停查看对应事件</span></div>
              <div className="source-body">
                {plainText(draft.document) ? draft.document.content.map((paragraph, paragraphIndex) => (
                  <p key={paragraphIndex}>{paragraph.content.length ? paragraph.content.map((node, index) => (
                    <span
                      key={index}
                      className={`source-span ${node.sourceOperationId ? "has-source" : ""} ${hoveredEventId === node.sourceOperationId ? "is-linked" : ""}`}
                      onMouseEnter={() => node.sourceOperationId && setHoveredEventId(node.sourceOperationId)}
                      onMouseLeave={() => setHoveredEventId(null)}
                      title={node.sourceOperationId ? `操作 ${node.sourceOperationId}` : undefined}
                    >{node.marks?.some((mark) => mark.type === "bold") ? <strong>{node.text}</strong> : node.text}</span>
                  )) : <br />}</p>
                )) : <span className="source-empty">正文内容会显示在这里</span>}
              </div>
            </section>
          </div>
        </section>

        <aside className="side-pane" aria-label="AI 助手和创建时间线">
          <div className="assistant-panel">
            <div className="section-heading"><h2><Sparkles size={17} /> AI 助手</h2><span className="demo-tag">本地示例</span></div>
            <div className="prompt-line">{draft.demoAiResponse?.prompt ?? samplePrompt}</div>
            <p className="response-copy">{draft.demoAiResponse?.responseText ?? sampleResponse}</p>
            <button className="insert-button" onClick={() => insertText("AI_INSERT", draft.demoAiResponse?.responseText ?? sampleResponse)}><Plus size={17} />插入到文档</button>
          </div>
          <div className="timeline-panel">
            <div className="section-heading"><h2>创建时间线</h2><span>{draft.events.length} 条本地事件</span></div>
            <div className="timeline-list">
              {draft.events.length ? [...draft.events].reverse().map((event) => (
                <div
                  className={`timeline-item ${hoveredEventId === event.operationId ? "is-linked" : ""}`}
                  key={event.operationId}
                  onMouseEnter={() => setHoveredEventId(event.operationId)}
                  onMouseLeave={() => setHoveredEventId(null)}
                >
                  <span className={`timeline-node ${event.type.toLowerCase()}`} />
                  <div className="timeline-content"><div className="timeline-meta"><strong>{eventLabel(event.type)}</strong><time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p>{event.snippet}</p><code>{event.operationId.slice(0, 8)}</code></div>
                </div>
              )) : <div className="timeline-empty">开始编辑后，这里会显示操作记录。</div>}
            </div>
          </div>
          <div className="side-footer">本机 Demo 使用 SQLite；尚无用户鉴权、签名与证书签发。</div>
        </aside>
      </main>
      {exported && <div className="toast" role="status">JSON 草稿已导出</div>}
    </div>
  );
}
