# 5KB 端到端实测

针对「文档长到 5KB 时，记录是否还准确、实时、体积可控」做的一轮完整测试。
**本目录里的输出文件都是真实运行结果，不是手写示例。**

## 测试条件

| 项目 | 值 |
|---|---|
| 被监视文件 | `textfile.txt`，4863 字节 / 1631 字符 / 12 行（4.75 KB，中文） |
| 编辑器 | `chainlog.py`（本目录一份副本，与上级目录同源） |
| 轮询间隔 | `--interval 0.4` |
| 预览宽度 | `--preview-chars 300`（另有 60 / 0 两档对照） |

依次做 6 次编辑，覆盖不同位置与类型：

1. 改开头摘要一句
2. 改结尾结论一句
3. 删除中间一整段（第 5 节）
4. 中间插入一段
5. 文档深部改一个词（第 8 节 → 第 8 节（修订））
6. 整篇重写（触发片段截断）

## 复现方式

```powershell
cd D:\hacku\teamproject\Proofflow\encrypt_zac\twff_copy\tests\5kb

python run_5kb_test.py 300     # 跑测试，参数是 preview-chars
python inspect_result.py       # 生成 summary.txt（逐条 diff + 体积拆解）
python compare_preview.py      # 生成 comparison.txt（三档对照）
```

跑 60 / 0 两档对照：

```powershell
python run_5kb_test.py 60
python run_5kb_test.py 0
python compare_preview.py
```

> `run_5kb_test.py` 启动前会清掉 `audit.json.lock`。**这一步不能省**：
> 上一次测试若被强杀，会留下心跳已停的锁，它在 90 秒内仍会被判为"有人在用"，
> 导致新 watch 被自己的守卫拒绝（我第一轮就是这么失败的）。

## 结果文件

| 文件 | 内容 |
|---|---|
| `result-preview{300,60,0}.txt` | 每次运行的完整控制台输出（延迟表 + verify 结果） |
| `watch-output-preview{300,60,0}.txt` | watch 子进程的原始输出（实时性证据） |
| `audit-preview{300,60,0}.json` | 三档对应的审计日志快照 |
| `summary.txt` | 逐条 diff 详情 + 体积拆解（`inspect_result.py` 生成） |
| `comparison.txt` | 三档 preview 的体积对照（`compare_preview.py` 生成） |
| `test_diff.py` | diff 单元测试副本（同一个文件也放在上级目录） |
| `chainlog.py` | 被测程序副本，使本目录自包含、可离线复现 |
| `anchor.json` | 链外锚点（最后一次运行的） |
| `audit.json` / `textfile.txt` | 最后一次运行（preview=0）的日志与文档最终状态 |

三档快照都已各自验证通过：

```
preview=300 : ✅ 完整  9 条事件，链未被篡改
preview=60  : ✅ 完整  9 条事件，链未被篡改
preview=0   : ✅ 完整  9 条事件，链未被篡改
```

## 实测结论（摘要）

**准确性**：6 次编辑全部被正确识别，`mode` 归类正确（改字 `replace`、
追加 `add`、删段 `del`、深部小改 `add`）。深部改一个词时只记录了 `（修订）`，
说明 diff 能精确定位到文档深处。

**实时性**：平均「文件写入 → 事件落盘」延迟 **0.24 s**，最大 0.41 s。
关键证据是 `watch-output-300.txt` 在 **watch 进程仍在运行时**
就已包含全部 6 条 `content_modified` —— 这排除了"退出时才批量刷盘"。

**体积**：

| preview-chars | audit.json | 每条事件 | preview | diff |
|---|---|---|---|---|
| 300 | 12.93 KB | ~2040 B | 6294 B | 1758 B |
| 60 | 8.02 KB | ~1202 B | 1266 B | 1758 B |
| 0 | 6.80 KB | ~994 B | 18 B | 1758 B |

diff 字段三档摘要一致（`19be4cc05c5f57c6`），证明**调 preview 不影响 diff**。

**完整性**：三档 `verify` 全部通过，`✅ 完整 9 条事件，链未被篡改`。

## 已知边界（实测暴露）

夹逼法用「最长公共前缀 / 最长公共后缀」定位改动区，会把改动点两侧的
公共字符并入公共前缀/后缀。删「第5节。…」时公共后缀吃掉了开头的「第」，
所以 `removed` 显示为「5节。…」。

**片段内容正确，但不保证落在行/句边界。** 需要行级对齐的话得换
`difflib.SequenceMatcher` 之类的方案（代价是 O(n²) 最坏复杂度）。
