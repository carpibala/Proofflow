import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import {
  canonicalJson, certificateSigningBytes, GENESIS_HASH, hashContent,
  hashEvidenceEvent, keyIdFromPublicKey, normalizeProofEvent, verifyEvidenceChain,
} from "../lib/proof-format.ts";

const documentId = "11111111-1111-4111-8111-111111111111";
const contentJson = {
  type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "中文 😀" }] }],
};
const first = {
  eventId: "22222222-2222-4222-8222-222222222222",
  documentId,
  version: 1,
  event: normalizeProofEvent({
    operationId: "33333333-3333-4333-8333-333333333333",
    type: "MANUAL_EDIT", snippet: "中文 😀",
  }),
  receivedAt: "2026-10-03T00:00:00.000Z",
  contentAfter: contentJson,
  previousHash: GENESIS_HASH,
};

test("golden v1 content and event hashes are stable across key order and optional nulls", () => {
  const reversedContent = {
    content: [{ content: [{ text: "中文 😀", type: "text" }], type: "paragraph" }], type: "doc",
  };
  const reorderedEvent = { ...first, contentAfter: reversedContent, event: {
    snippet: "中文 😀", replacedLength: null, operationId: first.event.operationId,
    insertPosition: null, insertedText: null, aiResponseId: null,
    timestamp: null, type: "MANUAL_EDIT",
  } };
  assert.equal(canonicalJson(first.event), '{"aiResponseId":null,"insertPosition":null,"insertedText":null,"operationId":"33333333-3333-4333-8333-333333333333","replacedLength":null,"snippet":"中文 😀","timestamp":null,"type":"MANUAL_EDIT"}');
  assert.equal(hashContent(contentJson), hashContent(reversedContent));
  assert.equal(hashEvidenceEvent(first), hashEvidenceEvent(reorderedEvent));
  assert.equal(hashContent(contentJson), "ea47080ed6c8845e3e80208c5d6c59882ec64b05555e48914957a77c1ecee0b2");
  assert.equal(hashEvidenceEvent(first), "353adb19ad090c6e79bfad433478f6a03de0fb3e4290702ca2391ceef9fc3be2");
  assert.deepEqual(normalizeProofEvent({ operationId: first.event.operationId, type: "MANUAL_EDIT", snippet: "中文 😀", timestamp: null }), first.event);
  assert.throws(() => canonicalJson({ bad: undefined }), TypeError);
});

test("changes to content or event change the v1 digest", () => {
  assert.notEqual(hashContent({ ...contentJson, content: [{ type: "paragraph", content: [{ type: "text", text: "中文 😃" }] }] }), hashContent(contentJson));
  assert.notEqual(hashEvidenceEvent({ ...first, event: { ...first.event, snippet: "另一段" } }), hashEvidenceEvent(first));
  assert.notEqual(hashEvidenceEvent({ ...first, contentAfter: { ...contentJson, content: [] } }), hashEvidenceEvent(first));
  assert.notEqual(hashEvidenceEvent({ ...first, version: 2 }), hashEvidenceEvent(first));
});

test("standalone chain verifier checks sequence, payload, final content and an optional anchor", () => {
  const event = { ...first, eventHash: hashEvidenceEvent(first) };
  const evidence = {
    documentId, finalVersion: 1, contentJson, eventCount: 1,
    eventHeadHash: event.eventHash, contentHash: hashContent(contentJson), events: [event],
  };
  assert.deepEqual(verifyEvidenceChain(evidence), { valid: true, checkedEvents: 1, headHash: event.eventHash });
  assert.equal(verifyEvidenceChain(evidence, "f".repeat(64)).code, "ANCHOR_MISMATCH");
  assert.equal(verifyEvidenceChain({ ...evidence, events: [] }).code, "INCOMPLETE_HISTORY");
  assert.equal(verifyEvidenceChain({ ...evidence, events: [{ ...event, version: 2 }] }).code, "INVALID_EVENT_SEQUENCE");
  assert.equal(verifyEvidenceChain({ ...evidence, events: [{ ...event, event: { ...event.event, snippet: "tampered" } }] }).code, "BROKEN_EVENT_CHAIN");
  assert.equal(verifyEvidenceChain({ ...evidence, contentJson: { ...contentJson, content: [] } }).code, "CONTENT_MISMATCH");
  assert.equal(verifyEvidenceChain({ ...evidence, eventHeadHash: "f".repeat(64) }).code, "HEAD_MISMATCH");
});

test("certificate signing bytes bind metadata and omit signature", () => {
  const unsigned = {
    certificateId: "44444444-4444-4444-8444-444444444444",
    documentId,
    finalVersion: 1,
    finalizedAt: "2026-10-03T00:00:01.000Z",
    contentHash: hashContent(contentJson),
    eventCount: 1,
    eventHeadHash: hashEvidenceEvent(first),
    hashFormatVersion: 1,
    keyId: "ed25519-sha256:example",
  };
  const bytes = certificateSigningBytes(unsigned);
  assert.deepEqual(bytes, certificateSigningBytes({ ...unsigned, signature: "ignored" }));
  assert.notDeepEqual(bytes, certificateSigningBytes({ ...unsigned, finalVersion: 2 }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  assert.equal(keyIdFromPublicKey(publicKey), keyIdFromPublicKey(publicKey.export({ format: "pem", type: "spki" })));
  assert.match(keyIdFromPublicKey(publicKey), /^ed25519-sha256:[0-9a-f]{64}$/);
  const signature = sign(null, bytes, privateKey);
  assert.equal(verify(null, bytes, publicKey, signature), true);
  assert.equal(verify(null, certificateSigningBytes({ ...unsigned, contentHash: "0".repeat(64) }), publicKey, signature), false);
});
