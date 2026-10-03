#!/usr/bin/env python3
"""
chainlog.py — 文件修改审计日志（逐事件哈希链）

用途：监视 textfile.txt，每次内容发生变化就记录一条事件，所有事件串成
SHA-256 哈希链。任何人事后修改、删除、调换日志里的任何一条事件，都会
在验证时被发现（除非整条链重算 —— 那时 head_hash 会变，见 README）。

记录格式与 TWFF 的 meta/process-log.json 兼容（version / session_id /
user_id / start_time / end_time / content_source / events / _integrity），
因此仓库自带的 spec/verification/verify_process_log.py 也能直接校验本文件。

子命令:
    init     创建空日志
    watch    监视 textfile.txt，内容一变就记一条
    verify   复算哈希链，报告是否被篡改
    show     打印时间线

用法:
    python chainlog.py init   --log audit.json --file textfile.txt
    python chainlog.py watch  --log audit.json --file textfile.txt --interval 1.0
    python chainlog.py verify --log audit.json --file textfile.txt
    python chainlog.py show   --log audit.json
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import pathlib
import signal
import sys
import time
import uuid

SPEC_VERSION = "0.2.0"
ALGORITHM = "SHA-256-CHAIN"
PREVIEW_CHARS = 120                 # 预览长度（展示用；同时进入哈希）
FRAGMENT_CHARS = 160                # 单个 diff 片段的最大存储长度
MAX_TEXT_CHARS = 1_000_000          # 内存内算 diff 的文本上限
MAX_READ_BYTES = 8 * 1024 * 1024    # 超过则只记哈希与计数

# ── 哈希链核心（这就是从 twff 提取的部分）────────────────────────────────


def compute_event_hash(event: dict, previous_hash: str, session_id: str) -> str:
    """
    计算单条事件的 _hash。SPEC §5.2 同款算法。

    payload 是事件本身（剔除 _hash），用 sort_keys + 紧凑分隔符做稳定序列化，
    再拼接前一条的哈希与 session_id 作为链根，最后取 SHA-256。

    注意：这里**刻意不传 ensure_ascii=False**（即保持默认 True）。哈希输入必须
    保证 ASCII 稳定性 —— 否则同一条逻辑事件会因为 json.dumps 对非 ASCII 字符的
    转义差异而算出不同哈希，导致不同实现之间无法互验。SPEC §5.2 的参考实现同样
    使用默认值，这里与它保持一致。
    """
    payload = {k: v for k, v in event.items() if k != "_hash"}
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    hash_input = payload_json + "|" + previous_hash + "|" + session_id
    return hashlib.sha256(hash_input.encode("utf-8")).hexdigest()


def append_event(log: dict, event_type: str, meta: dict) -> dict:
    """向日志追加一条事件并接上哈希链，返回该事件。"""
    session_id = log["session_id"]
    previous = log["_integrity"]["head_hash"] if log.get("_integrity") else ""
    if previous is None:
        previous = ""

    event = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="seconds").replace("+00:00", "Z"),
        "type": event_type,
        "meta": meta,
    }
    event["_hash"] = compute_event_hash(event, previous, session_id)
    log["events"].append(event)

    log["_integrity"] = {
        "algorithm": ALGORITHM,
        "chain_length": len(log["events"]),
        "head_hash": event["_hash"],
        "session_id": session_id,
        "note": "Per-event chained hash. Verify using spec §5.2.",
    }
    return event


def verify_chain(log: dict) -> tuple[bool, list[str], str]:
    """
    复算整条链。返回 (是否完好, 报告行列表, 首个出错位置的描述)。

    比 twff 自带的 verify_process_log() 多做一件事：缺 _hash 的事件会被判为
    "未加固"并直接失败，而不是被静默跳过（自带实现里 `if stored_hash and ...`
    会在无 _hash 时跳过比对，导致 v0.1 记录假阳性通过）。
    """
    session_id = log.get("session_id", "")
    events = log.get("events", [])
    report: list[str] = []
    previous = ""
    ok = True
    first_break = ""

    for i, event in enumerate(events):
        stored = event.get("_hash", "")
        if not stored:
            ok = False
            line = f"event[{i}] ({event.get('type')!r}) 缺少 _hash —— 未加固，无法验证"
            report.append("❌ " + line)
            if not first_break:
                first_break = line
            previous = compute_event_hash(event, previous, session_id)
            continue

        expected = compute_event_hash(event, previous, session_id)
        if stored != expected:
            ok = False
            line = (f"event[{i}] ({event.get('type')!r}) 哈希不匹配\n"
                    f"     期望 {expected}\n"
                    f"     实存 {stored}")
            report.append("❌ " + line)
            if not first_break:
                first_break = line
        else:
            report.append(f"✅ event[{i}] ({event.get('type')!r}) {stored[:16]}…")
        previous = stored

    integrity = log.get("_integrity", {})
    head = integrity.get("head_hash", "")
    if not head:
        ok = False
        report.append("❌ _integrity.head_hash 缺失 —— 链没有锚点")
    elif head != previous:
        ok = False
        line = (f"_integrity.head_hash 不匹配\n"
                f"     期望 {previous}\n"
                f"     实存 {head}")
        report.append("❌ " + line)
        if not first_break:
            first_break = line
    else:
        report.append(f"✅ head_hash {head}")

    length = integrity.get("chain_length")
    if length is not None and length != len(events):
        ok = False
        line = f"_integrity.chain_length={length} 与实际事件数 {len(events)} 不符"
        report.append("❌ " + line)
        if not first_break:
            first_break = line

    return ok, report, first_break


# ── 文件监视 ──────────────────────────────────────────────────────────


def utc_now() -> str:
    return (datetime.datetime.now(datetime.timezone.utc)
            .isoformat(timespec="seconds").replace("+00:00", "Z"))


def enable_realtime_output() -> None:
    """
    让输出实时可见。

    默认情况下 stdout 一旦不是终端（例如被重定向到文件、或通过管道被父进程捕获）
    就会使用 4–8KB 的块缓冲，事件太少时会一直攒着、进程退出才刷出来 ——
    表现就是"只有结束终端后才写入记录"。这里强制行缓冲并保证 UTF-8 编码。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True, encoding="utf-8",
                               errors="replace")
        except (AttributeError, ValueError, OSError):
            pass          # 老版本 Python 或已被替换的流：忽略，靠 flush() 兜底


def flush() -> None:
    try:
        sys.stdout.flush()
    except (ValueError, OSError):
        pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def preview_of(text: str, width: int) -> str:
    """
    生成预览串 —— 保留原文（含中文等所有可打印字符）。

    只替换真正的不可打印/控制字符，且替换成 **ASCII 转义**（\\n \\t \\r），
    这样预览本身仍可能含中文，但哈希稳定性由 compute_event_hash() 的
    ensure_ascii=True 保证（非 ASCII 一律转义成 \\uXXXX），与预览是否含中文无关。
    """
    out = []
    for ch in text[:width]:
        if ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ch.isprintable():
            out.append(ch)          # ← 中文、emoji、重音字母都原样保留
        else:
            out.append("?")
    return "".join(out)


def decode_text(data: bytes) -> tuple[str, str]:
    """
    把字节解码成文本，返回 (文本, 编码名)。

    中文 Windows 上的文本文件很可能是 GBK 而不是 UTF-8，所以依次尝试：
    UTF-8 with BOM → UTF-8 → GBK。最后兜底用 UTF-8 + replace。
    """
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            return data.decode(enc), enc
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace"), "utf-8(replace)"


def read_state(path: pathlib.Path, preview_width: int = PREVIEW_CHARS) -> dict | None:
    """读取文件当前状态。文件不存在返回 None。"""
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None

    if len(data) > MAX_READ_BYTES:
        return {"bytes": len(data), "sha256": digest(data), "chars": None,
                "lines": None, "preview": "(file too large, hash only)",
                "encoding": "?", "text": ""}

    decoded, enc = decode_text(data)
    # 只保留前 MAX_TEXT_CHARS 字符用于算 diff，避免超大文件吃内存；
    # 超出时不猜内容（diff 会被标为 truncated）。
    text = decoded[:MAX_TEXT_CHARS]
    stripped = text.rstrip("\r\n")
    return {
        "bytes": len(data),
        "sha256": digest(data),
        "chars": len(decoded),
        "lines": len(stripped.splitlines()) if stripped else 0,
        "preview": preview_of(text, preview_width),
        "encoding": enc,
        "text": text,                      # 仅供内存内算 diff，不写入日志
        "text_truncated": len(decoded) > MAX_TEXT_CHARS,
    }


def truncate_middle(s: str, limit: int = FRAGMENT_CHARS) -> str:
    """
    超长片段做「首尾保留、中间省略」。

    只截尾部是不行的 —— 那会让读者看不到改动到底落在哪个位置。
    """
    if len(s) <= limit:
        return s
    head = limit * 2 // 3
    tail = limit - head
    return f"{s[:head]}…<中间省略 {len(s) - limit} 字符>…{s[-tail:]}"


def diff_fragments(old: str, new: str) -> tuple[list[str], list[str], bool]:
    """
    用最长的公共前缀/后缀夹逼出「本轮改了什么」，中间那段就是改动区。

    返回值顺序是 **(removed, added, truncated)** —— removed 属于 old，added 属于 new。

    比逐字符 LCS 简单得多，但对"编辑文档"这个场景足够准，
    且缺点很明确：改动区内部的公共子串也会被算进 removed/added（宁可多报，不漏报）。
    """
    if old == new:
        return [], [], False

    truncated = False
    n = min(len(old), len(new))
    p = 0
    while p < n and old[p] == new[p]:
        p += 1

    s = 0
    while s < n - p and old[len(old) - 1 - s] == new[len(new) - 1 - s]:
        s += 1

    removed = old[p:len(old) - s] if s else old[p:]
    added = new[p:len(new) - s] if s else new[p:]

    out_r = [truncate_middle(removed)] if removed else []
    out_a = [truncate_middle(added)] if added else []
    if removed and out_r[0] != removed:
        truncated = True
    if added and out_a[0] != added:
        truncated = True
    return out_r, out_a, truncated


def shorten(s: str, limit: int) -> str:
    """终端单行显示用的简短截断。"""
    one = s.replace("\n", "\\n").replace("\r", "\\r")
    return one if len(one) <= limit else one[:limit] + "…"


def format_change(timestamp: str, event_hash: str, meta: dict,
                  content_sha256: str = "") -> str:
    """把一条 content_modified 渲染成「删了什么 / 加了什么」两行。"""
    delta = meta.get("delta_chars")
    delta_txt = f"{delta:+d}" if isinstance(delta, int) else "?"
    mode = meta.get("mode", "replace")
    truncated = "…(已截断)" if meta.get("diff_truncated") else ""
    sha = content_sha256 or meta.get("content_sha256", "")

    lines = [
        f"[{timestamp}] content_modified  {mode}  "
        f"{fmt_chars(meta.get('char_count'))} chars ({delta_txt})  "
        f"{sha[:12]}…  _hash={event_hash[:12]}…"
    ]
    removed, added = meta.get("removed") or [], meta.get("added") or []
    for frag in removed:
        lines.append(f"    − 删除  {shorten(frag, 150)}")
    for frag in added:
        lines.append(f"    + 新增  {shorten(frag, 150)}{truncated}")
    if not removed and not added:
        lines.append("    (diff 无法计算：内容超出内存分析上限)")
    return "\n".join(lines)


def change_mode(delta: int | None, added: list[str], removed: list[str]) -> str:
    """把本轮变更归类为 add / del / replace。"""
    if delta is None:
        return "replace"
    if delta > 0 and not removed:
        return "add"
    if delta < 0 and not added:
        return "del"
    return "replace"


def fmt_chars(value: int | None) -> str:
    """字符数可能是 None（超大文件），格式化时兜底。"""
    return f"{value:,}" if isinstance(value, int) else "?"


def diff_meta(previous: dict | None, current: dict) -> dict:
    """
    算出「本轮删了什么、加了什么」，供 content_modified 事件记录。

    只对 content_modified 调用（基线/新建/删除没有"本轮变更"可言）。
    """
    if previous is None:
        return {}
    delta = None
    if previous.get("chars") is not None and current.get("chars") is not None:
        delta = current["chars"] - previous["chars"]

    # 注意返回顺序是 (removed, added, truncated)，与函数签名一致
    removed, added, truncated = diff_fragments(
        previous.get("text", "") or "", current.get("text", "") or "")
    meta = {
        "mode": change_mode(delta, added, removed),
        "removed": removed,          # 本轮被删掉的片段
        "added": added,              # 本轮新增的片段
        "diff_truncated": truncated
        or bool(previous.get("text_truncated") or current.get("text_truncated")),
    }
    return meta


def make_meta(state: dict, previous: dict | None, with_diff: bool = False) -> dict:
    meta = {
        "char_count": state["chars"],
        "line_count": state["lines"],
        "byte_count": state.get("bytes"),
        "encoding": state.get("encoding", "?"),
        "content_sha256": state["sha256"],
        "preview": state["preview"],
    }
    if previous and previous.get("chars") is not None and state["chars"] is not None:
        meta["delta_chars"] = state["chars"] - previous["chars"]
    if previous and previous.get("lines") is not None and state["lines"] is not None:
        meta["delta_lines"] = state["lines"] - previous["lines"]
    if with_diff:
        meta.update(diff_meta(previous, state))
    return meta


def new_log(file_path: pathlib.Path, log_path: pathlib.Path) -> dict:
    return {
        "version": SPEC_VERSION,
        "session_id": str(uuid.uuid4()),
        "user_id": "anon-" + hashlib.sha256(str(uuid.uuid4()).encode())
        .hexdigest()[:12],
        "start_time": utc_now(),
        "end_time": None,
        "content_source": str(file_path),
        "events": [],
        "_integrity": None,
    }


def save_log(log: dict, log_path: pathlib.Path) -> None:
    log_path.write_text(json.dumps(log, indent=2, ensure_ascii=False),
                        encoding="utf-8")


# ── 并发保护 ──────────────────────────────────────────────────────────
# 教训：曾经在 watch 运行期间执行 init --force，把正在记录的日志覆盖了；
# 之所以没丢数据，只是因为那个 watch 还在内存里持有旧内容、一写回又冲掉了覆盖。
# 如果它当时是崩溃退出，日志就永久丢了。所以加锁文件让覆盖行为变得可见、可控。

def lock_path_for(log_path: pathlib.Path) -> pathlib.Path:
    return log_path.with_suffix(log_path.suffix + ".lock")


def pid_alive(pid: int) -> bool | None:
    """
    探测 pid 是否存活。True=存活，False=确认不存在，None=无法判断。

    实测结论（重要）：在受限/沙箱环境里，os.kill(存活的外部进程, 0) 会抛
    OSError WinError 87（ERROR_INVALID_PARAMETER），而不是成功 —— 也就是说
    **WinError 87 并不等于"进程不存在"**，只能说明"探测不了"。
    因此除了明确的 ProcessLookupError，一律返回 None，交给调用方用
    "锁新鲜度"兜底判断，绝不能把探测失败当成"已死"。
    """
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except BaseException:
        return None            # 权限不足 / WinError 87 / 其他：无法判断


LOCK_STALE_SECONDS = 90      # 锁心跳超过这么久没刷新，才认为进程已死
LOCK_HEARTBEAT_SECONDS = 30  # watch 多久刷新一次锁


def read_lock(log_path: pathlib.Path) -> dict | None:
    """
    读取锁文件；确认陈旧的返回 None。

    判定"仍被占用"：pid 确认存活 **或** 锁文件在 LOCK_STALE_SECONDS 内被刷新过。
    后者是探测不可靠时的兜底 —— 宁可拦住操作，也不要把正在写入的日志静默覆盖。
    正常运行中 watch 会不断刷新锁，所以不会误判；真崩溃了最多 90 秒后自动解锁。
    """
    lock = lock_path_for(log_path)
    if not lock.exists():
        return None
    try:
        data = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    if pid_alive(data.get("pid", -1)) is True:
        return data

    try:
        age = time.time() - lock.stat().st_mtime
    except OSError:
        return None
    return data if age < LOCK_STALE_SECONDS else None


def acquire_lock(log_path: pathlib.Path) -> None:
    lock_path_for(log_path).write_text(
        json.dumps({"pid": os.getpid(), "since": utc_now()},
                   ensure_ascii=False),
        encoding="utf-8")


def touch_lock(log_path: pathlib.Path) -> None:
    """
    刷新锁文件时间戳（心跳）。

    锁的"是否陈旧"完全依赖 mtime，所以必须定期刷新 ——
    否则进程活着也会因为锁变旧而被判成已死。
    """
    lock = lock_path_for(log_path)
    try:
        os.utime(lock, None)
    except OSError:
        pass


def release_lock(log_path: pathlib.Path) -> None:
    lock = lock_path_for(log_path)
    try:
        data = json.loads(lock.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = None
    if data and data.get("pid") not in (None, os.getpid()):
        return                       # 不是我加的锁，别删
    try:
        lock.unlink()
    except OSError:
        pass


def warn_if_watching(log_path: pathlib.Path, action: str) -> None:
    """如果该日志正被另一个 watch 进程持有，明确警告并给出选择。"""
    holder = read_lock(log_path)
    if not holder:
        return
    print(f"⚠ 该日志正在被监视进程使用：pid={holder.get('pid')} "
          f"(since {holder.get('since')})")
    print(f"  现在{action}，结果会被那个进程的内存副本覆盖，看起来就像「没生效」。")
    print("  建议先在那个窗口按 Ctrl+C 结束监视，再执行；"
          "确实要强行继续请加 --force。")


def emit(message: str) -> None:
    """打印并立刻刷盘 —— 保证监视过程中实时可见。"""
    print(message)
    flush()


def load_log(log_path: pathlib.Path) -> dict:
    if not log_path.exists():
        sys.exit(f"日志不存在: {log_path}（先跑 init）")
    return json.loads(log_path.read_text(encoding="utf-8"))


# ── 子命令 ────────────────────────────────────────────────────────────


def cmd_init(args: argparse.Namespace) -> int:
    file_path, log_path = pathlib.Path(args.file), pathlib.Path(args.log)
    if log_path.exists():
        if not args.force:
            sys.exit(f"日志已存在: {log_path}（加 --force 覆盖）")
        warn_if_watching(log_path, "覆盖")

    log = new_log(file_path, log_path)
    append_event(log, "chain_init", {"content_source": str(file_path)})

    state = read_state(file_path, args.preview_chars)
    if state is None:
        emit(f"⚠ 文件不存在: {file_path}（监视期间创建也没问题）")
    else:
        append_event(log, "content_baseline", make_meta(state, None))

    save_log(log, log_path)
    emit(f"已创建日志 {log_path}")
    emit(f"  session_id : {log['session_id']}")
    emit(f"  监视目标   : {file_path}")
    emit(f"  起始事件数 : {len(log['events'])}")
    if state:
        emit(f"  基线       : {fmt_chars(state['chars'])} chars / "
             f"{state['lines']} lines / 编码 {state.get('encoding', '?')}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    file_path, log_path = pathlib.Path(args.file), pathlib.Path(args.log)

    holder = read_lock(log_path)
    if holder:
        message = (f"⚠ {log_path} 正被另一个监视进程使用"
                   f"（pid={holder.get('pid')}，since {holder.get('since')}）。\n"
                   f"  同时跑两个 watch 会互相覆盖事件。请先结束那一个；"
                   f"确认它已不在运行可加 --force。")
        if not args.force:
            sys.exit(message)
        print(message.replace("请先结束那一个；确认它已不在运行可加 --force。",
                              "按 --force 继续。"))

    if not log_path.exists():
        print(f"日志不存在，自动 init: {log_path}")
        log = new_log(file_path, log_path)
        append_event(log, "chain_init", {"content_source": str(file_path)})
    else:
        log = load_log(log_path)

    if args.announce:
        announce(log, args.announce)

    state = read_state(file_path, args.preview_chars)
    if state is not None and not any(e["type"] == "content_baseline" for e in log["events"]):
        append_event(log, "content_baseline", make_meta(state, None))
        save_log(log, log_path)
        print(f"已补记基线: {state['chars']} chars / {state['lines']} lines")

    previous = state
    stopping = {"flag": False}

    def stop(signum, frame):          # noqa: ARG001
        stopping["flag"] = True

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, stop)
        except (ValueError, OSError):
            pass

    append_event(log, "watch_start", {"interval_sec": args.interval})
    save_log(log, log_path)
    acquire_lock(log_path)
    emit(f"开始监视 {file_path}（每 {args.interval}s 检查一次，Ctrl+C 停止）")
    emit(f"日志: {log_path}   session: {log['session_id'][:8]}…")
    if state:
        emit(f"当前基线: {state['chars']} chars / {state['lines']} lines "
             f"(编码 {state.get('encoding', '?')})  —— 开始实时记录")
    emit("-" * 72)

    try:
        last_beat = time.time()
        while not stopping["flag"]:
            time.sleep(args.interval)

            now = time.time()
            if now - last_beat >= LOCK_HEARTBEAT_SECONDS:
                touch_lock(log_path)          # 心跳：让锁保持新鲜
                last_beat = now

            current = read_state(file_path, args.preview_chars)

            if current is None:
                if previous is not None:
                    append_event(log, "content_deleted", {"content_sha256": None})
                    save_log(log, log_path)          # 先落盘
                    emit(f"[{utc_now()}] 文件被删除")  # 再打印
                    previous = None
                continue

            if previous is None:
                append_event(log, "content_created", make_meta(current, None))
                save_log(log, log_path)
                emit(f"[{utc_now()}] 文件被创建 "
                     f"({fmt_chars(current['chars'])} chars, {current['sha256'][:12]}…)")
                previous = current
                continue

            if current["sha256"] != previous["sha256"]:
                meta = make_meta(current, previous, with_diff=True)
                event = append_event(log, "content_modified", meta)
                save_log(log, log_path)              # 先落盘
                emit(format_change(event["timestamp"], event["_hash"], meta,
                                   current["sha256"]))
                previous = current
    finally:
        log["end_time"] = utc_now()
        append_event(log, "session_end", {"reason": "signal_or_exit"})
        save_log(log, log_path)
        release_lock(log_path)
        emit("-" * 72)
        emit(f"已停止。共 {len(log['events'])} 条事件，head_hash="
             f"{log['_integrity']['head_hash'][:24]}…")
    return 0


def announce(log: dict, announce_path: str) -> None:
    """
    把当前 head_hash 公布/固化到日志之外的文件。

    这一步是整套机制可信的前提：链能证明"日志自洽"，但只有把 head_hash 留在
    日志之外（校方数据库、邮件、区块链、签名……），才能发现"篡改后重算整条链"。
    """
    path = pathlib.Path(announce_path)
    head = (log.get("_integrity") or {}).get("head_hash", "")
    record = {
        "session_id": log.get("session_id"),
        "content_source": log.get("content_source"),
        "head_hash": head,
        "chain_length": len(log.get("events", [])),
        "announced_at": utc_now(),
        "note": "链外锚点。篡改后重算链会使 head_hash 变化，与本文件比对即可发现。",
    }

    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        if old.get("head_hash") == head:
            print(f"锚点未变（{path}）：{head[:24]}…")
        else:
            print(f"⚠ 锚点已变化！旧 {old.get('head_hash','')[:24]}… "
                  f"→ 新 {head[:24]}…")
            print(f"  若这不是你预期的更新，说明日志被重算过。")
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False),
                        encoding="utf-8")
    else:
        path.write_text(json.dumps(record, indent=2, ensure_ascii=False),
                        encoding="utf-8")
        print(f"已固化链外锚点 {path}")
        print(f"  head_hash   : {head}")
        print(f"  chain_length: {record['chain_length']}")


def cmd_announce(args: argparse.Namespace) -> int:
    log_path = pathlib.Path(args.log)
    log = load_log(log_path)

    # announce 也会写文件（推链长度、刷新 head_hash），所以同样要尊重锁：
    # 否则会留下孤儿锁文件，还可能把锚点更新成一个即将被覆盖的状态。
    lock_active = False
    if read_lock(log_path):
        if not args.force:
            sys.exit(f"⚠ {log_path} 正被监视进程使用；"
                     f"监视期间 head_hash 会持续变化，请先结束 watch 再 announce，"
                     f"或加 --force。")
        print("⚠ 监视进程仍在运行，按 --force 继续 announce。")
    else:
        acquire_lock(log_path)
        lock_active = True

    ok = True
    try:
        ok, _report, first_break = verify_chain(log)
        if not ok:
            print(f"⚠ 当前链本身已损坏，仍将固化其 head_hash："
                  f"{first_break.splitlines()[0]}")
        announce(log, args.out)
    finally:
        if lock_active:
            release_lock(log_path)
    return 0 if ok else 1


def cmd_verify(args: argparse.Namespace) -> int:
    log_path = pathlib.Path(args.log)
    log = load_log(log_path)
    ok, report, first_break = verify_chain(log)
    for line in report:
        print("  " + line)

    # 交叉检查：日志是自洽的，但正文是否还是被记录的那一版？
    if args.file:
        state = read_state(pathlib.Path(args.file))
        latest = next((e for e in reversed(log["events"])
                       if e.get("meta", {}).get("content_sha256")), None)
        if state and latest:
            recorded = latest["meta"]["content_sha256"]
            actual = state["sha256"]
            if recorded == actual:
                print(f"  ✅ 正文与记录一致 {actual[:16]}…")
            else:
                ok = False
                print(f"  ❌ 正文与记录不一致\n"
                      f"     记录 {recorded}\n"
                      f"     实际 {actual}")
                if not first_break:
                    first_break = "正文哈希与记录不符"

    print()
    if ok:
        print(f"✅ 完整  {len(log['events'])} 条事件，链未被篡改")
        return 0
    print(f"❌ 被篡改  首次异常: {first_break}")
    return 1


def cmd_show(args: argparse.Namespace) -> int:
    log = load_log(pathlib.Path(args.log))
    print(f"session   : {log.get('session_id')}")
    print(f"target    : {log.get('content_source')}")
    print(f"start→end : {log.get('start_time')} → {log.get('end_time')}")
    print(f"events    : {len(log.get('events', []))}")
    head = (log.get("_integrity") or {}).get("head_hash", "(无)")
    print(f"head_hash : {head}")
    print("-" * 78)
    for i, e in enumerate(log.get("events", [])):
        meta = e.get("meta", {})
        bits = []
        if meta.get("char_count") is not None:
            bits.append(f"{fmt_chars(meta['char_count'])} chars")
        if isinstance(meta.get("delta_chars"), int):
            bits.append(f"{meta['delta_chars']:+d}")
        if meta.get("mode"):
            bits.append(f"[{meta['mode']}]")
        if meta.get("line_count") is not None:
            bits.append(f"{meta['line_count']} lines")
        if meta.get("encoding"):
            bits.append(f"enc={meta['encoding']}")
        if meta.get("content_sha256"):
            bits.append(meta["content_sha256"][:12] + "…")
        h = e.get("_hash", "")
        print(f"[{i:>2}] {e.get('timestamp')}  {e.get('type'):<17} {' '.join(bits)}")
        print(f"     _hash={h[:32] + '…' if h else '(none)'}")
        for frag in meta.get("removed") or []:
            print(f"       − 删除  {shorten(frag, 150)}")
        for frag in meta.get("added") or []:
            suffix = "   …(已截断)" if meta.get("diff_truncated") else ""
            print(f"       + 新增  {shorten(frag, 150)}{suffix}")
        if meta.get("preview"):
            print(f"       preview: {shorten(meta['preview'], 120)}")
    return 0


def main() -> int:
    enable_realtime_output()
    parser = argparse.ArgumentParser(description="文件修改审计日志（逐事件哈希链）")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_init = sub.add_parser("init", help="创建空日志")
    p_init.add_argument("--file", default="textfile.txt")
    p_init.add_argument("--log", default="audit.json")
    p_init.add_argument("--preview-chars", type=int, default=PREVIEW_CHARS,
                        help="预览保留字符数（进入哈希，需与 watch 一致）")
    p_init.add_argument("--force", action="store_true")
    p_init.set_defaults(func=cmd_init)

    p_watch = sub.add_parser("watch", help="监视文件并记录修改")
    p_watch.add_argument("--file", default="textfile.txt")
    p_watch.add_argument("--log", default="audit.json")
    p_watch.add_argument("--interval", type=float, default=1.0)
    p_watch.add_argument("--preview-chars", type=int, default=PREVIEW_CHARS)
    p_watch.add_argument("--announce", default="anchor.json",
                         help="把 head_hash 固化到该文件（链外锚点）")
    p_watch.add_argument("--force", action="store_true",
                         help="即使检测到另一个 watch 持有该日志也强行启动")
    p_watch.set_defaults(func=cmd_watch)

    p_announce = sub.add_parser("announce", help="把 head_hash 公布到链外文件")
    p_announce.add_argument("--log", default="audit.json")
    p_announce.add_argument("--out", default="anchor.json")
    p_announce.add_argument("--force", action="store_true",
                            help="即使检测到 watch 持有该日志也强行执行")
    p_announce.set_defaults(func=cmd_announce)

    p_verify = sub.add_parser("verify", help="复算哈希链")
    p_verify.add_argument("--log", default="audit.json")
    p_verify.add_argument("--file", default=None,
                          help="同时比对正文当前哈希")
    p_verify.set_defaults(func=cmd_verify)

    p_show = sub.add_parser("show", help="打印时间线")
    p_show.add_argument("--log", default="audit.json")
    p_show.set_defaults(func=cmd_show)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
