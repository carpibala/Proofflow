"use client";

import { useMemo } from "react";
import { plainText, type EditorDocument } from "@/lib/editor-document";
import { manualChangeHunks, pasteChangeHunks } from "@/lib/change-preview";

export default function ChangePreview({ before, after, fallback, type, insertedText, insertPosition, replacedLength }: {
  before: EditorDocument;
  after: EditorDocument;
  fallback: string;
  type: "MANUAL_EDIT" | "PASTE";
  insertedText?: string | null;
  insertPosition?: { path: number[]; offset: number } | null;
  replacedLength?: number | null;
}) {
  const hunks = useMemo(() => type === "PASTE"
    ? pasteChangeHunks(plainText(before), plainText(after), insertedText, insertPosition, replacedLength ?? 0)
    : manualChangeHunks(plainText(before), plainText(after)), [before, after, type, insertedText, insertPosition, replacedLength]);
  const caption = type === "PASTE" ? "粘贴部分" : "修改部分";
  return (
    <div className="manual-change-preview" aria-label={caption}>
      <span className="change-caption">{caption}</span>
      {hunks.length ? hunks.map((hunk, index) => (
        <p className="change-hunk" key={index}>
          {hunk.omittedBefore && "…"}{hunk.beforeContext}
          {hunk.removed && <del className="change-removed">{hunk.removed}</del>}
          {hunk.added && <mark className="change-added">{hunk.added}</mark>}
          {hunk.afterContext}{hunk.omittedAfter && "…"}
        </p>
      )) : <p className="change-hunk">{fallback}</p>}
    </div>
  );
}
