import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { emptyDocument, replaceRange } from "../lib/editor-document.ts";
import { hashEvidenceEvent, verifyEvidencePackage } from "../lib/proof-format.ts";

const base = process.env.PROOFFLOW_TEST_URL ?? "http://localhost:3001";
const authResponse = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: `test_${randomUUID().replaceAll("-", "").slice(0,20)}`, password: "Integration-password-123" }) });
assert.equal(authResponse.status, 201);
const cookie = authResponse.headers.get("set-cookie").split(";")[0];

async function request(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
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

  const ai = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 2,
    event: { operationId: randomUUID(), type: "AI_INSERT", aiResponseId: randomUUID(), insertedText: "sample", insertPosition: { path: [0], offset: 12 } },
    contentJson: pastedContent,
  });
  assert.equal(ai.status, 400);
  assert.equal(ai.body.error, "INVALID_EVENT");

  const document = await request(`/api/documents/${id}`);
  assert.equal(document.status, 200);
  assert.equal(document.body.version, 2);
  assert.deepEqual(document.body.contentJson, pastedContent);
  const history = await request(`/api/documents/${id}/events`);
  assert.equal(history.status, 200);
  assert.equal(history.body.events.length, 2);
  assert.equal(history.body.events[0].previousHash, "0".repeat(64));
  assert.equal(history.body.events[1].previousHash, history.body.events[0].eventHash);
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

  assert.deepEqual(history.body.events.map((event) => event.type), ["MANUAL_EDIT", "PASTE"]);
  assert.equal(history.body.events.filter((event) => event.type === "PASTE").length, 1);
  assert.equal(history.body.events[1].insertedText, " pasted");
  assert.deepEqual(history.body.events[1].insertPosition, { path: [0], offset: 5 });
  const verified = await request(`/api/documents/${id}/verify`);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.checkedEvents, 2);
  assert.equal(verified.body.headHash, history.body.events[1].eventHash);

  const competing = await Promise.all(["A", "B"].map((letter) => request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 2,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT", snippet: letter },
    contentJson: replaceRange(pastedContent, 0, 0, letter),
  })));
  assert.deepEqual(competing.map((result) => result.status).sort(), [201, 409]);
  const finalDocument = await request(`/api/documents/${id}`);
  assert.equal(finalDocument.body.version, 3);
  const latestVerification = await request(`/api/documents/${id}/verify`);
  assert.equal(latestVerification.body.valid, true);
  assert.equal(latestVerification.body.checkedEvents, 3);
});

test("verification detects changes to saved display metadata", async (context) => {
  const path = join(process.env.PROOFFLOW_DATA_DIR ?? join(process.cwd(), "data"), "proofflow.sqlite");
  if (!existsSync(path)) return context.skip("The target server does not use this local test database");
  const created = await request("/api/documents", "POST", {
    title: "Metadata verification", editorSchemaVersion: 1, contentJson: emptyDocument(),
  });
  const id = created.body.id;
  const saved = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 0,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT", snippet: "original" },
    contentJson: replaceRange(emptyDocument(), 0, 0, "original"),
  });
  assert.equal(saved.status, 201);

  const connection = new DatabaseSync(path);
  try {
    const changed = connection.prepare("UPDATE events SET type = 'PASTE' WHERE id = ?").run(saved.body.eventId);
    if (changed.changes === 0) return context.skip("The target server uses another database");
    const result = await request(`/api/documents/${id}/verify`);
    assert.equal(result.status, 200);
    assert.equal(result.body.valid, false);
    assert.equal(result.body.code, "EVENT_METADATA_MISMATCH");
    const frozen = await request(`/api/documents/${id}/finalize`, "POST", { expectedVersion: 1 });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.body.error, "EVENT_METADATA_MISMATCH");
  } finally {
    connection.prepare("UPDATE events SET type = 'MANUAL_EDIT' WHERE id = ?").run(saved.body.eventId);
    connection.close();
  }
});

test("finalize freezes one version and exports a complete verifiable JSON bundle", async () => {
  const created = await request("/api/documents", "POST", {
    title: "Frozen evidence", editorSchemaVersion: 1, contentJson: emptyDocument(),
  });
  assert.equal(created.status, 201);
  assert.equal("demoAiResponse" in created.body, false);
  const id = created.body.id;
  assert.equal((await request(`/api/documents/${id}/bundle`)).body.error, "DOCUMENT_NOT_FINALIZED");

  const content = replaceRange(emptyDocument(), 0, 0, "Final text");
  const originalEvent = {
    documentId: id, baseVersion: 0,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT", snippet: "Final text" },
    contentJson: content,
  };
  assert.equal((await request(`/api/documents/${id}/events`, "POST", originalEvent)).status, 201);
  const stale = await request(`/api/documents/${id}/finalize`, "POST", { expectedVersion: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "STALE_VERSION");
  assert.equal((await request(`/api/documents/${id}`)).body.status, "draft");

  const frozen = await request(`/api/documents/${id}/finalize`, "POST", { expectedVersion: 1, title: "Final evidence title" });
  assert.equal(frozen.status, 200);
  assert.equal(frozen.body.documentId, id);
  assert.equal(frozen.body.finalVersion, 1);
  assert.equal(frozen.body.title, "Final evidence title");
  assert.equal(frozen.body.eventCount, 1);
  assert.match(frozen.body.contentHash, /^[a-f0-9]{64}$/);
  assert.match(frozen.body.finalizedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual((await request(`/api/documents/${id}/finalize`, "POST", { expectedVersion: 1 })).body, frozen.body);

  const after = await request(`/api/documents/${id}`);
  assert.equal(after.body.status, "finalized");
  assert.equal(after.body.finalizedAt, frozen.body.finalizedAt);
  assert.equal(after.body.version, 1);
  assert.deepEqual(after.body.contentJson, content);
  const rejectedSave = await request(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: 1,
    event: { operationId: randomUUID(), type: "MANUAL_EDIT", snippet: "later" },
    contentJson: replaceRange(content, 10, 10, " later"),
  });
  assert.equal(rejectedSave.status, 409);
  assert.equal(rejectedSave.body.error, "DOCUMENT_FINALIZED");
  assert.equal((await request(`/api/documents/${id}/events`, "POST", originalEvent)).body.replayed, true);

  const bundleResponse = await fetch(`${base}/api/documents/${id}/bundle`, { headers: { Cookie: cookie } });
  assert.equal(bundleResponse.status, 200);
  assert.match(bundleResponse.headers.get("content-disposition"), /attachment; filename="proofflow-evidence-/);
  const bundle = await bundleResponse.json();
  assert.equal(bundle.kind, "proof-flow-evidence");
  assert.deepEqual(bundle.manifest, frozen.body);
  assert.deepEqual(bundle.contentJson, content);
  assert.equal(bundle.events.length, 1);
  assert.equal(verifyEvidencePackage(bundle).valid, true);
  assert.equal(verifyEvidencePackage({ ...bundle, events: [{ ...bundle.events[0], eventHash: "f".repeat(64) }] }).valid, false);
});

test("frozen hash mismatch blocks verification and bundle export", async (context) => {
  const path = join(process.env.PROOFFLOW_DATA_DIR ?? join(process.cwd(), "data"), "proofflow.sqlite");
  if (!existsSync(path)) return context.skip("The target server does not use this local test database");
  const created = await request("/api/documents", "POST", {
    title: "Frozen integrity", editorSchemaVersion: 1, contentJson: emptyDocument(),
  });
  const id = created.body.id;
  assert.equal((await request(`/api/documents/${id}/finalize`, "POST", { expectedVersion: 0 })).status, 200);
  const connection = new DatabaseSync(path);
  const originalHash = connection.prepare("SELECT final_content_hash FROM documents WHERE id = ?").get(id)?.final_content_hash;
  try {
    const changed = connection.prepare("UPDATE documents SET final_content_hash = ? WHERE id = ?").run("f".repeat(64), id);
    if (changed.changes === 0) return context.skip("The target server uses another database");
    const checked = await request(`/api/documents/${id}/verify`);
    assert.equal(checked.body.valid, false);
    assert.equal(checked.body.code, "FROZEN_EVIDENCE_MISMATCH");
    const bundle = await request(`/api/documents/${id}/bundle`);
    assert.equal(bundle.status, 409);
    assert.equal(bundle.body.error, "FROZEN_EVIDENCE_MISMATCH");
  } finally {
    if (originalHash) connection.prepare("UPDATE documents SET final_content_hash = ? WHERE id = ?").run(originalHash, id);
    connection.close();
  }
});
