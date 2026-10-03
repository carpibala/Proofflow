import { createHash, createPublicKey, KeyObject } from "node:crypto";
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

export type UnsignedCertificate = {
  certificateId: string;
  documentId: string;
  finalVersion: number;
  finalizedAt: string;
  contentHash: string;
  eventCount: number;
  eventHeadHash: string;
  hashFormatVersion: 1;
  keyId: string;
};

export type Certificate = UnsignedCertificate & { signature: string };

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
  certificate: Certificate;
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

export function keyIdFromPublicKey(publicKey: KeyObject | string | Buffer): string {
  const key = publicKey instanceof KeyObject && publicKey.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Expected an Ed25519 public key");
  const spki = key.export({ format: "der", type: "spki" });
  return `ed25519-sha256:${createHash("sha256").update(spki).digest("hex")}`;
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

export function certificateSigningBytes(certificate: UnsignedCertificate): Buffer {
  const fields: UnsignedCertificate = {
    certificateId: certificate.certificateId,
    documentId: certificate.documentId,
    finalVersion: certificate.finalVersion,
    finalizedAt: certificate.finalizedAt,
    contentHash: certificate.contentHash,
    eventCount: certificate.eventCount,
    eventHeadHash: certificate.eventHeadHash,
    hashFormatVersion: certificate.hashFormatVersion,
    keyId: certificate.keyId,
  };
  return Buffer.from(`ProofFlow certificate v1\n${canonicalJson(fields)}`, "utf8");
}
