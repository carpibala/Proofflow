# TWFF 记录查看 / 哈希链 / 分级披露 —— 可运行示例

本目录是**演示与教学用**，不改动 `../twff/` 仓库任何文件（`--fix` 在原仓库里是原地覆盖，
所以这里的实验都跑在副本上）。

## 文件

| 文件 | 说明 |
|---|---|
| `build_demo_logs.py` | 用仓库自带的哈希链函数生成下面 5 份日志 |
| `view_logs.py` | 查看日志/容器 + 复算哈希链（核心工具） |
| `build_container.py` | 打包真实 `.twff` 容器，演示分级披露 |
| `01-v0.1-original.json` | v0.1 原始记录：**无 `_hash`**，只有整体 hash |
| `02-v0.2-chained.json` | 加上逐事件哈希链（8 事件） |
| `03-tampered-field.json` | 篡改第 3 条事件的字段，链未重算 → **应报错** |
| `04-tampered-order.json` | 调换第 4、5 条事件顺序 → **应报错** |
| `05-tampered-rechained.json` | 篡改后重算整条链 → 记录自洽，但 head_hash 变了 |
| `full.twff` | 完整容器：正文 + 记录 + 清单 |
| `audit.twff` | 审计层容器：+ AI 会话原文 + 签名占位 |
| `research-only.process-log.json` | 研究层：只交 JSON，不交正文 |
| `swap.twff` | 攻击演示：**换掉正文，记录原封不动** |

## 运行

```powershell
# PowerShell，用仓库根目录作为工作目录
$PY = "D:\DPH\resources\runtime\primary-runtime\dependencies\python\python.exe"

# 1) 生成示例日志
& $PY demo\build_demo_logs.py

# 2) 查看 + 校验（可传多个文件）
& $PY demo\view_logs.py demo\01-v0.1-original.json demo\02-v0.2-chained.json demo\03-tampered-field.json

# 3) 直接看容器（自动识别 ZIP）
& $PY demo\view_logs.py demo\full.twff

# 4) 重建容器
& $PY demo\build_container.py
```

> 用仓库自带的 `spec/validate_examples.py` 也可以，但有两个坑：
> ① 它需要 `pip install jsonschema`；② 它用裸 `open()` 读写，
> 在中文 Windows 上会因默认 GBK 解码抛 `UnicodeDecodeError`（和 `glassbox/app.py:41` 同一个病）。
> 加 `-X utf8` 可绕过。

## 预期结果

| 文件 | 哈希链校验 |
|---|---|
| `01-v0.1-original.json` | ✅ INTACT（**假象**：无 `_hash` 时校验器会跳过逐条比对，等同没检查） |
| `02-v0.2-chained.json` | ✅ INTACT — 8 events verified |
| `03-tampered-field.json` | ❌ BROKEN — `Hash mismatch at event 3` |
| `04-tampered-order.json` | ❌ BROKEN — `Hash mismatch at event 4` |
| `05-tampered-rechained.json` | ✅ INTACT（**链自洽**，但 head_hash 与原始值不同） |

## 关键结论

1. **链的形状**：篡改第 3 条，第 0–2 条仍然有效，从第 3 条起及其后全部失效，
   `head_hash` 随之改变。所以只要记住原始 `head_hash`，任何中间改动都能定位到首次被改的位置。
2. **重算链攻击**：`05` 说明"有链"本身不等于可信 —— 必须把 `head_hash` 锚定到记录之外
   （签名 / 可信时间戳 / 校方数据库），这正是 SPEC §5.6 Digital Signatures 要解决的问题。
3. **记录不保护正文**：`swap.twff` 换了整篇正文，容器内 `process-log.json` 的哈希链仍报 ✅。
   记录里没有任何字段指向正文的哈希 ⇒ **"改一个字就验证失败"用 TWFF 原生机制做不到**，
   必须自己补 `document_hash`。
