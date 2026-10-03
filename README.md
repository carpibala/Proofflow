# ProofFlow

ProofFlow 是一个本地演示项目：在 JSON 编辑器中记录文档编辑与粘贴，并将事件与正文版本保存到 SQLite。它展示的是可复核的操作记录，不是对“人类原创”的证明。

## 当前功能

- 编辑器以 `doc > paragraph > text` JSON 保存正文；当前页面产生 `MANUAL_EDIT` 和 `PASTE`，服务器校验版本、操作 ID 和插入内容。后端仍能读取既有的 `AI_INSERT` 事件。
- 页面支持中文和英文切换，选择会保存在当前浏览器；加粗和 AI 助手的前端操作入口已移除。
- “时间线”展示浏览器操作；“记录”读取服务器已保存事件，可检索、筛选、查看修改属性，并统计更改及粘贴次数。粘贴次数不等于用户按 Ctrl+C 的次数。
- 事件通过 SHA-256 哈希相连。`GET /api/documents/:documentId/verify` 检查数据库中的事件链、展示字段和最终正文；`verifyEvidenceChain()` 也能脱离数据库调用，并可对比从可信渠道取得的链头。
- “查看证据报告”会等待待保存操作完成，展示增加、删除、粘贴统计和逐条记录；哈希链校验失败时显示红色警报。报告可将最终版本冻结，再下载包含最终正文、完整事件链和冻结摘要的 JSON 证据包。

## 本机运行

需要 Node.js 24 或更新版本。在仓库根目录执行：

```bash
cd frontend
npm ci
npm run dev -- -p 3001 -H 127.0.0.1
```

打开 <http://127.0.0.1:3001/>。如需换端口，浏览器地址也要一起换；不同端口或不同工作区的浏览器草稿和 SQLite 数据库不会自动同步。服务器数据位于 `frontend/data/proofflow.sqlite`，该目录不提交到 Git。不要清除浏览器网站数据来处理保存失败，以免丢失待提交草稿。

## 验证与文档

在 `frontend/` 目录运行 `npm test`、`npm run lint`、`npm run build`；启动服务后再运行 `npm run test:integration` 和 `npm run test:ui`。测试连接非默认地址时设置 `PROOFFLOW_TEST_URL`。详见 [前端运行说明](docs/前端运行说明.md) 和 [前端 README](frontend/README.md)。

- [当前证据契约](docs/current-evidence-contract.md)：JSON、事件、哈希、冻结与无签名证据包。
- [历史路线图](docs/implementation-roadmap.md)：早期设想，已非当前范围。
- [文件监听工具](encrypt_zac/twff_copy/README.md)：独立的 Python `twff_copy` 实验，不是网页事件链的运行时依赖，哈希格式也不同。

## 当前边界

页面不提供 AI 助手或实时大模型调用。团队决定不做数字签名、证书或公钥体系。冻结是应用层只读，不是数据库管理员无法改写的封存；离线校验只能说明这份无签名证据包内部一致，不能证明是谁生成的，也不能防止有权限的人重写整条链。服务没有登录或权限控制，请只在本机演示，不要公开部署或录入敏感资料。
