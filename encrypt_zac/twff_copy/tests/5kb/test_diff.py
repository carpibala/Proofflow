"""
test_diff.py — diff 行为的确定性测试

设计初衷：实现期出过一个"删除/新增完全颠倒"的 bug（diff_fragments 返回
(removed, added, truncated)，接收端按 (added, removed) 解包）。这个脚本把
方向、mode 归类、截断行为全部钉死，改动后跑一遍即可。

用法: python test_diff.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from chainlog import (FRAGMENT_CHARS, change_mode, diff_fragments,  # noqa: E402
                      diff_meta, truncate_middle)

PASS, FAIL = 0, 0


def check(label: str, got, want) -> None:
    global PASS, FAIL
    if got == want:
        PASS += 1
        print(f"  ✅ {label}")
    else:
        FAIL += 1
        print(f"  ❌ {label}\n       got : {got!r}\n       want: {want!r}")


def state(text: str) -> dict:
    return {"text": text, "chars": len(text), "text_truncated": False}


def main() -> int:
    print("① 基本方向：A→B 必须把 A 的内容算作 removed，B 的算作 added")
    A = "生成式 AI 正在改变教育。"
    B = "生成式 AI 正在重塑教育。"
    removed, added, _ = diff_fragments(A, B)
    check("diff_fragments(A,B) removed == ['改变']", removed, ["改变"])
    check("diff_fragments(A,B) added   == ['重塑']", added, ["重塑"])
    check("反过来 B→A 则相反",
          diff_fragments(B, A)[:2], (["重塑"], ["改变"]))

    print("\n② diff_meta 的字段与方向")
    m = diff_meta(state(A), state(B))
    check("removed", m["removed"], ["改变"])
    check("added", m["added"], ["重塑"])
    check("mode", m["mode"], "replace")
    check("delta 未变时 mode 仍为 replace", m["mode"], "replace")

    print("\n③ 纯新增 / 纯删除 的 mode 归类")
    check("append → add", diff_meta(state("abc"), state("abcdef"))["mode"], "add")
    check("truncate → del", diff_meta(state("abcdef"), state("abc"))["mode"], "del")
    check("改字 → replace", diff_meta(state("abc"), state("aXc"))["mode"], "replace")
    check("纯新增的 removed 为空", diff_meta(state("abc"), state("abcdef"))["removed"], [])
    check("纯删除的 added 为空", diff_meta(state("abcdef"), state("abc"))["added"], [])

    print("\n④ 空文本边界（注意：返回顺序是 removed, added）")
    check("相同文本无 diff", diff_fragments("abc", "abc"), ([], [], False))
    check("空文本", diff_fragments("", ""), ([], [], False))
    check("空 → 非空: removed 为空、added 为 abc",
          diff_fragments("", "abc"), ([], ["abc"], False))
    check("非空 → 空: removed 为 abc、added 为空",
          diff_fragments("abc", ""), (["abc"], [], False))

    print("\n⑤ 截断：只截中间，首尾必须保留")
    # 注意用例设计：如果新旧文本共享很长的前缀/后缀，夹逼后改动区会很小，
    # 根本不会触发截断。所以这里用真正的整篇替换。
    long_old = "甲" * 400
    long_new = "乙" * 400
    m2 = diff_meta(state(long_old), state(long_new))
    check("标记为已截断", m2["diff_truncated"], True)
    frag_r, frag_a = m2["removed"][0], m2["added"][0]
    check("被截断的片段超过上限", len(frag_r) > FRAGMENT_CHARS, True)
    check("片段含省略标记", "<中间省略" in frag_r, True)
    check("删除片段首部保留", frag_r.startswith("甲" * 20), True)
    check("删除片段尾部保留", frag_r.endswith("甲" * 20), True)
    check("新增片段首部保留", frag_a.startswith("乙" * 20), True)
    check("新增片段尾部保留", frag_a.endswith("乙" * 20), True)
    check("片段长度受控", len(frag_r) < FRAGMENT_CHARS + 60, True)

    print("\n⑤b 共享长前后缀时不应误判为截断")
    m3 = diff_meta(state("A" * 500), state("A" * 250 + "X" * 40 + "A" * 210))
    check("改动区很小 → 不截断", m3["diff_truncated"], False)

    print("\n⑥ truncate_middle 边界")
    check("短串原样返回", truncate_middle("short", 100), "short")
    check("刚好等于上限原样返回", truncate_middle("x" * 100, 100), "x" * 100)
    t = truncate_middle("x" * 200, 100)
    check("超长则含省略标记", "<中间省略" in t, True)

    print("\n⑦ diff 结果必须能被 JSON 序列化（要写进日志）")
    import json
    try:
        json.dumps(diff_meta(state(A), state(B)), ensure_ascii=False)
        check("可序列化", True, True)
    except TypeError as exc:                      # pragma: no cover
        check(f"可序列化（{exc}）", False, True)

    print(f"\n{'=' * 60}")
    print(f"通过 {PASS} 项，失败 {FAIL} 项")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
