import { manualChangeHunks, pasteChangeHunks } from "./change-preview";
import { emptyDocument, plainText, type EditorDocument } from "./editor-document";

export type ReportEvent = {
  id: string;
  operationId: string;
  version: number;
  type: "MANUAL_EDIT" | "PASTE" | "AI_INSERT";
  receivedAt: string;
  snippet: string;
  insertedText: string | null;
  insertPosition: { path: number[]; offset: number } | null;
  replacedLength: number | null;
  contentAfter: EditorDocument;
  previousHash: string;
  eventHash: string;
};

export function summarizeChanges(events: ReportEvent[]) {
  let before = plainText(emptyDocument());
  const totals = {
    eventCount: events.length,
    additionCount: 0,
    deletionCount: 0,
    pasteCount: 0,
    manualCount: 0,
    aiCount: 0,
    addedCharacters: 0,
    deletedCharacters: 0,
  };
  const rows = events.map((event) => {
    const after = plainText(event.contentAfter);
    const hunks = event.type === "MANUAL_EDIT"
      ? manualChangeHunks(before, after)
      : pasteChangeHunks(before, after, event.insertedText, event.insertPosition, event.replacedLength ?? 0);
    const added = hunks.reduce((sum, hunk) => sum + hunk.added.length, 0);
    const deleted = hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
    if (added) totals.additionCount++;
    if (deleted) totals.deletionCount++;
    if (event.type === "PASTE") totals.pasteCount++;
    if (event.type === "MANUAL_EDIT") totals.manualCount++;
    if (event.type === "AI_INSERT") totals.aiCount++;
    totals.addedCharacters += added;
    totals.deletedCharacters += deleted;
    before = after;
    return { event, added, deleted };
  });
  return { totals, rows };
}
