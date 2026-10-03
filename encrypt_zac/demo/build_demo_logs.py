"""
build_demo_logs.py — 用 TWFF 仓库自带的哈希链函数生成演示文件

复用 spec/verification/validate_examples.py 里的 compute_event_hash / add_hash_chain，
不重新实现算法，保证与规范完全一致。

注意：这里显式用 encoding="utf-8" 读写。仓库自带的 validate_examples.py 用的是
裸 open()，在中文 Windows 上会因默认 GBK 解码而报 UnicodeDecodeError。
"""
from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import sys

DEMO_DIR = pathlib.Path(__file__).parent
REPO = DEMO_DIR.parent / "twff"

# 直接从仓库加载自带实现，避免"我抄一遍算法"带来的偏差
spec = importlib.util.spec_from_file_location(
    "twff_validator", REPO / "spec" / "verification" / "validate_examples.py"
)
tv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tv)

add_hash_chain = tv.add_hash_chain
compute_event_hash = tv.compute_event_hash


def load(path: pathlib.Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def dump(obj: dict, path: pathlib.Path) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  written: {path.name}")


def main() -> int:
    src = DEMO_DIR / "process-log.v0.1.json"
    log = load(src)

    # ① 原始 v0.1：无 _hash，只有整体 hash —— 这就是 Glass Box 现在导出的形态
    bare = copy.deepcopy(log)
    bare.pop("_hash", None)
    dump(bare, DEMO_DIR / "01-v0.1-original.json")

    # ② 加上 v0.2 逐事件哈希链
    chained = add_hash_chain(copy.deepcopy(bare))
    dump(chained, DEMO_DIR / "02-v0.2-chained.json")

    # ③ 篡改：改掉第 3 个事件（ai_interaction）里的一个字段，保留原链
    tampered = copy.deepcopy(chained)
    target = tampered["events"][3]
    print(f"\n  篡改前 event[3] = {json.dumps(target, ensure_ascii=False)[:140]}")
    target["output_preview"] = "Subsequently, the implementation was TAMPERED."
    print(f"  篡改后 event[3] = {json.dumps(target, ensure_ascii=False)[:140]}")
    dump(tampered, DEMO_DIR / "03-tampered-field.json")

    # ④ 篡改：调换第 4、5 个事件的顺序，保留原链
    swapped = copy.deepcopy(chained)
    swapped["events"][4], swapped["events"][5] = swapped["events"][5], swapped["events"][4]
    dump(swapped, DEMO_DIR / "04-tampered-order.json")

    # ⑤ 篡改后重新生成链（攻击者重算整条链）
    rechained = add_hash_chain(copy.deepcopy(tampered))
    dump(rechained, DEMO_DIR / "05-tampered-rechained.json")

    # ⑥ 链式传播演示：只改 event[1]，看后续每个事件的期望值如何全部变化
    print("\n  链式传播（只改 event[1]，后续 _hash 全部失效）:")
    prev = ""
    original_hashes = [e["_hash"] for e in chained["events"]]
    for i, ev in enumerate(tampered["events"]):
        h = compute_event_hash(ev, prev, tampered["session_id"])
        flag = "OK  " if h == original_hashes[i] else "FAIL"
        print(f"    event[{i}] {flag} expected={h[:16]}…  stored={original_hashes[i][:16]}…")
        prev = h

    print("\n  head_hash 对比:")
    print(f"    02 原始链:      {chained['_integrity']['head_hash']}")
    print(f"    05 重算后的链:  {rechained['_integrity']['head_hash']}")
    print(f"    03 篡改未重算:  {tampered['_integrity']['head_hash']}  (链未动，事件已变)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
