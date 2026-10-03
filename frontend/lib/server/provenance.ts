import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { plainText, replaceRange, type EditorDocument } from "../editor-document";
import { canonicalJson, GENESIS_HASH, HASH_FORMAT_VERSION, hashContent, hashEvidenceEvent, normalizeProofEvent, verifyEvidenceChain, type EvidenceData, type EvidenceEvent, type EvidencePackage, type FrozenManifest, type ProofEvent } from "../proof-format";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let database: DatabaseSync | undefined;

function db(): DatabaseSync {
  if (database) return database;
  const directory = join(process.cwd(), "data");
  mkdirSync(directory, { recursive: true });
  const connection = new DatabaseSync(join(directory, "proofflow.sqlite"));
  connection.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  connection.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft', content_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      finalized_at TEXT, final_content_hash TEXT, final_event_head_hash TEXT,
      final_event_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS ai_responses (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
      prompt TEXT NOT NULL, response_text TEXT NOT NULL, source TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
      operation_id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
      client_timestamp TEXT, received_at TEXT NOT NULL, snippet TEXT NOT NULL,
      ai_response_id TEXT, inserted_text TEXT, insert_position_json TEXT,
      replaced_length INTEGER, content_after_json TEXT NOT NULL, request_hash TEXT NOT NULL,
      previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
      hash_format_version INTEGER NOT NULL DEFAULT 0, event_payload_json TEXT,
      UNIQUE(document_id, operation_id), UNIQUE(document_id, version)
    );
  `);
  const columns = new Set((connection.prepare("PRAGMA table_info(events)").all() as { name: string }[]).map((column) => column.name));
  if (!columns.has("hash_format_version")) connection.exec("ALTER TABLE events ADD COLUMN hash_format_version INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("event_payload_json")) connection.exec("ALTER TABLE events ADD COLUMN event_payload_json TEXT");
  const documentColumns = new Set((connection.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((column) => column.name));
  if (!documentColumns.has("finalized_at")) connection.exec("ALTER TABLE documents ADD COLUMN finalized_at TEXT");
  if (!documentColumns.has("final_content_hash")) connection.exec("ALTER TABLE documents ADD COLUMN final_content_hash TEXT");
  if (!documentColumns.has("final_event_head_hash")) connection.exec("ALTER TABLE documents ADD COLUMN final_event_head_hash TEXT");
  if (!documentColumns.has("final_event_count")) connection.exec("ALTER TABLE documents ADD COLUMN final_event_count INTEGER");
  database = connection;
  return connection;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

type Row = Record<string, string | number | null>;
type EventInput = {
  operationId: string; type: "MANUAL_EDIT" | "PASTE";
  timestamp?: string; snippet?: string; insertedText?: string;
  insertPosition?: { path: number[]; offset: number };
  replacedLength?: number; aiResponseId?: string | null;
};

export function validateDocument(value: unknown): asserts value is EditorDocument {
  if (!value || typeof value !== "object" || (value as EditorDocument).type !== "doc") throw new ApiError(422, "INVALID_DOCUMENT", "Expected a doc root");
  if (Object.keys(value).some((key) => !["type", "content"].includes(key))) throw new ApiError(422, "INVALID_DOCUMENT", "Unsupported document field");
  const paragraphs = (value as EditorDocument).content;
  if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > 1000) throw new ApiError(422, "INVALID_DOCUMENT", "Invalid paragraph count");
  for (const paragraph of paragraphs) {
    if (!paragraph || paragraph.type !== "paragraph" || !Array.isArray(paragraph.content) || paragraph.content.length > 10000 || Object.keys(paragraph).some((key) => !["type", "content"].includes(key))) throw new ApiError(422, "INVALID_DOCUMENT", "Invalid paragraph");
    for (const node of paragraph.content) {
      if (!node || node.type !== "text" || typeof node.text !== "string" || !node.text || node.text.includes("\n") || Object.keys(node).some((key) => !["type", "text", "marks", "sourceOperationId"].includes(key))) throw new ApiError(422, "INVALID_DOCUMENT", "Invalid text node");
      if (node.marks && (!Array.isArray(node.marks) || node.marks.length !== 1 || node.marks[0]?.type !== "bold")) throw new ApiError(422, "INVALID_DOCUMENT", "Unsupported marks");
      if (node.sourceOperationId && !uuid.test(node.sourceOperationId)) throw new ApiError(422, "INVALID_DOCUMENT", "Invalid source operation ID");
    }
  }
  if (plainText(value as EditorDocument).length > 100000 || JSON.stringify(value).length > 200000) throw new ApiError(413, "DOCUMENT_TOO_LARGE", "Document exceeds demo limit");
}

function validateEvent(value: unknown): EventInput {
  if (!value || typeof value !== "object") throw new ApiError(400, "INVALID_EVENT", "Event is required");
  const event = value as EventInput;
  if (Object.keys(event).some((key) => !["operationId", "type", "timestamp", "snippet", "insertedText", "insertPosition", "replacedLength", "aiResponseId"].includes(key))) throw new ApiError(400, "INVALID_EVENT", "Unsupported event field");
  if (!uuid.test(event.operationId) || !["MANUAL_EDIT", "PASTE"].includes(event.type) ||
      (event.aiResponseId !== undefined && event.aiResponseId !== null)) throw new ApiError(400, "INVALID_EVENT", "Invalid operation ID or event type");
  if (event.timestamp && (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)))) throw new ApiError(400, "INVALID_EVENT", "Invalid timestamp");
  if (event.snippet !== undefined && (typeof event.snippet !== "string" || event.snippet.length > 200)) throw new ApiError(400, "INVALID_EVENT", "Invalid snippet");
  if (event.type !== "MANUAL_EDIT") {
    if (typeof event.insertedText !== "string" || !event.insertedText || event.insertedText.length > 50000) throw new ApiError(400, "INVALID_EVENT", "Inserted text is required");
    if (!event.insertPosition || !Array.isArray(event.insertPosition.path) || event.insertPosition.path.length !== 1 || !Number.isInteger(event.insertPosition.path[0]) || !Number.isInteger(event.insertPosition.offset)) throw new ApiError(400, "INVALID_EVENT", "Invalid insertion position");
    if (Object.keys(event.insertPosition).some((key) => !["path", "offset"].includes(key))) throw new ApiError(400, "INVALID_EVENT", "Unsupported insertion position field");
    if (event.replacedLength !== undefined && (!Number.isInteger(event.replacedLength) || event.replacedLength < 0)) throw new ApiError(400, "INVALID_EVENT", "Invalid replaced length");
  }
  return event;
}

export function createDocument(input: unknown) {
  if (!input || typeof input !== "object") throw new ApiError(400, "INVALID_REQUEST", "Request body is required");
  const body = input as { title?: unknown; editorSchemaVersion?: unknown; contentJson?: unknown };
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 || body.editorSchemaVersion !== 1) throw new ApiError(400, "INVALID_REQUEST", "Title and editor schema version 1 are required");
  validateDocument(body.contentJson);
  const id = randomUUID();
  const now = new Date().toISOString();
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare("INSERT INTO documents (id,title,content_json,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, body.title.trim(), JSON.stringify(body.contentJson), now, now);
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { id, title: body.title.trim(), editorSchemaVersion: 1, version: 0, status: "draft" };
}

export function getDocument(id: string) {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  const connection = db();
  const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found");
  return {
    id, title: row.title, editorSchemaVersion: 1, version: row.version, status: row.status,
    finalizedAt: row.finalized_at,
    contentJson: JSON.parse(row.content_json as string),
  };
}

export function listEvents(id: string) {
  getDocument(id);
  const rows = db().prepare("SELECT * FROM events WHERE document_id = ? ORDER BY version ASC").all(id) as Row[];
  return rows.map((row) => ({
    id: row.id, documentId: id, operationId: row.operation_id, version: row.version,
    type: row.type, timestamp: row.client_timestamp, receivedAt: row.received_at, snippet: row.snippet,
    aiResponseId: row.ai_response_id, insertedText: row.inserted_text,
    insertPosition: row.insert_position_json ? JSON.parse(row.insert_position_json as string) : null,
    replacedLength: row.replaced_length, contentAfter: JSON.parse(row.content_after_json as string),
    previousHash: row.previous_hash, eventHash: row.event_hash,
    hashFormatVersion: row.hash_format_version,
    event: row.event_payload_json ? JSON.parse(row.event_payload_json as string) : null,
  }));
}

// Legacy event rows lack the original optional-field shape and cannot be certified as v1.
function assembleEvidence(connection: DatabaseSync, id: string): EvidenceData {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  const document = connection.prepare("SELECT version, content_json FROM documents WHERE id = ?").get(id) as Row | undefined;
  if (!document) throw new ApiError(404, "NOT_FOUND", "Document not found");
  const rows = connection.prepare("SELECT * FROM events WHERE document_id = ? ORDER BY version ASC").all(id) as Row[];
  const contentJson = JSON.parse(document.content_json as string) as EditorDocument;
  const events: EvidenceEvent[] = [];
  for (const row of rows) {
    if (row.hash_format_version !== HASH_FORMAT_VERSION || typeof row.event_payload_json !== "string") {
      throw new ApiError(409, "LEGACY_EVENT_FORMAT", "Document contains events without a reproducible v1 payload");
    }
    const event: EvidenceEvent = {
      eventId: row.id as string,
      documentId: id,
      version: row.version as number,
      event: JSON.parse(row.event_payload_json) as ProofEvent,
      receivedAt: row.received_at as string,
      contentAfter: JSON.parse(row.content_after_json as string) as EditorDocument,
      previousHash: row.previous_hash as string,
      eventHash: row.event_hash as string,
    };
    if (row.operation_id !== event.event.operationId || row.type !== event.event.type ||
        row.client_timestamp !== event.event.timestamp || row.snippet !== (event.event.snippet ?? "") ||
        row.ai_response_id !== event.event.aiResponseId || row.inserted_text !== event.event.insertedText ||
        row.replaced_length !== event.event.replacedLength ||
        canonicalJson(row.insert_position_json ? JSON.parse(row.insert_position_json as string) : null) !== canonicalJson(event.event.insertPosition)) {
      throw new ApiError(409, "EVENT_METADATA_MISMATCH", "Stored event fields differ from their hashed payload");
    }
    events.push(event);
  }
  const evidence: EvidenceData = {
    documentId: id,
    finalVersion: document.version as number,
    contentJson,
    eventCount: events.length,
    eventHeadHash: events.at(-1)?.eventHash ?? GENESIS_HASH,
    contentHash: hashContent(contentJson),
    events,
  };
  return evidence;
}

function readVerifiedEvidence(connection: DatabaseSync, id: string): EvidenceData {
  const evidence = assembleEvidence(connection, id);
  const result = verifyEvidenceChain(evidence);
  if (!result.valid) throw new ApiError(409, result.code!, result.message!);
  return evidence;
}

function frozenManifest(row: Row, evidence: EvidenceData): FrozenManifest {
  if (row.status !== "finalized" || typeof row.finalized_at !== "string" ||
      row.final_content_hash !== evidence.contentHash ||
      row.final_event_head_hash !== evidence.eventHeadHash ||
      row.final_event_count !== evidence.eventCount || row.version !== evidence.finalVersion) {
    throw new ApiError(409, "FROZEN_EVIDENCE_MISMATCH", "Finalized evidence differs from the frozen manifest");
  }
  return {
    documentId: evidence.documentId,
    title: row.title as string,
    finalVersion: evidence.finalVersion,
    finalizedAt: row.finalized_at,
    contentHash: evidence.contentHash,
    eventCount: evidence.eventCount,
    eventHeadHash: evidence.eventHeadHash,
    hashFormatVersion: HASH_FORMAT_VERSION,
  };
}

export function finalizeDocument(id: string, input: unknown): FrozenManifest {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  const body = input as { expectedVersion?: unknown; title?: unknown } | null;
  if (!body || typeof body !== "object" || !Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 0 ||
      (body.title !== undefined && (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200)) ||
      Object.keys(body).some((key) => key !== "expectedVersion" && key !== "title")) {
    throw new ApiError(400, "INVALID_REQUEST", "A non-negative expectedVersion is required");
  }
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found");
    if (row.version !== body.expectedVersion) throw new ApiError(409, "STALE_VERSION", "Document version has changed");
    if (row.status === "finalized") {
      const manifest = frozenManifest(row, readVerifiedEvidence(connection, id));
      connection.exec("COMMIT");
      return manifest;
    }
    if (row.status !== "draft") throw new ApiError(409, "INVALID_STATUS", "Document cannot be finalized");
    const evidence = readVerifiedEvidence(connection, id);
    const finalizedAt = new Date().toISOString();
    const finalTitle = typeof body.title === "string" ? body.title.trim() : row.title as string;
    connection.prepare(`UPDATE documents SET title = ?, status = 'finalized', finalized_at = ?,
      final_content_hash = ?, final_event_head_hash = ?, final_event_count = ?, updated_at = ? WHERE id = ?`)
      .run(finalTitle, finalizedAt, evidence.contentHash, evidence.eventHeadHash, evidence.eventCount, finalizedAt, id);
    const manifest = frozenManifest({ ...row, title: finalTitle, status: "finalized", finalized_at: finalizedAt,
      final_content_hash: evidence.contentHash, final_event_head_hash: evidence.eventHeadHash,
      final_event_count: evidence.eventCount }, evidence);
    connection.exec("COMMIT");
    return manifest;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

export function getEvidencePackage(id: string): EvidencePackage {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  const connection = db();
  connection.exec("BEGIN");
  try {
    const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found");
    if (row.status !== "finalized") throw new ApiError(409, "DOCUMENT_NOT_FINALIZED", "Finalize the document before exporting evidence");
    const evidence = readVerifiedEvidence(connection, id);
    const result: EvidencePackage = { formatVersion: 1, kind: "proof-flow-evidence",
      manifest: frozenManifest(row, evidence), contentJson: evidence.contentJson, events: evidence.events };
    connection.exec("COMMIT");
    return result;
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}

export function verifyDocumentChain(id: string) {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  try {
    const connection = db();
    const evidence = assembleEvidence(connection, id);
    const result = verifyEvidenceChain(evidence);
    if (!result.valid) return result;
    const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row;
    if (row.status === "finalized") frozenManifest(row, evidence);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      return { valid: false, checkedEvents: 0, headHash: "", code: error.code, message: error.message };
    }
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return { valid: false, checkedEvents: 0, headHash: "", code: "INVALID_STORED_DATA", message: "Stored evidence cannot be parsed or hashed" };
    }
    throw error;
  }
}

export function saveEvent(id: string, input: unknown) {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  if (!input || typeof input !== "object") throw new ApiError(400, "INVALID_REQUEST", "Request body is required");
  const body = input as { documentId?: unknown; baseVersion?: unknown; event?: unknown; contentJson?: unknown; editorSchemaVersion?: unknown };
  if (body.documentId !== id || !Number.isInteger(body.baseVersion) || (body.baseVersion as number) < 0 || (body.editorSchemaVersion !== undefined && body.editorSchemaVersion !== 1)) throw new ApiError(400, "INVALID_REQUEST", "Document ID, base version or schema version is invalid");
  const event = validateEvent(body.event);
  validateDocument(body.contentJson);
  const requestHash = sha256(canonical({ documentId: id, baseVersion: body.baseVersion, event, contentJson: body.contentJson }));
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found");
    const previous = connection.prepare("SELECT * FROM events WHERE document_id = ? AND operation_id = ?").get(id, event.operationId) as Row | undefined;
    if (previous) {
      if (previous.request_hash !== requestHash) throw new ApiError(409, "OPERATION_CONFLICT", "Operation ID was reused with different data");
      connection.exec("COMMIT");
      return { documentId: id, eventId: previous.id, operationId: event.operationId, version: previous.version, saved: true, replayed: true };
    }
    if (row.status !== "draft") throw new ApiError(409, "DOCUMENT_FINALIZED", "Document is not editable");
    if (row.version !== body.baseVersion) throw new ApiError(409, "STALE_VERSION", "Document version has changed");
    const before = JSON.parse(row.content_json as string) as EditorDocument;
    if (event.type === "PASTE") {
      const position = event.insertPosition!;
      const paragraphIndex = position.path[0];
      if (paragraphIndex < 0 || paragraphIndex >= before.content.length) throw new ApiError(422, "INVALID_POSITION", "Paragraph does not exist");
      const paragraphText = before.content[paragraphIndex].content.map((node) => node.text).join("");
      if (position.offset < 0 || position.offset > paragraphText.length) throw new ApiError(422, "INVALID_POSITION", "Offset exceeds paragraph");
      const prefixLength = before.content.slice(0, paragraphIndex).reduce((sum, paragraph) => sum + paragraph.content.map((node) => node.text).join("").length + 1, 0);
      const start = prefixLength + position.offset;
      const replacedLength = event.replacedLength ?? 0;
      const expected = replaceRange(before, start, start + replacedLength, event.insertedText!, { sourceOperationId: event.operationId });
      if (start + replacedLength > plainText(before).length || canonical(expected) !== canonical(body.contentJson)) throw new ApiError(422, "CONTENT_MISMATCH", "Content does not match the claimed insertion");
    }
    const allowedIds = new Set((connection.prepare("SELECT operation_id FROM events WHERE document_id = ?").all(id) as Row[]).map((entry) => entry.operation_id));
    if (event.type === "PASTE") allowedIds.add(event.operationId);
    for (const paragraph of body.contentJson.content) for (const node of paragraph.content) {
      if (node.sourceOperationId && !allowedIds.has(node.sourceOperationId)) throw new ApiError(422, "UNKNOWN_SOURCE", "Text references an unknown source operation");
    }
    const version = (row.version as number) + 1;
    const eventId = randomUUID();
    const receivedAt = new Date().toISOString();
    const last = connection.prepare("SELECT event_hash FROM events WHERE document_id = ? ORDER BY version DESC LIMIT 1").get(id) as Row | undefined;
    const previousHash = last?.event_hash as string ?? GENESIS_HASH;
    const proofEvent = normalizeProofEvent(event);
    const eventHash = hashEvidenceEvent({ eventId, documentId: id, version, event: proofEvent, receivedAt, contentAfter: body.contentJson as EditorDocument, previousHash });
    connection.prepare(`INSERT INTO events (id,document_id,operation_id,version,type,client_timestamp,received_at,snippet,ai_response_id,inserted_text,insert_position_json,replaced_length,content_after_json,request_hash,previous_hash,event_hash,hash_format_version,event_payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, id, event.operationId, version, event.type, event.timestamp ?? null, receivedAt, event.snippet ?? "", event.aiResponseId ?? null, event.insertedText ?? null, event.insertPosition ? JSON.stringify(event.insertPosition) : null, event.replacedLength ?? null, JSON.stringify(body.contentJson), requestHash, previousHash, eventHash, HASH_FORMAT_VERSION, canonicalJson(proofEvent));
    connection.prepare("UPDATE documents SET content_json = ?, version = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(body.contentJson), version, receivedAt, id);
    connection.exec("COMMIT");
    return { documentId: id, eventId, operationId: event.operationId, version, saved: true, replayed: false };
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
