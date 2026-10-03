import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyDocument,
  plainText,
  positionFromOffset,
  reconcileText,
  replaceRange,
  toggleBold,
} from "../lib/editor-document.ts";

test("empty document uses doc > paragraph > text schema", () => {
  assert.deepEqual(emptyDocument(), { type: "doc", content: [{ type: "paragraph", content: [] }] });
});

test("paste inserts once at the cursor and keeps a source marker", () => {
  const before = replaceRange(emptyDocument(), 0, 0, "Hello world");
  const after = replaceRange(before, 6, 6, "AI ", { sourceOperationId: "operation-1" });
  assert.equal(plainText(after), "Hello AI world");
  assert.deepEqual(positionFromOffset(before, 6), { path: [0], offset: 6 });
  assert.deepEqual(after.content[0].content.map(({ text, sourceOperationId }) => [text, sourceOperationId]), [
    ["Hello ", undefined], ["AI ", "operation-1"], ["world", undefined],
  ]);
});

test("manual input splits a sourced span without claiming the inserted text", () => {
  const before = replaceRange(emptyDocument(), 0, 0, "source", { sourceOperationId: "operation-1" });
  const after = reconcileText(before, "souXrce");
  assert.deepEqual(after.content[0].content.map(({ text, sourceOperationId }) => [text, sourceOperationId]), [
    ["sou", "operation-1"], ["X", undefined], ["rce", "operation-1"],
  ]);
});

test("paragraph coordinates count UTF-16 units", () => {
  const before = replaceRange(emptyDocument(), 0, 0, "A😀\nnext");
  assert.deepEqual(positionFromOffset(before, 4), { path: [1], offset: 0 });
  const after = replaceRange(before, 4, 4, "中\n文", { sourceOperationId: "operation-2" });
  assert.equal(plainText(after), "A😀\n中\n文next");
  assert.equal(after.content.length, 3);
  assert.equal(after.content[1].content[0].sourceOperationId, "operation-2");
});

test("bold toggles selected text while preserving source attribution", () => {
  const before = replaceRange(emptyDocument(), 0, 0, "proof", { sourceOperationId: "operation-3" });
  const after = toggleBold(before, 1, 4);
  assert.deepEqual(after.content[0].content.map(({ text, marks, sourceOperationId }) => [text, Boolean(marks), sourceOperationId]), [
    ["p", false, "operation-3"], ["roo", true, "operation-3"], ["f", false, "operation-3"],
  ]);
  assert.deepEqual(toggleBold(after, 1, 4), before);
});

test("replacing a selection removes only that range", () => {
  const before = replaceRange(emptyDocument(), 0, 0, "alpha beta");
  const after = replaceRange(before, 6, 10, "gamma", { sourceOperationId: "operation-4" });
  assert.equal(plainText(after), "alpha gamma");
  assert.equal(after.content[0].content[1].sourceOperationId, "operation-4");
});
