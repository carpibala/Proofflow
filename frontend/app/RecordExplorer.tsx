"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCw, Search, ShieldCheck } from "lucide-react";
import { emptyDocument, plainText, type EditorDocument } from "@/lib/editor-document";
import { translations, type Language } from "@/lib/i18n";
import ChangePreview from "./ChangePreview";

type SavedEvent = {
  id: string;
  operationId: string;
  version: number;
  type: "MANUAL_EDIT" | "PASTE" | "AI_INSERT";
  timestamp: string | null;
  receivedAt: string;
  snippet: string;
  aiResponseId: string | null;
  insertedText: string | null;
  insertPosition: { path: number[]; offset: number } | null;
  replacedLength: number | null;
  contentAfter: EditorDocument;
  previousHash: string;
  eventHash: string;
};

type Verification = {
  valid: boolean;
  checkedEvents: number;
  headHash: string;
  code?: string;
  message?: string;
};

type LoadError = { kind: "missing" } | { kind: "http"; status: number } | { kind: "offline" };

class RecordLoadError extends Error {
  constructor(readonly kind: "missing" | "http", readonly status = 0) { super(kind); }
}

const formatDelta = (delta: number | null | undefined, firstLabel: string) => delta == null ? firstLabel : `${delta > 0 ? "+" : ""}${delta}`;

export default function RecordExplorer({ documentId, savedEventCount, pendingCount, onHover, language }: {
  documentId?: string;
  savedEventCount: number;
  pendingCount: number;
  onHover: (operationId: string | null) => void;
  language: Language;
}) {
  const t = translations[language];
  const [records, setRecords] = useState<SavedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<LoadError | null>(null);
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (!documentId) return;
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) { setLoading(true); setLoadError(null); setVerification(null); } });
    fetch(`/api/documents/${documentId}/events`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw new RecordLoadError("missing");
        if (!response.ok) throw new RecordLoadError("http", response.status);
        return response.json() as Promise<{ events: SavedEvent[] }>;
      })
      .then((data) => { if (!controller.signal.aborted) setRecords(data.events); })
      .catch((error: unknown) => { if (!controller.signal.aborted) { setRecords([]); setLoadError(error instanceof RecordLoadError ? error.kind === "http" ? { kind: "http", status: error.status } : { kind: "missing" } : { kind: "offline" }); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [documentId, savedEventCount, retry]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((record) =>
      (typeFilter === "ALL" || record.type === typeFilter) &&
      (!needle || [record.version, t.events[record.type], record.snippet, record.operationId,
        record.insertedText ?? "", record.aiResponseId ?? ""].some((value) => String(value).toLocaleLowerCase().includes(needle))),
    ).reverse();
  }, [records, query, typeFilter, t]);

  const textChanges = useMemo(() => {
    const lengths = records.map((record) => plainText(record.contentAfter).length);
    return new Map(records.map((record, index) => {
      const currentLength = lengths[index];
      return [record.id, { currentLength, delta: index === 0 ? null : currentLength - lengths[index - 1] }] as const;
    }));
  }, [records]);

  const previousContent = useMemo(() => new Map(records.map((record, index) => [
    record.id, records[index - 1]?.contentAfter ?? emptyDocument(),
  ] as const)), [records]);

  const verify = async () => {
    if (!documentId) return;
    setVerifying(true);
    setVerification(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/verify`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Verify failed: ${response.status}`);
      setVerification(await response.json() as Verification);
    } catch {
      setVerification({ valid: false, checkedEvents: 0, headHash: "", code: "REQUEST_FAILED" });
    } finally {
      setVerifying(false);
    }
  };

  const pasteCount = records.filter((record) => record.type === "PASTE").length;
  const loadErrorMessage = loadError?.kind === "missing" ? t.record.missing :
    loadError?.kind === "http" ? t.record.readFailed(loadError.status) : t.record.offline;
  return (
    <div className="record-explorer" role="tabpanel" aria-label={t.record.saved}>
      <div className="record-stats" aria-label={t.record.stats}>
        <div><strong>{records.length}</strong><span>{t.record.changes}</span></div>
        <div><strong>{pasteCount}</strong><span>{t.record.pastes}</span></div>
      </div>
      <div className="record-controls">
        <label className="record-search"><Search size={15} /><input type="search" aria-label={t.record.search} placeholder={t.record.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label={t.record.filter} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
          <option value="ALL">{t.record.allTypes}</option>
          <option value="MANUAL_EDIT">{t.events.MANUAL_EDIT}</option>
          <option value="PASTE">{t.events.PASTE}</option>
          {records.some((record) => record.type === "AI_INSERT") && <option value="AI_INSERT">{t.events.AI_INSERT}</option>}
        </select>
      </div>
      <div className="record-list-heading"><span>{t.record.matches(filtered.length)}</span>{loadError && <button type="button" onClick={() => setRetry((value) => value + 1)} title={t.record.retry}><RotateCw size={15} />{t.record.retry}</button>}</div>
      <div className="record-list">
        {loadError ? <p className="record-empty" role="alert">{loadErrorMessage}</p> : loading && records.length === 0 ? <p className="record-empty">{t.record.loading}</p> :
          filtered.length === 0 ? <p className="record-empty">{records.length ? t.record.noMatches : t.record.noRecords}</p> :
          filtered.map((record) => (
            <details className="record-entry" key={record.id} onMouseEnter={() => onHover(record.operationId)} onMouseLeave={() => onHover(null)}>
              <summary><span className={`record-type ${record.type.toLowerCase()}`}>{t.events[record.type]}</span><span className="record-version">v{record.version}</span><time dateTime={record.receivedAt}>{new Date(record.receivedAt).toLocaleString(language === "zh" ? "zh-CN" : "en-US", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></summary>
              {record.type === "AI_INSERT" ? <p className="record-snippet">{record.snippet || record.insertedText?.slice(0, 80) || t.record.edited}</p> : <ChangePreview language={language} type={record.type} before={previousContent.get(record.id) ?? emptyDocument()} after={record.contentAfter} fallback={record.snippet || t.record.edited} insertedText={record.insertedText} insertPosition={record.insertPosition} replacedLength={record.replacedLength} />}
              <dl className="record-attributes">
                <dt>{t.record.operationId}</dt><dd><code>{record.operationId}</code></dd>
                <dt>{t.record.recordedAt}</dt><dd>{record.timestamp ?? t.record.unknownTime}</dd>
                <dt>{t.record.serverTime}</dt><dd>{record.receivedAt}</dd>
                <dt>{t.record.bodyCharacters}</dt><dd>{textChanges.get(record.id)?.currentLength}</dd>
                <dt>{t.record.characterDelta}</dt><dd>{formatDelta(textChanges.get(record.id)?.delta, t.record.firstDelta)}</dd>
                {record.insertedText !== null && <><dt>{t.record.insertedCharacters}</dt><dd>{record.insertedText.length}</dd><dt>{t.record.insertedContent}</dt><dd className="record-full-text">{record.insertedText}</dd></>}
                {record.insertPosition && <><dt>{t.record.insertPosition}</dt><dd>{t.record.position(record.insertPosition.path[0] + 1, record.insertPosition.offset)}</dd></>}
                {record.replacedLength !== null && <><dt>{t.record.replacedCharacters}</dt><dd>{record.replacedLength}</dd></>}
                {record.aiResponseId && <><dt>{t.record.aiResponseId}</dt><dd><code>{record.aiResponseId}</code></dd></>}
                <dt>{t.record.previousHash}</dt><dd><code>{record.previousHash}</code></dd>
                <dt>{t.record.eventHash}</dt><dd><code>{record.eventHash}</code></dd>
              </dl>
            </details>
          ))}
      </div>
      <div className="record-verification">
        <button type="button" onClick={verify} disabled={!documentId || loading || Boolean(loadError) || verifying || pendingCount > 0 || records.length === 0} title={t.record.verifyHint}><ShieldCheck size={16} />{verifying ? t.record.verifying : t.record.verify}</button>
        {pendingCount > 0 && <p>{t.record.pending(pendingCount)}</p>}
        {verification && pendingCount === 0 && <p className={verification.valid ? "verification-ok" : "verification-error"} role="status">{verification.valid ? t.record.verified(verification.checkedEvents) : t.record.invalid(verification.code === "REQUEST_FAILED" ? t.record.requestFailed : verification.message ?? verification.code ?? t.record.requestFailed)}</p>}
      </div>
    </div>
  );
}
