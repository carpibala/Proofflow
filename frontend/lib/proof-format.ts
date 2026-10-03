import { createHash } from "node:crypto";
import type { EditorDocument } from "./editor-document";

export const HASH_FORMAT_VERSION = 1;
export const GENESIS_HASH = "0".repeat(64);

export type ProofEvent = {
  operationId: string;
  type: "MANUAL_EDIT" | "PASTE" | "AI_INSERT";
  timestamp: string | null;
  snippet: string | null;
  aiResponseId: string | null;
  insertedText: string | null;
  insertPosition: { path: number[]; offset: number } | null;
  replacedLength: number | null;
};

export type EvidenceEvent = {
  eventId: string;
  documentId: string;
  version: number;
  event: ProofEvent;
  receivedAt: string;
  contentAfter: EditorDocument;
  previousHash: string;
  eventHash: string;
};

export type FrozenManifest = {
  documentId: string;
  title: string;
  finalVersion: number;
  finalizedAt: string;
  contentHash: string;
  eventCount: number;
  eventHeadHash: string;
  hashFormatVersion: 1;
};

export type EvidenceData = {
  documentId: string;
  finalVersion: number;
  contentJson: EditorDocument;
  eventCount: number;
  eventHeadHash: string;
  contentHash: string;
  events: EvidenceEvent[];
};

export type EvidencePackage = {
  formatVersion: 1;
  kind: "proof-flow-evidence";
  manifest: FrozenManifest;
  contentJson: EditorDocument;
  events: EvidenceEvent[];
};

// Accept JSON values only. Objects sort keys by UTF-16 code units; arrays keep order.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new TypeError("Canonical input must be JSON without undefined or non-finite numbers");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function normalizeProofEvent(event: {
  operationId: string;
  type: ProofEvent["type"];
  timestamp?: string | null;
  snippet?: string | null;
  aiResponseId?: string | null;
  insertedText?: string | null;
  insertPosition?: ProofEvent["insertPosition"];
  replacedLength?: number | null;
}): ProofEvent {
  return {
    operationId: event.operationId,
    type: event.type,
    timestamp: event.timestamp ?? null,
    snippet: event.snippet ?? null,
    aiResponseId: event.aiResponseId ?? null,
    insertedText: event.insertedText ?? null,
    insertPosition: event.insertPosition ?? null,
    replacedLength: event.replacedLength ?? null,
  };
}

export function hashContent(contentJson: EditorDocument): string {
  return sha256Hex(`ProofFlow content v1\n${canonicalJson(contentJson)}`);
}

export function hashEvidenceEvent(event: Omit<EvidenceEvent, "eventHash">): string {
  return sha256Hex(`ProofFlow event v1\n${canonicalJson({
    previousHash: event.previousHash,
    documentId: event.documentId,
    version: event.version,
    eventId: event.eventId,
    event: event.event,
    receivedAt: event.receivedAt,
    contentJson: event.contentAfter,
  })}`);
}

export type ChainVerification = {
  valid: boolean;
  checkedEvents: number;
  headHash: string;
  code?: string;
  message?: string;
};

// This verifier only needs an evidence package, so it can also run outside the API/database.
export function verifyEvidenceChain(evidence: EvidenceData, expectedHeadHash?: string): ChainVerification {
  const fail = (code: string, message: string, checkedEvents: number): ChainVerification => ({
    valid: false, checkedEvents, headHash: evidence.eventHeadHash, code, message,
  });
  if (evidence.eventCount !== evidence.events.length || evidence.finalVersion !== evidence.events.length) {
    return fail("INCOMPLETE_HISTORY", "Event count does not match document version", 0);
  }
  let previousHash = GENESIS_HASH;
  const eventIds = new Set<string>();
  const operationIds = new Set<string>();
  for (const [index, event] of evidence.events.entries()) {
    if (!event || !event.event || event.documentId !== evidence.documentId || event.version !== index + 1 ||
        eventIds.has(event.eventId) || operationIds.has(event.event.operationId)) {
      return fail("INVALID_EVENT_SEQUENCE", `Event ${index + 1} has an invalid identity or version`, index);
    }
    if (event.previousHash !== previousHash) {
      return fail("BROKEN_EVENT_CHAIN", `Event ${index + 1} has the wrong previous hash`, index);
    }
    try {
      if (hashEvidenceEvent(event) !== event.eventHash) {
        return fail("BROKEN_EVENT_CHAIN", `Event ${index + 1} hash does not match its contents`, index);
      }
    } catch {
      return fail("INVALID_EVENT_PAYLOAD", `Event ${index + 1} cannot be hashed`, index);
    }
    eventIds.add(event.eventId);
    operationIds.add(event.event.operationId);
    previousHash = event.eventHash;
  }
  if (evidence.eventHeadHash !== previousHash) {
    return fail("HEAD_MISMATCH", "Stored head hash does not match the event chain", evidence.events.length);
  }
  try {
    if (hashContent(evidence.contentJson) !== evidence.contentHash ||
        (evidence.events.length > 0 && canonicalJson(evidence.events.at(-1)!.contentAfter) !== canonicalJson(evidence.contentJson))) {
      return fail("CONTENT_MISMATCH", "Current document differs from the recorded final content", evidence.events.length);
    }
  } catch {
    return fail("INVALID_CONTENT", "Current document cannot be hashed", evidence.events.length);
  }
  if (expectedHeadHash !== undefined && expectedHeadHash !== previousHash) {
    return fail("ANCHOR_MISMATCH", "Event head differs from the trusted external head", evidence.events.length);
  }
  return { valid: true, checkedEvents: evidence.events.length, headHash: previousHash };
}

export function verifyEvidencePackage(value: unknown): ChainVerification {
  const invalid: ChainVerification = { valid: false, checkedEvents: 0, headHash: "", code: "INVALID_BUNDLE", message: "Evidence package is incomplete or unsupported" };
  if (!value || typeof value !== "object") return invalid;
  const bundle = value as Partial<EvidencePackage>;
  const manifest = bundle.manifest;
  if (bundle.formatVersion !== 1 || bundle.kind !== "proof-flow-evidence" ||
      !manifest || typeof manifest.documentId !== "string" || typeof manifest.title !== "string" ||
      !Number.isInteger(manifest.finalVersion) || typeof manifest.finalizedAt !== "string" ||
      typeof manifest.contentHash !== "string" || !Number.isInteger(manifest.eventCount) ||
      typeof manifest.eventHeadHash !== "string" || manifest.hashFormatVersion !== 1 ||
      !bundle.contentJson || !Array.isArray(bundle.events)) return invalid;
  try {
    return verifyEvidenceChain({
      documentId: manifest.documentId,
      finalVersion: manifest.finalVersion,
      contentJson: bundle.contentJson,
      contentHash: manifest.contentHash,
      eventCount: manifest.eventCount,
      eventHeadHash: manifest.eventHeadHash,
      events: bundle.events,
    });
  } catch {
    return invalid;
  }
}
