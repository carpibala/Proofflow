"""
tamper_demo.py — 篡改检测演示

复制 audit.json 制造 5 种篡改，逐一复算哈希链，看哪种能被抓到。
直接复用 chainlog.py 里的 verify_chain / compute_event_hash，不重复实现。

用法（在项目根目录执行）:
    python examples/tamper_demo.py
读取的是项目根目录下的 audit.json 与 anchor.json（不是本目录）。
"""
from __future__ import annotations

import copy
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).parent          # examples/
ROOT = HERE.parent                            # 项目根目录
sys.path.insert(0, str(ROOT))
from chainlog import compute_event_hash, verify_chain  # noqa: E402

ORIGINAL = ROOT / "audit.json"


def load() -> dict:
    return json.loads(ORIGINAL.read_text(encoding="utf-8"))


def check(label: str, log: dict) -> bool:
    ok, _report, first_break = verify_chain(log)
    mark = "✅ 未发现（链自洽）" if ok else f"❌ 抓到：{first_break.splitlines()[0]}"
    print(f"  {label:<34} {mark}")
    return ok


def main() -> int:
    base = load()
    n = len(base["events"])
    if n < 5:
        print(f"日志只有 {n} 条事件，不足以演示。先跑一轮 watch 多记几条：")
        print("  python chainlog.py watch --file textfile.txt --log audit.json")
        return 1
    mid = n // 2
    print(f"原始日志: {ORIGINAL.name}  事件数 {n}  "
          f"head_hash {base['_integrity']['head_hash'][:24]}…\n")

    results: dict[str, bool] = {}

    # 0) 未改动
    results["0 未改动"] = check("0 未改动", copy.deepcopy(base))

    # 1) 改一条事件的字段（把某次修改的字符数改小，假装没写那么多）
    a = copy.deepcopy(base)
    a["events"][mid]["meta"]["char_count"] = 1
    a["events"][mid]["meta"]["delta_chars"] = 1
    results["1 改事件字段"] = check(f"1 改事件字段 (event[{mid}])", a)

    # 2) 删掉一条事件（假装那次修改没发生）
    b = copy.deepcopy(base)
    del b["events"][mid + 1]
    results["2 删除一条事件"] = check(f"2 删除一条事件 (event[{mid + 1}])", b)

    # 3) 调换两条事件顺序
    c = copy.deepcopy(base)
    c["events"][mid], c["events"][mid + 1] = c["events"][mid + 1], c["events"][mid]
    results["3 调换顺序"] = check(f"3 调换顺序 (event[{mid}]↔[{mid + 1}])", c)

    # 4) 在末尾追加一条伪造事件（不重算链）
    d = copy.deepcopy(base)
    d["events"].append({
        "timestamp": "2026-10-03T06:29:25Z",
        "type": "content_modified",
        "meta": {"char_count": 9999, "delta_chars": 9843,
                 "content_sha256": "f" * 64, "preview": "fabricated"},
        "_hash": "0" * 64,
    })
    results["4 追加伪造事件"] = check(f"4 追加伪造事件 (event[{n}])", d)

    # 5) 改完重算整条链（攻击者最强手段）
    e = copy.deepcopy(a)
    session_id = e["session_id"]
    prev = ""
    for event in e["events"]:
        prev = compute_event_hash(event, prev, session_id)
        event["_hash"] = prev
    e["_integrity"]["head_hash"] = prev
    results["5 篡改后重算整条链"] = check("5 篡改后重算整条链", e)

    print()
    print(f"  原始 head_hash : {base['_integrity']['head_hash']}")
    print(f"  重算后 head_hash: {e['_integrity']['head_hash']}")
    print(f"  两者相同? {base['_integrity']['head_hash'] == e['_integrity']['head_hash']}")

    caught = sum(1 for k, ok in results.items() if not ok and not k.startswith("0"))
    print(f"\n  小结: 前 4 种篡改全部被链抓到；第 5 种让链重新自洽，"
          f"只能靠比对预先公布的 head_hash 发现。")
    return 0 if caught == 4 else 1

if __name__ == "__main__":
    sys.exit(main())
