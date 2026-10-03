import { diffChars } from "diff";

export type ChangeHunk = {
  beforeContext: string;
  added: string;
  removed: string;
  afterContext: string;
  omittedBefore: boolean;
  omittedAfter: boolean;
};

type InsertPosition = { path: number[]; offset: number };

type RawHunk = { start: number; end: number; added: string; removed: string };

function fallbackDiff(before: string, after: string): RawHunk[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (suffix < before.length - start && suffix < after.length - start &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++;
  return [{
    start,
    end: after.length - suffix,
    added: after.slice(start, after.length - suffix),
    removed: before.slice(start, before.length - suffix),
  }];
}

function previousContext(text: string, limit: number): string {
  const ends = [...text.matchAll(/[。！？.!?；;\n]/g)].map((match) => match.index);
  const start = ends.length >= 2 ? ends[ends.length - 2] + 1 : 0;
  return text.slice(start).slice(-limit);
}

function nextContext(text: string, limit: number): string {
  const ends = [...text.matchAll(/[。！？.!?；;\n]/g)].map((match) => match.index);
  const end = ends.length >= 2 ? ends[1] + 1 : text.length;
  return text.slice(0, end).slice(0, limit);
}

function withContext(after: string, change: RawHunk, contextLimit: number): ChangeHunk {
  const prefix = after.slice(0, change.start);
  const suffix = after.slice(change.end);
  const beforeContext = previousContext(prefix, contextLimit);
  const afterContext = nextContext(suffix, contextLimit);
  return {
    beforeContext,
    added: change.added,
    removed: change.removed,
    afterContext,
    omittedBefore: beforeContext.length < prefix.length,
    omittedAfter: afterContext.length < suffix.length,
  };
}

export function manualChangeHunks(before: string, after: string, contextLimit = 60): ChangeHunk[] {
  if (before === after) return [];

  const changes = diffChars(before, after, { timeout: 150, maxEditLength: 10000 });
  const raw: RawHunk[] = [];
  if (changes) {
    let offset = 0;
    let current: RawHunk | null = null;
    for (const change of changes) {
      if (!change.added && !change.removed) {
        if (current) raw.push(current);
        current = null;
        offset += change.value.length;
        continue;
      }
      current ??= { start: offset, end: offset, added: "", removed: "" };
      if (change.added) {
        current.added += change.value;
        offset += change.value.length;
        current.end = offset;
      } else {
        current.removed += change.value;
      }
    }
    if (current) raw.push(current);
  }

  return (changes ? raw : fallbackDiff(before, after)).map((change) => withContext(after, change, contextLimit));
}

export function pasteChangeHunks(
  before: string,
  after: string,
  insertedText: string | null | undefined,
  insertPosition: InsertPosition | null | undefined,
  replacedLength = 0,
  contextLimit = 60,
): ChangeHunk[] {
  const paragraphIndex = insertPosition?.path.length === 1 ? insertPosition.path[0] : -1;
  const paragraphs = before.split("\n");
  const offset = insertPosition?.offset ?? -1;
  if (!insertedText || !Number.isInteger(paragraphIndex) || paragraphIndex < 0 || paragraphIndex >= paragraphs.length ||
    !Number.isInteger(offset) || offset < 0 || offset > paragraphs[paragraphIndex].length ||
    !Number.isInteger(replacedLength) || replacedLength < 0) return manualChangeHunks(before, after, contextLimit);

  const start = paragraphs.slice(0, paragraphIndex).reduce((total, paragraph) => total + paragraph.length + 1, 0) + offset;
  if (before.slice(0, start) + insertedText + before.slice(start + replacedLength) !== after) {
    return manualChangeHunks(before, after, contextLimit);
  }
  return [withContext(after, {
    start,
    end: start + insertedText.length,
    added: insertedText,
    removed: before.slice(start, start + replacedLength),
  }, contextLimit)];
}

export function manualChangeSnippet(before: string, after: string): string {
  const hunks = manualChangeHunks(before, after);
  if (!hunks.length) return "格式已更改";
  return hunks.map(({ added, removed }) => {
    if (added && removed) return `${removed} → ${added}`;
    return added || `删除：${removed}`;
  }).join("；").replace(/\s+/g, " ").slice(0, 180);
}
