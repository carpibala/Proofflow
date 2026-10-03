import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { emptyDocument, replaceRange } from "../lib/editor-document.ts";
import { hashEvidenceEvent } from "../lib/proof-format.ts";

const base = process.env.PROOFFLOW_TEST_URL ?? "http://localhost:3001";

async function request(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

test("documents and events persist with idempotency, versioning and source checks", async () => {
  const invalidSchema = await request("/api/documents", "POST", {
    title: "Invalid", editorSchemaVersion: 1, contentJson: { ...emptyDocument(), version: 4 },
  });
  assert.equal(invalidSchema.status, 422);

  const created = await request("/api/documents", "POST", {
    title: "Integration test", editorSchemaVersion: 1, contentJson: emptyDocument(),
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.version, 0);

  const manualId = randomUUID();
  const manualContent = replaceRange(emptyDocument(), 0, 0, "Hello");
  const manual = {
    documentId: id, baseVersion: 0,
    event: { operationId: manualId, type: "MANUAL_EDIT", snippet: "Hello" },
    contentJson: manualContent,
  };
  const savedManual = await request(`/api/documents/${id}/events`, "POST", manual);
  assert.equal(savedManual.status, 201);
  assert.equal(savedManual.body.version, 1);
  const replay = await request(`/api/documents/${id}/events`, "POST", manual);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.eventId, savedManual.body.eventId);
  assert.equal(replay.body.replayed, true);

  const stale = await request(`/api/documents/${id}/events`, "POST", {
    ...manual, event: { ...manual.event, operationId: randomUUID() },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "STALE_VERSION");

  const pasteId = randomUUID();
  const pastedContent = replaceRange(manualContent, 5, 5, " pasted", { sourceOperationId: pasteId });
  const paste = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 1,
    event: { operationId: pasteId, type: "PASTE", insertedText: " pasted", insertPosition: { path: [0], offset: 5 } },
    contentJson: pastedContent,
  });
  assert.equal(paste.status, 201);
  assert.equal(paste.body.version, 2);

  const mismatch = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 2,
    event: { operationId: randomUUID(), type: "PASTE", insertedText: "wrong", insertPosition: { path: [0], offset: 0 } },
    contentJson: pastedContent,
  });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.body.error, "CONTENT_MISMATCH");

  const forgedSource = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 2,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT" },
    contentJson: replaceRange(pastedContent, 0, 0, "x", { sourceOperationId: randomUUID() }),
  });
  assert.equal(forgedSource.status, 422);
  assert.equal(forgedSource.body.error, "UNKNOWN_SOURCE");

  const aiId = randomUUID();
  const text = created.body.demoAiResponse.responseText;
  const aiContent = replaceRange(pastedContent, 12, 12, text, { sourceOperationId: aiId, bold: true });
  const ai = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 2,
    event: { operationId: aiId, type: "AI_INSERT", aiResponseId: created.body.demoAiResponse.id, insertedText: text, insertPosition: { path: [0], offset: 12 } },
    contentJson: aiContent,
  });
  assert.equal(ai.status, 201);
  assert.equal(ai.body.version, 3);

  const document = await request(`/api/documents/${id}`);
  assert.equal(document.status, 200);
  assert.equal(document.body.version, 3);
  assert.deepEqual(document.body.contentJson, aiContent);
  const history = await request(`/api/documents/${id}/events`);
  assert.equal(history.status, 200);
  assert.equal(history.body.events.length, 3);
  assert.equal(history.body.events[0].previousHash, "0".repeat(64));
  assert.equal(history.body.events[1].previousHash, history.body.events[0].eventHash);
  assert.equal(history.body.events[2].previousHash, history.body.events[1].eventHash);
  for (const saved of history.body.events) {
    assert.equal(saved.hashFormatVersion, 1);
    assert.equal(saved.event.timestamp, null);
    assert.equal(hashEvidenceEvent({
      eventId: saved.id,
      documentId: id,
      version: saved.version,
      event: saved.event,
      receivedAt: saved.receivedAt,
      contentAfter: saved.contentAfter,
      previousHash: saved.previousHash,
    }), saved.eventHash);
  }

  const competing = await Promise.all(["A", "B"].map((letter) => request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 3,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT", snippet: letter },
    contentJson: replaceRange(aiContent, 0, 0, letter),
  })));
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
  const finalDocument = await request(`/api/documents/${id}`);
  assert.equal(finalDocument.body.version, 4);
});
