"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, ClipboardPaste, Download, FileCheck2, FileText, Languages, LockKeyhole, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { emptyDocument, type EditorDocument } from "@/lib/editor-document";
import { translations, type Language } from "@/lib/i18n";
import { summarizeChanges, type ReportEvent } from "@/lib/report-stats";
import ChangePreview from "@/app/ChangePreview";
import { useUser, draftStorageKey } from "@/app/AuthGate";

type DocumentData = { id: string; title: string; version: number; status: "draft" | "finalized"; finalizedAt: string | null; contentJson: EditorDocument };
type Verification = { valid: boolean; checkedEvents: number; headHash: string; code?: string; message?: string };
type ReportData = { document: DocumentData; events: ReportEvent[]; verification: Verification };

const languageKey = "proofflow-ui-language";

async function readJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export default function ReportPage() {
  const user = useUser();
  const storageKey = draftStorageKey(user.id);
  const { documentId } = useParams<{ documentId: string }>();
  const [language, setLanguage] = useState<Language>("zh");
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pendingLocal, setPendingLocal] = useState(false);
  const t = translations[language];
  const labels = t.report;

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = localStorage.getItem(languageKey);
        if (saved === "zh" || saved === "en") {
          setLanguage(saved);
          document.documentElement.lang = saved === "zh" ? "zh-CN" : "en";
        }
      } catch { /* Language selection still works without storage. */ }
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setError(false); } });
    const base = `/api/documents/${encodeURIComponent(documentId)}`;
    void Promise.all([
      readJson<DocumentData>(base, controller.signal),
      readJson<{ events: ReportEvent[] }>(`${base}/events`, controller.signal),
      readJson<Verification>(`${base}/verify`, controller.signal),
    ]).then(([savedDocument, history, verification]) => {
      if (!controller.signal.aborted) setReport({ document: savedDocument, events: history.events, verification });
    }).catch(() => { if (!controller.signal.aborted) { setReport(null); setError(true); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [documentId, reload]);

  const summary = useMemo(() => report ? summarizeChanges(report.events) : null, [report]);
  const inconsistentSnapshot = Boolean(report && report.verification.valid &&
    (report.document.version !== report.events.length || report.verification.checkedEvents !== report.events.length));
  const valid = Boolean(report?.verification.valid && !inconsistentSnapshot);
  const failureCode = report?.verification.code;
  const failureReason = failureCode && failureCode in labels.failureReasons
    ? labels.failureReasons[failureCode as keyof typeof labels.failureReasons]
    : report?.verification.message;

  useEffect(() => {
    if (!report) return;
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(storageKey);
        const draft = raw ? JSON.parse(raw) as { documentId?: string; pendingManual?: boolean; events?: unknown[]; savedEventCount?: number; serverVersion?: number } : null;
        setPendingLocal(Boolean(draft && draft.documentId === report.document.id &&
          (draft.pendingManual || (draft.events?.length ?? 0) > (draft.savedEventCount ?? 0) || draft.serverVersion !== report.document.version)));
      } catch { setPendingLocal(false); }
    });
  }, [report, storageKey]);

  const finalize = async () => {
    if (!report || !valid || pendingLocal) return;
    setFinalizing(true);
    setActionError("");
    try {
      let title = report.document.title;
      try {
        const raw = localStorage.getItem(storageKey);
        const local = raw ? JSON.parse(raw) as { documentId?: string; title?: string } : null;
        if (local?.documentId === report.document.id && local.title?.trim()) title = local.title.trim();
      } catch { /* The server title remains available without local storage. */ }
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/finalize`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedVersion: report.document.version, title }),
      });
      if (!response.ok) {
        const error = await response.json() as { error?: string };
        throw new Error(error.error ?? `HTTP ${response.status}`);
      }
      setConfirmFreeze(false);
      setReload((value) => value + 1);
    } catch (error) {
      setActionError(`${labels.freezeFailed} ${error instanceof Error ? error.message : ""}`);
    } finally { setFinalizing(false); }
  };

  const downloadBundle = async () => {
    if (!report || !valid || report.document.status !== "finalized") return;
    setDownloading(true);
    setActionError("");
    try {
      const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/bundle`, { cache: "no-store" });
      if (!response.ok) {
        const error = await response.json() as { error?: string };
        throw new Error(error.error ?? `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `proofflow-evidence-${documentId}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setActionError(`${labels.downloadFailed} ${error instanceof Error ? error.message : ""}`);
    } finally { setDownloading(false); }
  };

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    try { localStorage.setItem(languageKey, next); } catch { /* Continue without persistence. */ }
  };

  return (
    <div className="app-shell report-page">
      <header className="topbar report-topbar">
        <div className="topbar-primary">
          <Link className="brand report-brand" href="/"><span className="brand-mark"><FileCheck2 size={20} strokeWidth={2.3} /></span><span>ProofFlow</span></Link>
          <div className="topbar-document"><FileText size={16} /><span>{report?.document.title && report.document.title !== "Untitled document" ? report.document.title : t.untitled}</span></div>
        </div>
        <div className="topbar-right">
          <div className="language-switch" role="group" aria-label={t.language}><Languages size={15} aria-hidden="true" /><button type="button" aria-pressed={language === "zh"} onClick={() => changeLanguage("zh")}>{t.chinese}</button><button type="button" aria-pressed={language === "en"} onClick={() => changeLanguage("en")}>{t.english}</button></div>
          <Link className="report-back" href="/"><ArrowLeft size={16} />{labels.back}</Link>
        </div>
      </header>

      <main className="report-main">
        {report && !error && <div className="report-watermark-layer" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => <span key={index}>@{user.username}</span>)}
        </div>}
        <div className="report-intro">
          <div><span className="report-eyebrow">ProofFlow / Report</span><h1>{labels.title}</h1><p>{labels.subtitle}</p></div>
          <div className="report-actions">
            <button className="report-refresh" type="button" onClick={() => setReload((value) => value + 1)} disabled={loading}><RefreshCw size={16} />{labels.refresh}</button>
            {report?.document.status === "draft" && <button className="report-freeze" type="button" onClick={() => setConfirmFreeze(true)} disabled={loading || !valid || pendingLocal || finalizing}><LockKeyhole size={16} />{labels.freeze}</button>}
            {report?.document.status === "finalized" && <button className="report-freeze" type="button" onClick={downloadBundle} disabled={loading || !valid || downloading}><Download size={16} />{downloading ? labels.downloading : labels.download}</button>}
          </div>
        </div>

        {loading && !report ? <p className="report-message" role="status">{labels.loading}</p> : error || !report || !summary ?
          <div className="report-banner report-banner-error" role="alert"><AlertTriangle size={22} /><div><strong>{labels.loadError}</strong></div></div> : <>
          <section className="report-user-stamp" aria-label={language === "zh" ? "账户水印" : "Account watermark"}>
            <div><span className="report-user-stamp-label">{language === "zh" ? "账户水印" : "ACCOUNT WATERMARK"}</span><strong>@{user.username}</strong></div>
            <span className="report-user-stamp-brand">PROOFFLOW<br />{language === "zh" ? "创作证据报告" : "EVIDENCE REPORT"}</span>
          </section>
          <div className={`report-banner ${valid ? "report-banner-ok" : "report-banner-error"}`} role={valid ? "status" : "alert"}>
            {valid ? <ShieldCheck size={24} /> : <AlertTriangle size={24} />}
            <div><strong>{valid ? labels.valid : labels.invalid}</strong><p>{valid ? labels.validBody : labels.invalidBody}</p>
              {!valid && <p className="report-failure-detail">{inconsistentSnapshot ? labels.stale : `${failureCode ?? "VERIFY_FAILED"}: ${failureReason ?? ""}`}</p>}
            </div>
            <span className="report-checked">{labels.verifiedEvents(report.verification.checkedEvents)}</span>
          </div>

          <div className="report-disclosure"><FileText size={16} /><span>{labels.unsigned}</span></div>
          <div className={`report-freeze-status ${report.document.status === "finalized" ? "is-frozen" : ""}`} role="status">
            <LockKeyhole size={17} /><span>{report.document.status === "finalized" ? labels.frozenAt(report.document.finalizedAt ?? "") : labels.draftStatus}</span>
          </div>
          {pendingLocal && report.document.status === "draft" && <p className="report-action-warning" role="alert">{labels.unsavedWarning}</p>}
          {actionError && <p className="report-action-warning" role="alert">{actionError}</p>}

          <section className="report-section" aria-labelledby="report-overview-title">
            <div className="report-section-heading"><h2 id="report-overview-title">{labels.overview}</h2><span>{summary.totals.eventCount} {language === "zh" ? "条已保存记录" : "saved records"}</span></div>
            <div className="report-metrics">
              <div className="report-metric report-metric-add"><Plus size={18} /><strong>{summary.totals.additionCount}</strong><span>{labels.additions}</span></div>
              <div className="report-metric report-metric-delete"><Trash2 size={18} /><strong>{summary.totals.deletionCount}</strong><span>{labels.deletions}</span></div>
              <div className="report-metric report-metric-paste"><ClipboardPaste size={18} /><strong>{summary.totals.pasteCount}</strong><span>{labels.pastes}</span></div>
            </div>
            <div className="report-secondary-metrics">
              <span>{labels.addedCharacters}<strong>+{summary.totals.addedCharacters}</strong></span>
              <span>{labels.deletedCharacters}<strong>−{summary.totals.deletedCharacters}</strong></span>
              <span>{labels.manual}<strong>{summary.totals.manualCount}</strong></span>
              {summary.totals.aiCount > 0 && <span>{labels.ai}<strong>{summary.totals.aiCount}</strong></span>}
            </div>
          </section>

          <section className="report-section report-identity" aria-label={labels.documentId}>
            <div><span>{labels.documentId}</span><code>{report.document.id}</code></div>
            <div><span>{labels.version}</span><strong>v{report.document.version}</strong></div>
            <div><span>{labels.headHash}</span><code>{report.events.length ? report.verification.headHash || labels.unavailable : labels.unavailable}</code></div>
          </section>

          <section className="report-section" aria-labelledby="report-activity-title">
            <div className="report-section-heading"><h2 id="report-activity-title">{labels.activity}</h2></div>
            {summary.rows.length ? <div className="report-activity-list">{summary.rows.map(({ event, added, deleted }, index) => (
              <article className="report-activity" key={event.id}>
                <div className="report-activity-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="report-activity-body">
                  <div className="report-activity-heading"><strong>{t.events[event.type]}</strong><span>v{event.version}</span><time dateTime={event.receivedAt}>{new Date(event.receivedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US")}</time></div>
                  {event.type === "AI_INSERT" ? <p className="report-activity-snippet">{event.snippet}</p> :
                    <ChangePreview language={language} type={event.type} before={report.events[index - 1]?.contentAfter ?? emptyDocument()} after={event.contentAfter} fallback={event.snippet} insertedText={event.insertedText} insertPosition={event.insertPosition} replacedLength={event.replacedLength} />}
                  <div className="report-activity-meta"><span>+{added} / −{deleted}</span><code>{event.eventHash}</code></div>
                </div>
              </article>
            ))}</div> : <p className="report-message">{labels.noActivity}</p>}
          </section>

          <footer className="report-method"><strong>{labels.method}</strong><p>{labels.methodText}</p></footer>
        </>}
      </main>
      {confirmFreeze && <div className="report-modal-backdrop"><div className="report-modal" role="dialog" aria-modal="true" aria-labelledby="freeze-confirm-title">
        <LockKeyhole size={22} /><h2 id="freeze-confirm-title">{labels.freezeConfirmTitle}</h2><p>{labels.freezeConfirmBody}</p>
        <div className="report-modal-actions"><button type="button" onClick={() => setConfirmFreeze(false)} disabled={finalizing}>{labels.cancel}</button><button className="report-freeze" type="button" onClick={finalize} disabled={finalizing}>{finalizing ? labels.freezing : labels.confirmFreeze}</button></div>
      </div></div>}
    </div>
  );
}
