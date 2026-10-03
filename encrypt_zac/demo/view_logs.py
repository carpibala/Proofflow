"""
view_logs.py — 查看 / 校验 TWFF 记录

用法:
    python view_logs.py <process-log.json> [更多文件...]
    python view_logs.py <document.twff>          # 直接读容器（ZIP）

它做三件事:
    1. 打印记录摘要（会话、事件类型统计、时间跨度）
    2. 逐条打印事件（kind + 关键字段）
    3. 调用仓库自带的 verify_process_log() 复算哈希链
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys
import zipfile

REPO = pathlib.Path(__file__).parent.parent / "twff"

spec = importlib.util.spec_from_file_location(
    "twff_verify", REPO / "spec" / "verification" / "verify_process_log.py"
)
tv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tv)
verify_process_log = tv.verify_process_log


def load_log(path: pathlib.Path) -> dict:
    if path.suffix == ".twff" or zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as zf:
            raw = zf.read("meta/process-log.json").decode("utf-8")
        return json.loads(raw)
    return json.loads(path.read_text(encoding="utf-8"))


def describe(log: dict) -> None:
    events = log.get("events", [])
    kinds: dict[str, int] = {}
    for e in events:
        kinds[e.get("type", "?")] = kinds.get(e.get("type", "?"), 0) + 1

    print(f"  version      : {log.get('version')}")
    print(f"  session_id   : {log.get('session_id')}")
    print(f"  user_id      : {log.get('user_id')}")
    print(f"  start → end  : {log.get('start_time')}  →  {log.get('end_time')}")
    print(f"  content      : {log.get('content_source')}")
    print(f"  events       : {len(events)}  ({', '.join(f'{k}×{v}' for k, v in kinds.items())})")
    print(f"  _integrity   : {json.dumps(log.get('_integrity', {}), ensure_ascii=False)}")


def show_events(log: dict) -> None:
    for i, e in enumerate(log.get("events", [])):
        meta = e.get("meta", {})
        bits = []
        for key in ("source", "interaction_type", "model", "char_count",
                    "word_count_total", "acceptance", "position_start", "duration_ms"):
            if key in meta:
                bits.append(f"{key}={meta[key]}")
        preview = meta.get("output_preview") or ""
        if preview:
            bits.append(f"preview={preview[:40]!r}")
        h = e.get("_hash")
        print(f"  [{i}] {e.get('timestamp')}  {e.get('type'):<16} "
              f"{' '.join(bits)}")
        print(f"       _hash={h[:24] + '…' if h else '(none)'}")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1

    for name in argv:
        path = pathlib.Path(name)
        print("=" * 72)
        print(f"FILE: {path}")
        try:
            log = load_log(path)
        except (KeyError, json.JSONDecodeError, OSError) as exc:
            print(f"  !! 无法读取: {type(exc).__name__}: {exc}")
            continue

        describe(log)
        print("  ── events ──")
        show_events(log)

        ok, detail = verify_process_log(log)
        print(f"  ── 校验 ──")
        print(f"  {'✅ INTACT' if ok else '❌ BROKEN'}  {detail}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
