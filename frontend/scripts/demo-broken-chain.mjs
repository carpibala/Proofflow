import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { emptyDocument, replaceRange } from "../lib/editor-document.ts";

const action = process.argv[2] ?? "prepare";
const documentId = action === "tamper" ? process.argv[3] : null;
const base = ((action === "tamper" ? process.argv[4] : process.argv[3]) ?? "http://127.0.0.1:3002").replace(/\/$/, "");
const databasePath = fileURLToPath(new URL("../data/proofflow.sqlite", import.meta.url));
const demoTitle = "Hash chain demonstration";

async function api(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function prepare() {
  const created = await api("/api/documents", "POST", {
    title: demoTitle, editorSchemaVersion: 1, contentJson: emptyDocument(),
  });
  const id = created.id;
  let content = emptyDocument();
  let version = 0;

  async function save(event, nextContent) {
    const result = await api(`/api/documents/${id}/events`, "POST", {
      documentId: id, baseVersion: version,
      event: { operationId: randomUUID(), timestamp: new Date().toISOString(), ...event },
      contentJson: nextContent,
    });
    version = result.version;
    content = nextContent;
  }

  await save({ type: "MANUAL_EDIT", snippet: "Hello world." }, replaceRange(content, 0, 0, "Hello world."));
  const pasteId = randomUUID();
  const pasteContent = replaceRange(content, 12, 12, " Pasted text.", { sourceOperationId: pasteId });
  const paste = await api(`/api/documents/${id}/events`, "POST", {
    documentId: id, baseVersion: version,
    event: { operationId: pasteId, type: "PASTE", timestamp: new Date().toISOString(),
      snippet: "Pasted text.", insertedText: " Pasted text.", insertPosition: { path: [0], offset: 12 } },
    contentJson: pasteContent,
  });
  version = paste.version;
  content = pasteContent;
  await save({ type: "MANUAL_EDIT", snippet: "Removed world" }, replaceRange(content, 6, 11, ""));
  await api(`/api/documents/${id}/finalize`, "POST", { expectedVersion: version });

  const before = await api(`/api/documents/${id}/verify`);
  if (!before.valid) throw new Error(`Expected a valid chain before the demonstration: ${JSON.stringify(before)}`);

  console.log(`Demo document ID: ${id}`);
  console.log(`Open this frozen report and download its evidence bundle: ${base}/report/${id}`);
  console.log(`Verification: valid=${before.valid}, checked=${before.checkedEvents}`);
  console.log(`To break this demo's link: npm run demo:broken-chain -- tamper ${id} ${base}`);
}

async function tamper() {
  if (!documentId || !/^[0-9a-f-]{36}$/i.test(documentId)) throw new Error("Pass the demo document ID printed by prepare.");
  const before = await api(`/api/documents/${documentId}/verify`);
  if (!before.valid || before.checkedEvents !== 3) throw new Error("The selected demo document is not an intact three-event chain.");

  const connection = new DatabaseSync(databasePath);
  try {
    const document = connection.prepare("SELECT title, version FROM documents WHERE id = ?").get(documentId);
    const rows = connection.prepare("SELECT version, type, snippet FROM events WHERE document_id = ? ORDER BY version").all(documentId);
    if (document?.title !== demoTitle || document.version !== 3 ||
        rows.length !== 3 || rows[0].snippet !== "Hello world." ||
        rows[1].type !== "PASTE" || rows[1].snippet !== "Pasted text." ||
        rows[2].snippet !== "Removed world") {
      throw new Error("This ID is not a demo document created by prepare. No record was changed.");
    }
    const changed = connection.prepare("UPDATE events SET previous_hash = ? WHERE document_id = ? AND version = 2")
      .run("f".repeat(64), documentId);
    if (changed.changes !== 1) throw new Error("Expected exactly one demo record to change.");
  } finally {
    connection.close();
  }

  const after = await api(`/api/documents/${documentId}/verify`);
  if (after.valid || after.code !== "BROKEN_EVENT_CHAIN") throw new Error(`Expected a broken chain: ${JSON.stringify(after)}`);
  console.log(`Refresh this report: ${base}/report/${documentId}`);
  console.log(`Before: valid=${before.valid}, checked=${before.checkedEvents}`);
  console.log(`After: valid=${after.valid}, code=${after.code}, message=${after.message}`);
  console.log("Only the selected, script-created demo document was modified. Run prepare again for a fresh example.");
}

async function main() {
  if (!existsSync(databasePath)) throw new Error(`Local database not found: ${databasePath}. Start this worktree's dev server first.`);
  if (action === "prepare") return prepare();
  if (action === "tamper") return tamper();
  throw new Error("Usage: demo-broken-chain.mjs prepare [baseUrl] | tamper <documentId> [baseUrl]");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
