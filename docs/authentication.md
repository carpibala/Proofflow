# 用户登录系统

本版本支持用户名＋密码注册、登录、退出登录。注册成功后自动登录，会话有效期 7 天。用户名为 3–32 位英文字母、数字或下划线，不区分大小写；密码为 8–128 个字符，区分大小写。暂不提供邮箱验证、密码找回或修改密码。

## Windows 本机运行

安装 Node.js 24 或更新版本，解压项目后，在项目根目录打开 PowerShell：

```powershell
cd frontend
npm ci
npm run dev -- -p 3001 -H 127.0.0.1
```

浏览器打开 http://127.0.0.1:3001/，先注册，再使用编辑器。按 Ctrl+C 停止；重新执行最后一条命令即可启动。重启不会删除账号或已保存文档。

## 后端数据

默认路径：`frontend/data/proofflow.sqlite`。用户表保存独立随机盐和 scrypt 密码哈希，不保存明文密码。会话表只保存随机会话令牌的 SHA-256 摘要，浏览器通过 HttpOnly、SameSite=Lax Cookie 携带令牌。退出会删除服务器会话；登录成功会替换当前浏览器旧会话。

文档表新增 `owner_id`。创建、查询、保存事件、验证、冻结、下载证据包均要求登录；操作别人或无主文档返回 404。旧证据格式和事件哈希保持兼容，owner_id 是访问控制信息，不是作者签名。

换浏览器登录时，如果没有该账号的本地草稿，会加载后端最近更新的一份文档及历史。浏览器草稿只作为未保存工作的缓存，按用户 ID 隔离。退出不删除该账号的本地草稿；共用电脑的人仍可能通过浏览器开发工具读取本地存储。不要在共享的浏览器配置中记录敏感内容。

所有已有文档可通过登录后的 `GET /api/documents` 查询；当前编辑器延续原版单文档界面，不新增文档管理面板或多人实时协同。

## 旧数据迁移

升级前备份整个 `frontend/data` 目录（先停止旧服务，或使用 SQLite 在线备份）。覆盖源码时保留自己的 data 目录。

旧版本没有用户信息，无法可靠推断文档属于谁。升级只增加字段，保留旧文档，默认不把它们分给任何账号。旧版 localStorage 的未提交草稿不会自动认领：升级前先在旧版等待保存完成或导出草稿。

先运行新版并注册目标账号，再停止服务。在 `frontend` 目录执行：

```powershell
# 仅把明确指定的无主文档分配给 zack
node scripts/assign-legacy-documents.mjs zack 文档UUID

# 仅在确认全部旧文档都是自己的情况下使用
node scripts/assign-legacy-documents.mjs zack --all
```

迁移只更新 owner_id 为空的文档，不会覆盖已有归属，不改正文、事件或哈希。重启后，在无该账号本地草稿的浏览器登录即可恢复最近文档。

## 配置

- `PROOFFLOW_DATA_DIR`：可选，SQLite 所在目录；迁移和测试时须与服务保持一致。
- `PROOFFLOW_ORIGIN`：可选，浏览器实际访问来源，例如 `https://proof.example.com`，不带尾部斜杠。反向代理部署须配置准确。
- `PROOFFLOW_COOKIE_SECURE`：生产模式默认开启；开发模式默认关闭。公网 HTTPS 部署设为 `true`。仅在本机 HTTP 测试 `npm start` 时可设为 `false`。

认证接口仅接受 JSON 写请求，并验证浏览器 Origin / Sec-Fetch-Site。认证尝试按用户名及全局窗口做 SQLite 持久限流；这适用于小规模演示，公网服务还需部署层限流与 HTTPS。全局超过 200 次/15 分钟会暂时阻止认证，单用户名超过 10 次/15 分钟也会阻止；密码正确的登录会清除该用户名失败计数。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /api/auth/register | `{ "username": "zack", "password": "你的密码" }`；注册并建立会话 |
| POST | /api/auth/login | 同上；登录 |
| GET | /api/auth/me | 返回当前 user，未登录为 null |
| POST | /api/auth/logout | JSON `{}`；退出并撤销当前会话 |
| GET | /api/documents | 返回本人文档，按更新时间倒序 |

## 验证

服务启动后，在另一个终端执行：

```powershell
cd frontend
$env:PROOFFLOW_TEST_URL = "http://127.0.0.1:3001"
npm test
npm run lint
npm run build
npm run test:auth
npm run test:integration
npm run test:ui
```

测试会创建测试用户和文档，建议通过 `PROOFFLOW_DATA_DIR` 指定独立测试目录，服务与测试终端使用同一配置。UI 测试需要安装 Edge / Chrome 或 Playwright Chromium，可通过 `PROOFFLOW_BROWSER_PATH` 指定浏览器程序。

## 此次交付验证记录

- `npm test`：17 项通过。
- `npm run lint`：通过。
- `npm run build`：通过，含 TypeScript 检查。
- `npm run test:auth`：通过，覆盖注册、错误密码、重复用户名、令牌轮换、账号隔离、过期、退出、跨源拒绝、密码/会话摘要存储和限流。
- `npm run test:integration`：4 项通过，含保存、并发版本、冻结及导出回归。
- 已更新 UI 测试以适配登录，并新增跨浏览器登录恢复测试；当前环境浏览器下载失败，未执行 UI 自动化。

## 报告账户水印

报告页在内容顶部显示大号用户名水印，并在报告区域叠加浅色斜向用户名水印；打印时保留。用户名取自当前认证会话，报告接口限制为文档所有者访问。水印不改变 JSON 证据格式，不构成数字签名。
