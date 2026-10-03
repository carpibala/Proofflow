"""
rechain_demo.py — 演示「篡改后重算整条链」，以及为什么必须要有链外锚点

结论预告：
    重算后的日志，链内校验（以及 twff 自带的 verify_process_log）会 PASS，
    只有和链外锚点 anchor.json 比对 head_hash 才能发现。

用法（在项目根目录执行）:
    python examples/rechain_demo.py
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

REPO = ROOT.parent / "twff"                   # TWFF 仓库（项目根目录的兄弟目录）


def load_repo_verifier():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "vf", REPO / "spec" / "verification" / "verify_process_log.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.verify_process_log


def main() -> int:
    repo_verify = load_repo_verifier()
    log = json.loads((ROOT / "audit.json").read_text(encoding="utf-8"))
    anchor = json.loads((ROOT / "anchor.json").read_text(encoding="utf-8"))
    original_head = log["_integrity"]["head_hash"]
    n = len(log["events"])

    if n < 4:
        print(f"日志只有 {n} 条事件，不足以演示。先跑一轮 watch 多记几条：")
        print("  python chainlog.py watch --file textfile.txt --log audit.json")
        return 1
    mid = n // 2

    print(f"原始链   : {n} 条事件  head={original_head[:24]}…")
    print(f"链外锚点 : chain_length={anchor['chain_length']}  "
          f"head={anchor['head_hash'][:24]}…\n")

    # ── 场景 A：只改不重算
    a = copy.deepcopy(log)
    a["events"][mid]["meta"]["char_count"] = 1
    ok_a, _, brk_a = verify_chain(a)
    print(f"场景 A  改 event[{mid}]，不重算链")
    print(f"  链内校验      : {'PASS' if ok_a else 'FAIL'}  {brk_a.splitlines()[0]}")

    # ── 场景 B：改完重算整条链（攻击者最强手段）
    b = copy.deepcopy(a)
    sid = b["session_id"]
    prev = ""
    for event in b["events"]:
        prev = compute_event_hash(event, prev, sid)
        event["_hash"] = prev
    b["_integrity"]["head_hash"] = prev
    b["_integrity"]["chain_length"] = len(b["events"])

    ok_b, _, _ = verify_chain(b)
    repo_ok_b, repo_detail_b = repo_verify(b)
    print(f"\n场景 B  改完把整条链重算一遍")
    print(f"  链内校验      : {'PASS' if ok_b else 'FAIL'}")
    print(f"  twff 自带校验 : {'PASS' if repo_ok_b else 'FAIL'}  ({repo_detail_b})")
    print(f"  新 head_hash  : {prev[:24]}…")
    verdict = ("一致 → 未发现" if prev == anchor["head_hash"]
               else "❌ 不一致 → 发现篡改")
    print(f"  与链外锚点比对: {verdict}")
    print(f"    锚点值      : {anchor['head_hash'][:24]}… ({anchor['chain_length']} 条事件时固化)")
    print(f"    链长度变化  : {anchor['chain_length']} → {len(b['events'])}")

    print("\n结论：链内校验只证明『日志自洽』，不证明『日志未被重写过』。")
    print("     要发现场景 B，必须把 head_hash 固化在日志之外（anchor.json / 校方数据库 / 签名）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
