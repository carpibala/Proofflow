# twff_copy — 文件修改审计日志（逐事件哈希链）

从 TWFF 项目提取**逐事件哈希链**能力，做成一个独立功能：

> 监视 `textfile.txt`，**每次内容发生变化就记一条事件**——改了多少、删了什么、
> 加了什么——所有事件串成 SHA-256 哈希链。事后谁动了日志里的任何一条，
> 验证时都会被发现。

**它不做 AI 检测、不记录"谁"改的、不加密、不联网。**

| | |
|---|---|
| 主程序 | [`chainlog.py`](chainlog.py)，纯标准库，无第三方依赖 |
| 运行环境 | Python 3.11+，Windows（其他平台理论可用，未测） |
| 与 TWFF 的关系 | 记录格式与 `meta/process-log.json` 兼容，TWFF 自带的 `verify_process_log.py` **可直接校验本功能产出的日志**（已实测 PASS）；但**运行时不依赖 TWFF**，只从那里提取了算法 |

> 📌 **TWFF 仓库在本目录之外。** 本构件自包含、可独立运行；
> 只有"跨实现校验"这一步需要 TWFF 的 `spec/verification/verify_process_log.py`。
> 常见的两个副本位置：
> - `..\twff\`（本目录的兄弟目录，即 `encrypt_zac\twff`）
> - `D:\hacku\teamproject\zacc\encrypt_zac\twff\`
>
> 若都不在，重新克隆：
> `git clone https://github.com/Functional-Intelligence-Research-Lab/twff`

> 🆕 **接手这个功能？先读 [`docs/交接总结.md`](docs/交接总结.md)** —— 里面有全部踩坑记录、
> 设计取舍、验证方法和下一步建议。本文件是功能说明与实测数据。

---

## 项目结构

```text
twff_copy/
├── chainlog.py            ★ 核心：init / watch / announce / verify / show
├── test_diff.py             diff 单元测试（29 项）
├── README.md               本文件
├── textfile.txt            被监视的文件（示例）
├── audit.json              审计日志（含哈希链）—— 运行产物，会增长
├── anchor.json             链外锚点（head_hash）—— 运行产物
├── 待办.md                  使用者的需求笔记
├── docs/
│   ├── 交接总结.md          ★ 接手必读：踩坑、取舍、验证、下一步
│   └── 操作流程.md          零变量、可复制粘贴的傻瓜流程
├── examples/
│   ├── tamper_demo.py      篡改检测演示（5 种手法）
│   └── rechain_demo.py     "重算链"演示 + 锚点必要性
└── tests/
    └── 5kb/                5KB 端到端实测：脚本 + 原始输出 + 汇总
```

**只有 `chainlog.py` 是需要维护的源文件。** `audit.json` / `anchor.json` 是运行产物；
`tests/5kb/` 里的 `chainlog.py` 与 `test_diff.py` 副本是为了让测试自包含可复现，
并加了哈希校验防止副本过期（见 [`tests/5kb/README.md`](tests/5kb/README.md)）。

---

## 快速开始

> 终端提示符出现 `(mytest)` 就说明环境已激活，直接用 `python`。
> **不要用 `$PY` 之类的变量**——忘了赋值就会报「&后面的表达式生成无效的对象」。

```powershell
cd D:\hacku\teamproject\Proofflow\encrypt_zac\twff_copy

# 1) 建立基线（记录当前文件状态并起链）
python chainlog.py init --file textfile.txt --log audit.json

# 2) 开始监视（这个窗口会被占住；另开一个窗口改文件；Ctrl+C 优雅收尾）
python chainlog.py watch --file textfile.txt --log audit.json --interval 1.0

# 3) 随便改 textfile.txt，每次修改会实时打印一条事件

# 4) 固化链外锚点（关键！否则"重算整条链"检测不到）
python chainlog.py announce --log audit.json --out anchor.json

# 5) 验证：复算整条链 + 比对正文当前哈希
python chainlog.py verify --log audit.json --file textfile.txt

# 6) 看时间线（含每条事件的增删片段）
python chainlog.py show --log audit.json
```

需要更手把手的版本（含每个窗口该做什么）见 [`docs/操作流程.md`](docs/操作流程.md)。

---

## 命令参考

| 命令 | 作用 | 主要参数 |
|---|---|---|
| `init` | 建基线、起链 | `--file` `--log` `--preview-chars` `--force` |
| `watch` | 监视文件并实时记录 | `--file` `--log` `--interval`（默认 1.0）`--preview-chars`（默认 60）`--announce` `--force` |
| `announce` | 把当前 `head_hash` 固化到日志之外 | `--log` `--out`（默认 anchor.json）`--force` |
| `verify` | 复算整条链，可选比对正文 | `--log` `--file` |
| `show` | 打印时间线（含 diff） | `--log` |

`--preview-chars` 会**进入哈希输入**，`init` 与 `watch` 必须用同一个值；
它同时是日志体积的主导项（见下文「5KB 实测」）。

---

## 事件类型

| type | 触发时机 |
|---|---|
| `chain_init` | 起链 |
| `content_baseline` | 建立基线快照 |
| `watch_start` | 开始监视 |
| `content_modified` | **内容变化**（核心） |
| `content_deleted` | 文件被删除 |
| `content_created` | 文件被（重新）创建 |
| `session_end` | 收到 Ctrl+C / 正常退出 |

判定"变化"用的是**内容哈希**而非修改时间：同样的内容不会重复记账，
内容改回原样也算一次新事件。

`content_modified` 的 `meta` 字段：

```json
{
  "char_count": 131,              // 当前字符数（按 Unicode 码点，中文算 1 个）
  "line_count": 3,                // 当前行数
  "byte_count": 402,              // 字节数（UTF-8 下中文占 3 字节）
  "encoding": "utf-8-sig",        // 自动探测到的编码
  "content_sha256": "3ed49d63…",  // 正文内容哈希
  "preview": "生成式 AI 正在…",     // 当前全文前 N 字符（默认 60）
  "delta_chars": 37,              // 相比上一条的增量
  "delta_lines": 1,
  "mode": "replace",              // add / del / replace
  "removed": ["改变"],             // ← 本轮删掉的片段
  "added": ["重塑"],               // ← 本轮新增的片段
  "diff_truncated": false         // 片段是否因过长被截断
}
```

---

## 本轮改了什么（diff）

只有"当前长什么样"是不够用的——看不出这一轮到底动了哪里。
所以每条 `content_modified` 都记录**本轮删除的片段**和**新增的片段**。

### 实测输出（4.75 KB 文本、6 次编辑，`--preview-chars 300`）

真实运行结果，原样取自 [`tests/5kb/watch-output-preview300.txt`](tests/5kb/watch-output-preview300.txt)：

```
[2026-10-03T09:16:19Z] content_modified  replace  1,644 chars (+1)  7f73e9c62d71…  _hash=b6146fb204c3…
    − 删除  讨论创作过程的可验证记录
    + 新增  主张用过程证据替代事后检测
[2026-10-03T09:16:20Z] content_modified  add  1,653 chars (+9)  938082ed9f0a…  _hash=dc464057fd16…
    + 新增  ，且应当可独立复算
[2026-10-03T09:16:21Z] content_modified  del  1,476 chars (-177)  c9b4456bc594…  _hash=7bb10ce2568c…
    − 删除  5节。生成式人工智能正在改变知识生产的方式，写作、编程与设计领域都出现了人机协作的常态。学校…<中间省略 17 字符>…如在创作发生的当下就记录可验证的过程证据，包括人工输入的时段…
[2026-10-03T09:16:23Z] content_modified  add  1,509 chars (+33)  423f463c95f1…  _hash=64324ce6324e…
    + 新增  5节之二。插入段落：记录必须与正文绑定的哈希，否则可被替换。\r\n第
[2026-10-03T09:16:24Z] content_modified  add  1,513 chars (+4)  851034a152cb…  _hash=fc0940b91770…
    + 新增  （修订）
[2026-10-03T09:16:25Z] content_modified  replace  942 chars (-571)  3449d5f55bcf…  _hash=3d60eb4b8005…
    − 删除  《可验证的创作过程》\r\n摘要：…<中间省略 1353 字符>…入的时段、外部内容的引入…
    + 新增  整篇重写后的新正文。\r\n这是用于测试超长片段截断的填充文字…(已截断)
```

对照这 6 步可以看清行为：

| 操作 | mode | 记录内容 |
|---|---|---|
| 改开头摘要一句 | `replace` | 删除旧句、新增新句 |
| 给结尾补一段话 | `add` | 只记 `，且应当可独立复算`，零删除 |
| 删掉中间一整段 | `del` | 记整段（超长则首尾保留） |
| 中间插入一段 | `add` | 只记插入的段落 |
| **文档深部改一个词** | `add` | 只记 `（修订）` —— 改动再深也能精确定位 |
| 整篇重写 | `replace` | 两侧都截断，`diff_truncated=true` |

`mode` 由 diff 与增量共同推出：只增 → `add`，只减 → `del`，有增有减 → `replace`。

### 算法与取舍

用**最长公共前缀 / 最长公共后缀**夹逼出中间的改动区（见 `diff_fragments()`）：

- 优点：O(n)、无需依赖库、对"编辑文档"足够准。
- 缺点：改动区内部的公共子串会被同时算进 removed 和 added（**宁可多报，不漏报**）。
- 片段上限 `FRAGMENT_CHARS`（默认 160）超出时改为**首尾保留、中间省略**：

```
− 删除  全新正文。这是一段用于测试…反复出现。这…<中间省略 144 字符>…反复出现。
```

  **只截尾部是不行的**——那会让读者看不到改动落在哪个位置，所以必须两头都留。

> ⚠️ **已知边界**：夹逼法会把改动点两侧的公共字符并入公共前缀/后缀。
> 上表第 3 行删的是「第5节。…」，但公共后缀吃掉了开头的「第」，
> 所以显示为「5节。…」。**片段内容正确，但不保证落在行/句边界。**
> 需要行级对齐得换 `difflib.SequenceMatcher` 之类（最坏 O(n²)）。

**隐私取舍**：只持久化改动片段（每条上限约 160 字符 × 2），不存全文快照；
但为了算 diff，`watch` 会把当前文本（上限 1,000,000 字符）留在内存里。
若文件超过该上限，`diff_truncated` 置真且不猜内容。

> 实现期踩过的坑：`diff_fragments()` 返回 `(removed, added, truncated)`，
> 而接收端一度按 `added, removed` 解包，导致**每个事件的删除/新增完全颠倒**。
> 现已把返回顺序写进 docstring，并有确定性单元测试覆盖（[`test_diff.py`](test_diff.py)）。

---

## 实时性与中文支持

这两点是刻意实现的，不是碰巧能跑。

**① 实时逐行输出。** `watch` 每记录一条事件就 `flush()` 一次，启动时还调用
`stream.reconfigure(line_buffering=True, encoding="utf-8")`。原因：stdout 一旦不是终端
（被重定向到文件、被管道或 IDE 捕获）就会用 4–8 KB 块缓冲，事件少时会一直攒着、
**进程退出才刷出来**——表现就是"只有结束终端后才写入记录"。加行缓冲后，
即使输出被管道捕获，事件也是产生即出现。

实测方式：把 `watch` 的 stdout 重定向到文件，在进程**仍在运行**时读该文件
（5KB 实测平均延迟 0.24 s，见下文）。

**② 中文/非 ASCII 完整记录。** 预览与 diff 片段保留所有可打印字符
（中文、标点、emoji），只把 `\n \r \t` 换成 ASCII 转义。哈希稳定性由
`compute_event_hash()` 的 `ensure_ascii=True` 保证——它先把中文转义成 `\uXXXX`
再算哈希，所以**预览里有没有中文都不影响链的稳定**。

> 这里踩过一个坑：早期版本为了"让哈希输入只含 ASCII"，把预览里所有
> `ord(ch) >= 128` 的字符一律替换成 `?`，结果**中文全被吃掉**。
> 其实完全没必要——`ensure_ascii=True` 已经解决了转义歧义。
> **不要用削掉内容的方式去换哈希稳定。**

**③ 自动探测文件编码。** 依次尝试 `utf-8-sig` → `utf-8` → `gbk`，
因为中文 Windows 记事本默认保存的是 GBK（"ANSI"）：

```
字节数     : 41
检测编码   : gbk
解码结果   : 这是 GBK 编码的中文文件，包含标点：、。！
字符数     : 23
```

**④ 字符数按 Unicode 码点计。** 中文 1 个字算 1 个字符（不是 3 字节），
所以 `char_count` 就是"字数"直觉；字节数另存 `byte_count` 供对照。

---

## 5KB 实测（可复现）

`tests/5kb/` 下保留了完整脚本与原始输出：

```powershell
cd tests\5kb
python run_5kb_test.py 300      # 也可传 60 / 0 做体积对照
python inspect_result.py        # → summary.txt（逐条 diff + 体积拆解）
python compare_preview.py       # → comparison.txt（三档 preview 对照）
```

**测试条件**：4.75 KB 中文文档（4863 字节 / 1631 字符 / 12 行），
依次做 6 次编辑（改开头 / 改结尾 / 删中间整段 / 中间插段 / 深部改一个词 / 整篇重写），
`--interval 0.4`。详细说明见 [`tests/5kb/README.md`](tests/5kb/README.md)。

### 捕获延迟

| 指标 | 实测 |
|---|---|
| 平均「文件写入 → 事件落盘」延迟 | **0.24 s** |
| 最大延迟 | 0.41 s |
| 实时性证据 | watch 进程仍在运行时，其输出文件里已含全部 6 条 `content_modified` |

延迟量级与轮询间隔一致（0.4 s），说明开销已经由轮询周期主导，而非处理逻辑。

### 日志体积

| `--preview-chars` | audit.json | 每条 `content_modified` | preview 占用 | diff 占用 |
|---|---|---|---|---|
| 300 | 12.93 KB | ~2040 B | 6294 B | 1758 B |
| **60（默认）** | **8.02 KB** | ~1202 B | 1266 B | 1758 B |
| 0 | 6.80 KB | ~994 B | 18 B | 1758 B |

三点结论：

1. **preview 是体积主因**（`preview=300` 时占 71.7%）。把它设为 0，日志从 12.93 KB
   降到 6.80 KB（约 **−47%**）。
2. **diff 完全不随 preview 变化**——三档下 `removed`/`added` 的字段摘要都是
   `19be4cc05c5f57c6`。所以"只关心改了什么"的场景可以把 `--preview-chars 0` 省体积。
3. 只记增量的话，一次编辑约 **1 KB**；12 行文档改 6 次约 7–13 KB。
   长文档的日志体积主要由**编辑次数**决定，而不是文档长度。

---

## 篡改检测能力矩阵

| 篡改手法 | 链内校验 | 说明 |
|---|---|---|
| 改一条事件的字段 | ❌ 抓到 | `event[3] 哈希不匹配` |
| 删除一条事件 | ❌ 抓到 | 后续全部失配 |
| 调换两条事件顺序 | ❌ 抓到 | 顺序是哈希输入的一部分 |
| 末尾追加伪造事件 | ❌ 抓到 | 追加项的 `_hash` 对不上 |
| **改完重算整条链** | ✅ 通过 ⚠️ | **必须靠链外锚点 `anchor.json` 发现** |

前 4 种见 [`examples/tamper_demo.py`](examples/tamper_demo.py)，第 5 种见 [`examples/rechain_demo.py`](examples/rechain_demo.py)：

```
场景 B  改完把整条链重算一遍
  链内校验      : PASS
  twff 自带校验 : PASS  (Log intact — N events verified.)
  与链外锚点比对: ❌ 不一致 → 发现篡改
```

**结论：链内校验只证明"日志自洽"，不证明"日志没被重写过"。**
要让结论站得住，必须把 `head_hash` 固化到日志之外——`anchor.json`、校方数据库、
可信时间戳，或 TWFF SPEC §5.6 的数字签名。这也是 ProofFlow 里
"Digital Signature 有时间再做"那一层的真实必要性：**它不是锦上添花，
而是链能成立的前提。**

---

## 并发保护（锁文件）

`watch` 运行时会写一个 `audit.json.lock`（记录 pid），并在循环里每 30 秒
刷新它的时间戳作为**心跳**。基于它的保护：

| 操作 | 行为 |
|---|---|
| 第二个 `watch` 用同一个日志 | 直接拒绝并退出（exit 1） |
| `announce` 在 watch 运行时 | 直接拒绝（`--force` 可强制） |
| `init --force` 覆盖正在写的日志 | 打印警告（不阻止，但你会知道原因） |
| 崩溃后的残留锁 | 心跳停止，超过 90 秒判定为陈旧，自动失效 |
| 误判时 | `watch --force` / `announce --force` 可强行执行 |

**为什么需要它**：调试时踩过一次真事——在 watch 运行期间执行 `init --force`，
把正在记录的日志覆盖了。当时数据没丢，**纯粹是因为那个 watch 还在内存里持有
旧内容、下一次写回又把覆盖冲掉了**。如果它当时是崩溃退出，日志就永久没了；
而且"覆盖没生效"这种表现极难排查。

**实现上的一个坑（已实测）**：判断 pid 是否存活用的是 `os.kill(pid, 0)`，
但在受限/沙箱环境里，对**存活的外部进程**它也会抛 `OSError WinError 87`
（ERROR_INVALID_PARAMETER），而不是成功。所以 **WinError 87 不等于"进程不存在"**，
只能算"探测不了"。`pid_alive()` 因此返回三态 `True / False / None`，
只有明确的 `ProcessLookupError` 才判定为已死；其余情况一律回落到心跳新鲜度判断——
**宁可拦住一次操作，也不要静默覆盖别人的数据。**

---

## 从 twff 提取了什么

**直接提取**（TWFF 的 `spec/verification/verify_process_log.py` 与 `validate_examples.py`）：

- `compute_event_hash()`：`json.dumps(payload, separators=(",",":"), sort_keys=True)`
  \+ `"|" + previous_hash + "|" + session_id`，再取 SHA-256。以 `session_id` 为链根。
- `_integrity` 块结构与 `head_hash` 语义。

**改进的地方**：

1. **与 spec 对齐了 `ensure_ascii`**。twff 参考实现在 `json.dumps` 上用默认的
   `ensure_ascii=True`（非 ASCII 转义成 `\uXXXX`），而记录文件本身以 UTF-8 明文存中文。
   我最初的实现用了 `ensure_ascii=False`，结果**同一条事件算出两个不同的哈希**，
   仓库自带校验器直接 FAIL。现已对齐为默认值，并在 `compute_event_hash()`
   的注释里写明原因。
   > 反过来看，这算 twff 的一个隐患：任何在哈希输入里出现非 ASCII 的字段
   > （例如中文预览、中文文档名）都会踩到它。
2. **补上了 v0.1 的假阳性漏洞**。twff 自带校验器写的是
   `if stored_hash and stored_hash != expected: ...`，事件缺 `_hash` 时**静默跳过比对**，
   于是不带链的旧日志也会报 "intact"。本功能的 `verify_chain()`
   把"缺 `_hash`"直接判为失败。
3. **加了链外锚点**（`announce` 子命令），补上重算链的检测能力。

---

## 文件说明

| 文件 | 说明 |
|---|---|
| [`chainlog.py`](chainlog.py) | **主程序**：init / watch / announce / verify / show |
| [`test_diff.py`](test_diff.py) | diff 行为的确定性测试（29 项：方向 / 边界 / 截断） |
| [`examples/tamper_demo.py`](examples/tamper_demo.py) | 篡改检测演示（5 种手法） |
| [`examples/rechain_demo.py`](examples/rechain_demo.py) | "篡改后重算链"演示 + 为什么必须有链外锚点 |
| [`tests/5kb/`](tests/5kb/README.md) | 5KB 实测：脚本、原始输出、结果汇总 |
| [`docs/交接总结.md`](docs/交接总结.md) | **交接文档**：踩坑记录、设计取舍、验证方法、下一步 |
| [`docs/操作流程.md`](docs/操作流程.md) | 零变量、可复制粘贴的傻瓜操作流程 |
| `textfile.txt` | 被监视的目标文件（示例） |
| `audit.json` | 生成的审计日志（含哈希链） |
| `anchor.json` | **链外锚点**：固化的 `head_hash` |
| [`待办.md`](待办.md) | 你（使用者）的需求笔记 |

> `examples/` 下的脚本读取的是**项目根目录**的 `audit.json` / `anchor.json`，
> 所以在根目录执行：`python examples/tamper_demo.py`。

---

## 安全边界（不要过度声称）

- 轮询式监视（默认 1 s）：**同一间隔内的多次修改会合并成一条**，且不记录"谁"改的。
- **不加密**：`audit.json` 是明文 JSON。
- 不防内存篡改：攻击者若能同时改 `audit.json` 和 `anchor.json`，则无从发现。
  真要做到这一点必须用数字签名或把锚点存到受控服务端。
- 文件被删除前若进程未运行，那段期间没有任何记录。
- 内容哈希相同即视为"未变化"，因此"改成别的内容再改回来"会记两条事件。
- **大文件未验证**：只在 4.75 KB 上做过完整实测；几百 KB / MB 级的行为未测。
