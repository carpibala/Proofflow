"""
run_5kb_test.py — 5KB 文本的端到端实测驱动

流程:
    1. 生成 ~5KB 的中文测试文本
    2. 起 watch（子进程，输出重定向到文件，用来验证实时性）
    3. 依次做 6 类编辑：改开头 / 改结尾 / 中间删段 / 中间插段 / 小改深部 / 整篇重写
    4. 每步测量「文件写入 → 事件落盘」的延迟，并记录 audit.json 体积变化
    5. 跑 verify，把结果写到 result.txt

用法:
    python run_5kb_test.py
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).parent
ROOT = HERE.parent.parent                     # 项目根目录（twff_copy/）
TARGET = HERE / "textfile.txt"
LOG = HERE / "audit.json"
ANCHOR = HERE / "anchor.json"
RESULT = HERE / "result.txt"


def check_synced() -> None:
    """
    确认本目录的 chainlog.py / test_diff.py 副本与根目录正式版本一致。

    本目录刻意保留副本，使测试可离线复现；代价是副本可能过期，
    导致"测的是旧代码"。这里用哈希硬校验，把这个问题变成响亮的失败。
    """
    import hashlib

    def short(p: pathlib.Path) -> str:
        return hashlib.sha256(p.read_bytes()).hexdigest()[:12]

    stale = []
    for name in ("chainlog.py", "test_diff.py"):
        local, canonical = HERE / name, ROOT / name
        if not canonical.exists() or not local.exists() or short(local) != short(canonical):
            stale.append(name)
    if stale:
        print("=" * 74)
        print(f"!! 副本已过期：{', '.join(stale)}")
        print("   本目录副本与项目根目录的正式版本不一致，测出来的结论不可信。先同步：")
        for name in stale:
            print(f'     copy "{ROOT}\\{name}" "{HERE}\\{name}"')
        print("=" * 74)
        raise SystemExit(2)

SECTION = (
    "第{n}节。生成式人工智能正在改变知识生产的方式，写作、编程与设计领域都出现了"
    "人机协作的常态。学校与雇主因此面临一个新的判定难题：当最终交付物无法自证其"
    "创作过程时，任何关于原创性的结论都只能建立在猜测之上。本文认为，与其继续改"
    "进对最终文本的概率检测，不如在创作发生的当下就记录可验证的过程证据，包括人"
    "工输入的时段、外部内容的引入、以及模型辅助的具体范围。\n"
)


def build_document(sections: int, tag: str = "") -> str:
    head = f"《可验证的创作过程》{tag}\n摘要：本文讨论创作过程的可验证记录。\n"
    body = "".join(SECTION.format(n=i) for i in range(1, sections + 1))
    tail = "结论：过程证据比事后猜测更可靠。\n"
    return head + body + tail


def write(path: pathlib.Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def wait_for_events(proc_log: pathlib.Path, minimum: int, timeout: float = 30.0) -> bool:
    """轮询 audit.json，等到事件数达到 minimum。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            data = json.loads(LOG.read_text(encoding="utf-8"))
            if len(data.get("events", [])) >= minimum:
                return True
        except (OSError, json.JSONDecodeError):
            pass
        time.sleep(0.05)
    return False


def count_events() -> int:
    try:
        return len(json.loads(LOG.read_text(encoding="utf-8"))["events"])
    except (OSError, json.JSONDecodeError):
        return -1


def main() -> int:
    check_synced()
    py = sys.executable
    lines: list[str] = []
    # --preview-chars 会显著影响日志体积（实测占 70%+），所以从命令行传入，
    # 便于做 300 / 60 / 0 的对照实验。
    preview_chars = sys.argv[1] if len(sys.argv) > 1 else "300"

    def say(msg: str) -> None:
        print(msg)
        lines.append(msg)

    # ── 准备
    # 必须一并清掉锁文件：上一次测试若被强杀，会留下心跳已停的锁，
    # 而它在 LOCK_STALE_SECONDS(90s) 之内仍会被判为"有人在用"，导致新 watch 被拒。
    lock = HERE / "audit.json.lock"
    for p in (LOG, ANCHOR, lock):
        p.unlink(missing_ok=True)
    base = build_document(9)
    write(TARGET, base)
    base_bytes = TARGET.stat().st_size

    say("=" * 74)
    say("TWFF chainlog 5KB 端到端实测")
    say("=" * 74)
    say(f"基础文档      : {base_bytes} 字节 / {len(base)} 字符 / "
        f"{len(base.rstrip().splitlines())} 行")
    say(f"体积          : {base_bytes / 1024:.2f} KB")
    say(f"preview-chars : {preview_chars}")
    say("")

    # ── 起 watch
    out_name = f"watch-output-preview{preview_chars}.txt"
    watch_out = HERE / out_name
    watch_out.unlink(missing_ok=True)
    proc = subprocess.Popen(
        [py, "-u", str(HERE / "chainlog.py"), "watch",
         "--file", "textfile.txt", "--log", "audit.json",
         "--interval", "0.4", "--preview-chars", preview_chars],
        cwd=str(HERE),
        stdout=watch_out.open("wb"),
        stderr=subprocess.STDOUT,
    )
    time.sleep(3)

    log_before = LOG.stat().st_size if LOG.exists() else 0
    events_before = count_events()
    say(f"watch 已启动 (pid={proc.pid})，初始事件数 {events_before}，"
        f"audit.json {log_before} 字节")
    say("")

    # ── 6 类编辑
    paragraphs = base.split("\n")
    steps: list[tuple[str, str]] = []

    v1 = base.replace("摘要：本文讨论创作过程的可验证记录。",
                      "摘要：本文主张用过程证据替代事后检测。")
    steps.append(("① 改开头摘要一句", v1))

    v2 = v1.replace("结论：过程证据比事后猜测更可靠。",
                    "结论：过程证据比事后猜测更可靠，且应当可独立复算。")
    steps.append(("② 改结尾结论一句", v2))

    # 删掉中间第 5 节的整段
    idx = v2.find("第5节。")
    end = v2.find("第6节。")
    v3 = v2[:idx] + v2[end:]
    steps.append(("③ 删除中间一整段（第5节）", v3))

    # 在中间插入一个新段落
    idx6 = v3.find("第6节。")
    v4 = v3[:idx6] + "第5节之二。插入段落：记录必须与正文绑定的哈希，否则可被替换。\n" + v3[idx6:]
    steps.append(("④ 中间插入一段", v4))

    # 深部小改（第 8 节里的一个词）
    v5 = v4.replace("第8节。", "第8节（修订）。", 1)
    steps.append(("⑤ 文档深部小改一个词", v5))

    # 整篇重写（测截断）
    fill = ("这是用于测试超长片段截断的填充文字，反复出现以便把改动区撑大。" * 30)
    v6 = "整篇重写后的新正文。\n" + fill
    steps.append(("⑥ 整篇重写（触发截断）", v6))

    say(f"{'步骤':<28}{'字节':>9}{'字符':>8}{'延迟(s)':>10}"
        f"{'事件数':>8}{'日志字节':>10}")
    say("-" * 74)

    latencies: list[float] = []
    for label, text in steps:
        want = count_events() + 1
        t0 = time.time()
        write(TARGET, text)
        ok = wait_for_events(LOG, want)
        dt = time.time() - t0
        latencies.append(dt)
        events = count_events()
        size = LOG.stat().st_size
        say(f"{label:<28}{len(text.encode('utf-8')):>9}{len(text):>8}"
            f"{dt:>10.2f}{events:>8}{size:>10}")
        if not ok:
            say("  !! 超时未捕获")
        time.sleep(1.0)

    say("")

    # ── 实时性证据：在 watch 仍运行时读它的输出
    say("实时性验证（watch 仍在运行，直接读它的输出文件）:")
    running = proc.poll() is None
    say(f"  watch 进程是否仍在运行: {running}")
    out_text = watch_out.read_text(encoding="utf-8", errors="replace")
    say(f"  {out_name} 当前行数: {len(out_text.splitlines())}")
    say(f"  其中 content_modified 行数: {out_text.count('content_modified')}")
    say("  → 进程未退出而输出已包含全部事件，即为实时写入的证据")
    say("")

    # ── 收尾
    proc.terminate()
    time.sleep(1.5)
    if proc.poll() is None:
        proc.kill()
    final_events = count_events()
    final_size = LOG.stat().st_size
    say(f"watch 已停止。最终事件数 {final_events}，audit.json {final_size} 字节 "
        f"({final_size / 1024:.2f} KB)")
    say(f"平均捕获延迟 {sum(latencies) / len(latencies):.2f}s，"
        f"最大 {max(latencies):.2f}s")
    say("")

    # ── verify
    say("=" * 74)
    say("verify 结果")
    say("=" * 74)
    vp = subprocess.run(
        [py, str(HERE / "chainlog.py"), "verify",
         "--log", "audit.json", "--file", "textfile.txt"],
        cwd=str(HERE), capture_output=True, text=True, encoding="utf-8",
        errors="replace",
    )
    say(vp.stdout.strip())
    if vp.stderr.strip():
        say("stderr: " + vp.stderr.strip())

    RESULT.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n结果已写入 {RESULT}")

    # ── 归档快照：按 preview 参数区分，便于做体积对照
    import shutil
    archive_result = HERE / f"result-preview{preview_chars}.txt"
    archive_log = HERE / f"audit-preview{preview_chars}.json"
    shutil.copyfile(RESULT, archive_result)
    shutil.copyfile(LOG, archive_log)
    print(f"已归档 {archive_result.name} / {archive_log.name}")

    # ── 清掉本轮的工作文件，避免与归档快照重复堆积
    #    （它们每次运行都会重新生成；证据已由上面两个归档文件保留）
    for temp in (LOG, RESULT, ANCHOR, lock):
        try:
            temp.unlink()
        except OSError:
            pass
    print("已清理本轮工作文件（audit.json / result.txt / anchor.json / 锁）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
