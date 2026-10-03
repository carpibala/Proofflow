import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { plainText, replaceRange, type EditorDocument } from "../editor-document";
import { samplePrompt, sampleResponse } from "../demo-ai";

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
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
      UNIQUE(document_id, operation_id), UNIQUE(document_id, version)
    );
  `);
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
  operationId: string; type: "MANUAL_EDIT" | "PASTE" | "AI_INSERT";
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
  if (!uuid.test(event.operationId) || !["MANUAL_EDIT", "PASTE", "AI_INSERT"].includes(event.type)) throw new ApiError(400, "INVALID_EVENT", "Invalid operation ID or event type");
  if (event.timestamp && (typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)))) throw new ApiError(400, "INVALID_EVENT", "Invalid timestamp");
  if (event.snippet !== undefined && (typeof event.snippet !== "string" || event.snippet.length > 200)) throw new ApiError(400, "INVALID_EVENT", "Invalid snippet");
  if (event.type !== "MANUAL_EDIT") {
    if (typeof event.insertedText !== "string" || !event.insertedText || event.insertedText.length > 50000) throw new ApiError(400, "INVALID_EVENT", "Inserted text is required");
    if (!event.insertPosition || !Array.isArray(event.insertPosition.path) || event.insertPosition.path.length !== 1 || !Number.isInteger(event.insertPosition.path[0]) || !Number.isInteger(event.insertPosition.offset)) throw new ApiError(400, "INVALID_EVENT", "Invalid insertion position");
    if (Object.keys(event.insertPosition).some((key) => !["path", "offset"].includes(key))) throw new ApiError(400, "INVALID_EVENT", "Unsupported insertion position field");
    if (event.replacedLength !== undefined && (!Number.isInteger(event.replacedLength) || event.replacedLength < 0)) throw new ApiError(400, "INVALID_EVENT", "Invalid replaced length");
  }
  if (event.type === "AI_INSERT" && (typeof event.aiResponseId !== "string" || !uuid.test(event.aiResponseId))) throw new ApiError(400, "INVALID_EVENT", "AI response ID is required");
  return event;
}

export function createDocument(input: unknown) {
  if (!input || typeof input !== "object") throw new ApiError(400, "INVALID_REQUEST", "Request body is required");
  const body = input as { title?: unknown; editorSchemaVersion?: unknown; contentJson?: unknown };
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 200 || body.editorSchemaVersion !== 1) throw new ApiError(400, "INVALID_REQUEST", "Title and editor schema version 1 are required");
  validateDocument(body.contentJson);
  const id = randomUUID();
  const responseId = randomUUID();
  const now = new Date().toISOString();
  const connection = db();
  connection.exec("BEGIN IMMEDIATE");
  try {
    connection.prepare("INSERT INTO documents (id,title,content_json,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, body.title.trim(), JSON.stringify(body.contentJson), now, now);
    connection.prepare("INSERT INTO ai_responses (id,document_id,prompt,response_text,source) VALUES (?,?,?,?,?)").run(responseId, id, samplePrompt, sampleResponse, "demo_sample");
    connection.exec("COMMIT");
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
  return { id, title: body.title.trim(), editorSchemaVersion: 1, version: 0, status: "draft", demoAiResponse: { id: responseId, prompt: samplePrompt, responseText: sampleResponse, source: "demo_sample" } };
}

export function getDocument(id: string) {
  if (!uuid.test(id)) throw new ApiError(400, "INVALID_ID", "Invalid document ID");
  const connection = db();
  const row = connection.prepare("SELECT * FROM documents WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", "Document not found");
  const ai = connection.prepare("SELECT * FROM ai_responses WHERE document_id = ? AND source = 'demo_sample' LIMIT 1").get(id) as Row | undefined;
  return {
    id, title: row.title, editorSchemaVersion: 1, version: row.version, status: row.status,
    contentJson: JSON.parse(row.content_json as string),
    demoAiResponse: ai ? { id: ai.id, prompt: ai.prompt, responseText: ai.response_text, source: ai.source } : null,
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
  }));
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
    if (event.type !== "MANUAL_EDIT") {
      const position = event.insertPosition!;
      const paragraphIndex = position.path[0];
      if (paragraphIndex < 0 || paragraphIndex >= before.content.length) throw new ApiError(422, "INVALID_POSITION", "Paragraph does not exist");
      const paragraphText = before.content[paragraphIndex].content.map((node) => node.text).join("");
      if (position.offset < 0 || position.offset > paragraphText.length) throw new ApiError(422, "INVALID_POSITION", "Offset exceeds paragraph");
      if (event.type === "AI_INSERT") {
        const response = connection.prepare("SELECT response_text FROM ai_responses WHERE id = ? AND document_id = ?").get(event.aiResponseId!, id) as Row | undefined;
        if (!response || response.response_text !== event.insertedText) throw new ApiError(422, "INVALID_AI_RESPONSE", "AI insertion does not match a recorded response");
      }
      const prefixLength = before.content.slice(0, paragraphIndex).reduce((sum, paragraph) => sum + paragraph.content.map((node) => node.text).join("").length + 1, 0);
      const start = prefixLength + position.offset;
      const replacedLength = event.replacedLength ?? 0;
      const expected = replaceRange(before, start, start + replacedLength, event.insertedText!, { sourceOperationId: event.operationId, bold: event.type === "AI_INSERT" });
      if (start + replacedLength > plainText(before).length || canonical(expected) !== canonical(body.contentJson)) throw new ApiError(422, "CONTENT_MISMATCH", "Content does not match the claimed insertion");
    }
    const allowedIds = new Set((connection.prepare("SELECT operation_id FROM events WHERE document_id = ?").all(id) as Row[]).map((entry) => entry.operation_id));
    if (event.type !== "MANUAL_EDIT") allowedIds.add(event.operationId);
    for (const paragraph of body.contentJson.content) for (const node of paragraph.content) {
      if (node.sourceOperationId && !allowedIds.has(node.sourceOperationId)) throw new ApiError(422, "UNKNOWN_SOURCE", "Text references an unknown source operation");
    }
    const version = (row.version as number) + 1;
    const eventId = randomUUID();
    const receivedAt = new Date().toISOString();
    const last = connection.prepare("SELECT event_hash FROM events WHERE document_id = ? ORDER BY version DESC LIMIT 1").get(id) as Row | undefined;
    const previousHash = last?.event_hash as string ?? "0".repeat(64);
    const eventHash = sha256(canonical({ previousHash, documentId: id, version, eventId, event, receivedAt, contentJson: body.contentJson }));
    connection.prepare(`INSERT INTO events (id,document_id,operation_id,version,type,client_timestamp,received_at,snippet,ai_response_id,inserted_text,insert_position_json,replaced_length,content_after_json,request_hash,previous_hash,event_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(eventId, id, event.operationId, version, event.type, event.timestamp ?? null, receivedAt, event.snippet ?? "", event.aiResponseId ?? null, event.insertedText ?? null, event.insertPosition ? JSON.stringify(event.insertPosition) : null, event.replacedLength ?? null, JSON.stringify(body.contentJson), requestHash, previousHash, eventHash);
    connection.prepare("UPDATE documents SET content_json = ?, version = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(body.contentJson), version, receivedAt, id);
    connection.exec("COMMIT");
    return { documentId: id, eventId, operationId: event.operationId, version, saved: true, replayed: false };
  } catch (error) { connection.exec("ROLLBACK"); throw error; }
}
