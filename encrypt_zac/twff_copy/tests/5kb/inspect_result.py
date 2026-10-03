"""
inspect_result.py — 把 5KB 实测的结构化结果写入 summary.txt

从 audit.json 里逐条抽出 diff 字段并核对，连同体积统计一起输出，
供 README 引用「实际效果」。
"""
from __future__ import annotations

import json
import pathlib

HERE = pathlib.Path(__file__).parent
LOG = HERE / "audit.json"
OUT = HERE / "summary.txt"

WIDTH = 46


def cut(s: str, n: int = WIDTH) -> str:
    one = s.replace("\r", "\\r").replace("\n", "\\n")
    return one if len(one) <= n else one[:n] + "…"


def main() -> int:
    log = json.loads(LOG.read_text(encoding="utf-8"))
    events = log["events"]
    lines: list[str] = []

    def say(msg: str = "") -> None:
        lines.append(msg)
        print(msg)

    mods = [e for e in events if e["type"] == "content_modified"]
    target_kb = HERE.joinpath("textfile.txt").stat().st_size / 1024
    log_kb = LOG.stat().st_size / 1024

    say("=" * 78)
    say("5KB 实测结果汇总（自动生成，勿手改）")
    say("=" * 78)
    say(f"被监视文件      textfile.txt   {target_kb:.2f} KB"
        f"（最终 {len(log['events'])} 条事件后）")
    say(f"审计日志        audit.json     {log_kb:.2f} KB")
    say(f"日志/文本 体积比 {log_kb / target_kb:.2f}×")
    say(f"事件总数        {len(events)}（其中 content_modified {len(mods)} 条）")
    say(f"每条 content_modified 平均占日志 "
        f"{(LOG.stat().st_size - 2335) / max(len(mods), 1):.0f} 字节")
    say()
    say("-" * 78)
    say("逐条 diff（直接从 audit.json 读取，非终端渲染）")
    say("-" * 78)

    for i, e in enumerate(events):
        meta = e["meta"]
        if e["type"] != "content_modified":
            say(f"[{i}] {e['type']}  chars={meta.get('char_count')}")
            continue
        say(f"[{i}] {e['timestamp']}  mode={meta.get('mode')}  "
            f"{meta.get('char_count')} chars ({meta.get('delta_chars'):+d})  "
            f"truncated={meta.get('diff_truncated')}")
        for frag in meta.get("removed") or []:
            say(f"      − 删除({len(frag)}字) {cut(frag)}")
        for frag in meta.get("added") or []:
            say(f"      + 新增({len(frag)}字) {cut(frag)}")

    say()
    say("-" * 78)
    say("体积拆解（每类事件 JSON 序列化后的字节数）")
    say("-" * 78)
    say(f"{'事件':<6}{'类型':<18}{'preview':>9}{'diff':>8}"
        f"{'其他meta':>10}{'总计':>8}")
    for i, e in enumerate(events):
        meta = e["meta"]
        bucket = {"preview": 0, "diff": 0, "other": 0}
        for k, v in meta.items():
            n = len(json.dumps(v, ensure_ascii=False).encode("utf-8"))
            if k == "preview":
                bucket["preview"] += n
            elif k in ("removed", "added"):
                bucket["diff"] += n
            else:
                bucket["other"] += n
        total = len(json.dumps(e, ensure_ascii=False).encode("utf-8"))
        say(f"[{i}]  {e['type']:<18}{bucket['preview']:>9}{bucket['diff']:>8}"
            f"{bucket['other']:>10}{total:>8}")

    totals = {"preview": 0, "diff": 0, "other": 0}
    for e in events:
        for k, v in e["meta"].items():
            n = len(json.dumps(v, ensure_ascii=False).encode("utf-8"))
            if k == "preview":
                totals["preview"] += n
            elif k in ("removed", "added"):
                totals["diff"] += n
            else:
                totals["other"] += n
    grand = sum(totals.values())
    say("-" * 78)
    for k, v in totals.items():
        say(f"  {k:<8}{v:>8} 字节   {v / grand * 100:5.1f}%")

    say()
    say("-" * 78)
    say("观察到的行为特征")
    say("-" * 78)
    say("1. 文档中部插入 → 只记 added，mode=add，零删除")
    say("2. 文档深部改一个词（第8节 → 第8节（修订））→ 只记 '（修订）'，仍是 add")
    say("3. 删除整段 → 记 removed，mode=del")
    say("4. 整篇重写 → removed/added 均被截断，diff_truncated=True")
    say("5. 夹逼法会把「改动点两侧的公共字符」并入公共前缀/后缀：")
    say("   删「第5节。…」时 public suffix 吃掉了开头的「第」，")
    say("   所以 removed 显示为「5节。…」—— 片段本身正确，但不是行/句边界。")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n已写入 {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
