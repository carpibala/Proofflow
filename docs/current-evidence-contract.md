# ProofFlow 当前证据契约

更新于 2026-10-04。团队范围是结构化编辑记录、哈希链、证据报告、最终版本冻结和无签名 JSON 证据包；不做 AI 助手、数字签名、证书或公钥体系。旧的 `backend-contract.md` 和 `implementation-roadmap.md` 留作历史设计记录，以本文和实际接口为准。

## 文档与事件

- 正文使用 ProofFlow JSON：`{ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "..." }] }] }`。`editorSchemaVersion: 1` 位于请求顶层。
- `POST /api/documents` 创建 UUID 文档，版本从 0 开始；`GET /api/documents/:id` 返回标题、正文、版本、状态和冻结时间。
- `POST /api/documents/:id/events` 只接受新 `MANUAL_EDIT` 和 `PASTE`。请求包含 URL 与正文一致的 `documentId`、`baseVersion`、`event.operationId` 和操作后的完整 `contentJson`。相同操作 ID 与请求可以幂等重试；版本过旧返回 `409`。
- `PASTE` 必须带完整 `insertedText`、`insertPosition: { path, offset }`，可带 `replacedLength`。位置针对操作前的段落，偏移为 UTF-16 代码单元。服务器重放粘贴并核对结果。新 `AI_INSERT` 被拒绝，历史行仍可读取。
- 编辑器按 FIFO 保存；进入报告前结束当前输入并等待全部待保存事件成功。

## 哈希与校验

新事件的 `hashFormatVersion` 为 1。规范化 JSON 递归按 JavaScript UTF-16 键序排列对象，数组保持原序，哈希是 UTF-8 SHA-256 小写十六进制。

```text
contentHash = SHA256_UTF8("ProofFlow content v1\n" + canonical(contentJson))
eventHash   = SHA256_UTF8("ProofFlow event v1\n" + canonical({
  previousHash, documentId, version, eventId, event, receivedAt,
  contentJson: contentAfter
}))
```

首事件 `previousHash` 为 64 个零，后续指向前一事件哈希。事件的完整规范化负载存于 `event_payload_json`。`GET /api/documents/:id/verify` 复算版本、事件内容、展示属性、链与最终正文；已冻结文档还核对冻结摘要。`verifyEvidencePackage()` 可不接数据库直接校验下载文件。缺少完整负载的旧 v0 行无法作为 v1 证据冻结。

## 冻结与证据包

`POST /api/documents/:id/finalize` 请求 `{ "expectedVersion": 4, "title": "最终标题" }`。标题可省略，传入时为 1–200 字非空字符串。服务器在同一 SQLite 事务中确认版本、复核证据链，保存最终标题、时间、正文哈希、事件数与链头哈希，并改状态为 `finalized`。重复请求返回同一摘要；冻结后新保存请求返回 `409 DOCUMENT_FINALIZED`。空白的版本 0 文档也可以冻结。

`GET /api/documents/:id/bundle` 仅在冻结且复核通过后返回 JSON 附件。结构为：

```json
{
  "formatVersion": 1,
  "kind": "proof-flow-evidence",
  "manifest": {
    "documentId": "UUID",
    "title": "最终标题",
    "finalVersion": 4,
    "finalizedAt": "2026-10-04T00:00:00.000Z",
    "contentHash": "64 lowercase hex characters",
    "eventCount": 4,
    "eventHeadHash": "64 lowercase hex characters",
    "hashFormatVersion": 1
  },
  "contentJson": { "type": "doc", "content": [{ "type": "paragraph", "content": [] }] },
  "events": []
}
```

以上仅说明字段；实际 `events` 包含版本 1 至最终版本的所有事件，且每条有 `eventId`、`documentId`、`version`、`event`、`receivedAt`、`contentAfter`、`previousHash` 和 `eventHash`。用 `cd frontend; npm run verify:bundle -- <下载文件路径>` 可以离线复算内部哈希。

**边界：**包没有签名、公钥、外部可信时间戳或不可改写的外部锚点；自检通过只说明包内部一致，不证明生成者身份。拥有数据库或 JSON 文件写权限的人可重制一套自洽的证据。当前服务还没有登录、所有权和速率限制，只能绑定 `127.0.0.1` 做本机演示，不应录入敏感资料或公开部署。独立的 `twff_copy` Python 文件监听器不是网页事件链的运行时依赖。
