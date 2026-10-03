import test from "node:test";
import assert from "node:assert/strict";
import { manualChangeHunks, manualChangeSnippet, pasteChangeHunks } from "../lib/change-preview.ts";

test("a change deep in a long document shows only bounded nearby context", () => {
  const before = `${"开头内容。".repeat(30)}前一句。目标旧词，后一句。${"结尾内容。".repeat(30)}`;
  const after = before.replace("目标旧词", "目标新词");
  const [hunk] = manualChangeHunks(before, after, 18);
  assert.equal(hunk.added, "新");
  assert.equal(hunk.removed, "旧");
  assert.ok(hunk.beforeContext.length <= 18);
  assert.ok(hunk.afterContext.length <= 18);
  assert.equal(hunk.omittedBefore, true);
  assert.equal(hunk.omittedAfter, true);
  assert.ok(!hunk.beforeContext.includes("开头内容"));
  assert.ok(!hunk.afterContext.includes("结尾内容。结尾内容。"));
  assert.equal(manualChangeSnippet(before, after), "旧 → 新");
});

test("separate edits produce separate previews without the long unchanged middle", () => {
  const before = `alpha ${"unchanged sentence. ".repeat(30)} omega`;
  const after = `ALPHA ${"unchanged sentence. ".repeat(30)} OMEGA`;
  const hunks = manualChangeHunks(before, after, 24);
  assert.equal(hunks.length, 2);
  assert.ok(hunks.every((hunk) => hunk.beforeContext.length <= 24 && hunk.afterContext.length <= 24));
  assert.ok(hunks.some((hunk) => hunk.added.includes("ALPHA")));
  assert.ok(hunks.some((hunk) => hunk.added.includes("OMEGA")));
});

test("deletions retain surrounding text and mark what was removed", () => {
  const [hunk] = manualChangeHunks("第一句。这里要删除旧内容。最后一句。", "第一句。这里要删除。最后一句。");
  assert.equal(hunk.added, "");
  assert.equal(hunk.removed, "旧内容");
  assert.equal(hunk.beforeContext, "第一句。这里要删除");
  assert.equal(hunk.afterContext, "。最后一句。");
  assert.equal(manualChangeSnippet("abc", ""), "删除：abc");
});

test("unchanged text falls back to the formatting label", () => {
  assert.deepEqual(manualChangeHunks("same", "same"), []);
  assert.equal(manualChangeSnippet("same", "same"), "格式已更改");
});

test("paste highlights the entire inserted text at its recorded position", () => {
  const before = `${"开头。".repeat(30)}目标位置。${"结尾。".repeat(30)}`;
  const start = before.indexOf("目标位置") + 2;
  const insertedText = "完整粘贴内容";
  const after = before.slice(0, start) + insertedText + before.slice(start);
  const [hunk] = pasteChangeHunks(before, after, insertedText, { path: [0], offset: start }, 0, 18);
  assert.equal(hunk.added, insertedText);
  assert.equal(hunk.removed, "");
  assert.ok(hunk.beforeContext.length <= 18);
  assert.ok(hunk.afterContext.length <= 18);
  assert.equal(hunk.omittedBefore, true);
  assert.equal(hunk.omittedAfter, true);
});

test("paste position disambiguates repeated text and shows replaced selection", () => {
  const [repeated] = pasteChangeHunks("abc", "abcabc", "abc", { path: [0], offset: 0 });
  assert.equal(repeated.beforeContext, "");
  assert.equal(repeated.added, "abc");
  assert.equal(repeated.afterContext, "abc");

  const [replacement] = pasteChangeHunks("第一段\n第二段旧内容结束。", "第一段\n第二段新内容结束。", "新内容", { path: [1], offset: 3 }, 3);
  assert.equal(replacement.added, "新内容");
  assert.equal(replacement.removed, "旧内容");
  assert.equal(replacement.beforeContext, "第一段\n第二段");
});

test("invalid legacy paste metadata falls back to the text difference", () => {
  const [hunk] = pasteChangeHunks("hello world", "hello pasted world", "pasted ", null);
  assert.equal(hunk.added, "pasted ");
});
