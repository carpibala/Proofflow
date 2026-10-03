"use client";

import { useEffect, useMemo, useState } from "react";
import { RotateCw, Search, ShieldCheck } from "lucide-react";
import { plainText, type EditorDocument } from "@/lib/editor-document";

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

const labels = { MANUAL_EDIT: "手动编辑", PASTE: "粘贴", AI_INSERT: "AI 插入" };
const formatDelta = (delta: number | null | undefined) => delta == null ? "首条记录无基线" : `${delta > 0 ? "+" : ""}${delta}`;

export default function RecordExplorer({ documentId, savedEventCount, pendingCount, onHover }: {
  documentId?: string;
  savedEventCount: number;
  pendingCount: number;
  onHover: (operationId: string | null) => void;
}) {
  const [records, setRecords] = useState<SavedEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        if (response.status === 404) throw new Error("当前服务未找到这份文档。草稿仍在浏览器中，请检查服务端口或工作区。");
        if (!response.ok) throw new Error(`记录读取失败（HTTP ${response.status}），请重试。`);
        return response.json() as Promise<{ events: SavedEvent[] }>;
      })
      .then((data) => { if (!controller.signal.aborted) setRecords(data.events); })
      .catch((error: unknown) => { if (!controller.signal.aborted) { setRecords([]); setLoadError(error instanceof Error ? error.message : "无法连接当前服务，请确认服务仍在运行。"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [documentId, savedEventCount, retry]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return records.filter((record) =>
      (typeFilter === "ALL" || record.type === typeFilter) &&
      (!needle || [record.version, labels[record.type], record.snippet, record.operationId,
        record.insertedText ?? "", record.aiResponseId ?? ""].some((value) => String(value).toLocaleLowerCase().includes(needle))),
    ).reverse();
  }, [records, query, typeFilter]);

  const textChanges = useMemo(() => {
    const lengths = records.map((record) => plainText(record.contentAfter).length);
    return new Map(records.map((record, index) => {
      const currentLength = lengths[index];
      return [record.id, { currentLength, delta: index === 0 ? null : currentLength - lengths[index - 1] }] as const;
    }));
  }, [records]);

  const verify = async () => {
    if (!documentId) return;
    setVerifying(true);
    setVerification(null);
    try {
      const response = await fetch(`/api/documents/${documentId}/verify`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Verify failed: ${response.status}`);
      setVerification(await response.json() as Verification);
    } catch {
      setVerification({ valid: false, checkedEvents: 0, headHash: "", code: "REQUEST_FAILED", message: "验证请求失败，请重试" });
    } finally {
      setVerifying(false);
    }
  };

  const pasteCount = records.filter((record) => record.type === "PASTE").length;
  return (
    <div className="record-explorer" role="tabpanel" aria-label="已保存记录">
      <div className="record-stats" aria-label="已保存记录统计">
        <div><strong>{records.length}</strong><span>更改次数</span></div>
        <div><strong>{pasteCount}</strong><span>粘贴次数</span></div>
      </div>
      <div className="record-controls">
        <label className="record-search"><Search size={15} /><input type="search" aria-label="检索记录" placeholder="搜索摘要、操作 ID" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="筛选记录类型" value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
          <option value="ALL">全部类型</option>
          <option value="MANUAL_EDIT">手动编辑</option>
          <option value="PASTE">粘贴</option>
          <option value="AI_INSERT">AI 插入</option>
        </select>
      </div>
      <div className="record-list-heading"><span>检索到 {filtered.length} 条</span>{loadError && <button type="button" onClick={() => setRetry((value) => value + 1)} title="重新加载记录"><RotateCw size={15} />重试</button>}</div>
      <div className="record-list">
        {loadError ? <p className="record-empty" role="alert">{loadError}</p> : loading && records.length === 0 ? <p className="record-empty">正在读取记录…</p> :
          filtered.length === 0 ? <p className="record-empty">{records.length ? "没有符合条件的记录。" : "尚无已保存记录。"}</p> :
          filtered.map((record) => (
            <details className="record-entry" key={record.id} onMouseEnter={() => onHover(record.operationId)} onMouseLeave={() => onHover(null)}>
              <summary><span className={`record-type ${record.type.toLowerCase()}`}>{labels[record.type]}</span><span className="record-version">v{record.version}</span><time dateTime={record.receivedAt}>{new Date(record.receivedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></summary>
              <p className="record-snippet">{record.snippet || record.insertedText?.slice(0, 80) || "正文已修改"}</p>
              <dl className="record-attributes">
                <dt>操作 ID</dt><dd><code>{record.operationId}</code></dd>
                <dt>记录时间</dt><dd>{record.timestamp ?? "未提供"}</dd>
                <dt>服务端时间</dt><dd>{record.receivedAt}</dd>
                <dt>正文字符</dt><dd>{textChanges.get(record.id)?.currentLength}</dd>
                <dt>字符变化</dt><dd>{formatDelta(textChanges.get(record.id)?.delta)}</dd>
                {record.insertedText !== null && <><dt>插入字符</dt><dd>{record.insertedText.length}</dd><dt>插入内容</dt><dd className="record-full-text">{record.insertedText}</dd></>}
                {record.insertPosition && <><dt>插入位置</dt><dd>段落 {record.insertPosition.path[0] + 1}，偏移 {record.insertPosition.offset}</dd></>}
                {record.replacedLength !== null && <><dt>替换字符</dt><dd>{record.replacedLength}</dd></>}
                {record.aiResponseId && <><dt>AI 回答 ID</dt><dd><code>{record.aiResponseId}</code></dd></>}
                <dt>前序哈希</dt><dd><code>{record.previousHash}</code></dd>
                <dt>事件哈希</dt><dd><code>{record.eventHash}</code></dd>
              </dl>
            </details>
          ))}
      </div>
      <div className="record-verification">
        <button type="button" onClick={verify} disabled={!documentId || loading || Boolean(loadError) || verifying || pendingCount > 0 || records.length === 0} title="检查服务端事件哈希链与最终正文；不包含数字签名或外部锚点"><ShieldCheck size={16} />{verifying ? "验证中" : "验证记录"}</button>
        {pendingCount > 0 && <p>有 {pendingCount} 条待保存操作，保存完成后可验证。</p>}
        {verification && pendingCount === 0 && <p className={verification.valid ? "verification-ok" : "verification-error"} role="status">{verification.valid ? `内部链一致，已检查 ${verification.checkedEvents} 条。未签名、未校验外部锚点。` : `验证未通过：${verification.message ?? verification.code}`}</p>}
      </div>
    </div>
  );
}
