"""
build_container.py — 生成一个真实的 .twff 容器，并演示「分级披露」

按 twff/glassbox/components/process_log.py 的 export() 逻辑打包:
    content/document.xhtml    正文
    meta/process-log.json     记录（含 _hash 链）
    meta/manifest.xml         清单
可选（本示例演示第三层）:
    meta/chat-transcript.json AI 会话原文
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import pathlib
import zipfile

DEMO = pathlib.Path(__file__).parent
REPO = DEMO.parent / "twff"

def _load(name: str):
    spec = importlib.util.spec_from_file_location(
        name, REPO / "spec" / "verification" / f"{name}.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


tv = _load("validate_examples")      # 哈希链工具
vf = _load("verify_process_log")     # 独立校验器（实际会用到）

DOC_V1 = """<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>AI and Education</title></head>
<body>
<h1>AI and Education</h1>
<p>Generative AI is transforming education.</p>
<p>The rapid advancement of artificial intelligence has transformed many aspects of learning.</p>
<p>Subsequently, the implementation of neural architectures improved outcomes.</p>
</body></html>"""

# 有人事后偷偷改了一个字：transforming → reshaping
DOC_V2 = DOC_V1.replace("is transforming education", "is reshaping education")

MANIFEST = """<?xml version="1.0" encoding="UTF-8"?>
<manifest>
  <item id="content" href="content/document.xhtml" media-type="application/xhtml+xml"/>
  <item id="log" href="meta/process-log.json" media-type="application/json"/>
</manifest>"""

TRANSCRIPT = {
    "model": "gpt-4o",
    "messages": [
        {"role": "user", "content": "Improve this paragraph."},
        {"role": "assistant", "content": "Subsequently, the implementation of "
         "neural architectures improved outcomes."},
    ],
}


def load_chained() -> dict:
    return json.loads((DEMO / "02-v0.2-chained.json").read_text(encoding="utf-8"))


def build(path: pathlib.Path, doc: str, log: dict, with_transcript: bool,
          with_signatures: bool = False) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("content/document.xhtml", doc)
        zf.writestr("meta/process-log.json", json.dumps(log, indent=2, ensure_ascii=False))
        zf.writestr("meta/manifest.xml", MANIFEST)
        if with_transcript:
            zf.writestr("meta/chat-transcript.json",
                        json.dumps(TRANSCRIPT, indent=2, ensure_ascii=False))
        if with_signatures:
            zf.writestr("META-INF/signatures.xml", "<signatures/>  <!-- 占位：v1.5+ -->")
    print(f"  built: {path.name}  ({path.stat().st_size} bytes)")


def main() -> None:
    log = load_chained()

    # ① 完整容器：内容 + 记录 + 清单
    build(DEMO / "full.twff", DOC_V1, log, with_transcript=False)

    # ② 审计层：加 AI 会话原文 + 签名占位
    build(DEMO / "audit.twff", DOC_V1, log, with_transcript=True, with_signatures=True)

    # ③ 研究层：只交 JSON，不交正文
    (DEMO / "research-only.process-log.json").write_text(
        json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  built: research-only.process-log.json")

    # ④ 攻击演示：换掉正文，记录原封不动
    build(DEMO / "swap.twff", DOC_V2, log, with_transcript=False)

    # 对比两个容器里记录的完整性
    print("\n  记录侧校验（两个容器里的 process-log.json）:")
    for name in ("full.twff", "swap.twff"):
        with zipfile.ZipFile(DEMO / name) as zf:
            inner = json.loads(zf.read("meta/process-log.json").decode("utf-8"))
        ok, detail = vf.verify_process_log(inner)
        print(f"    {name:12} 哈希链: {'✅ 完好' if ok else '❌ 损坏'}  {detail}")

    # 正文差异 —— 但记录里没有任何字段指向正文
    with zipfile.ZipFile(DEMO / "full.twff") as zf:
        a = zf.read("content/document.xhtml").decode("utf-8")
    with zipfile.ZipFile(DEMO / "swap.twff") as zf:
        b = zf.read("content/document.xhtml").decode("utf-8")
    print(f"\n  正文 SHA-256:")
    print(f"    full.twff : {hashlib.sha256(a.encode()).hexdigest()}")
    print(f"    swap.twff : {hashlib.sha256(b.encode()).hexdigest()}")
    print(f"    两篇正文不同: {a != b}")
    print(f"    记录里是否存了正文 hash: "
          f"{'YES' if 'document_hash' in json.dumps(log) else 'NO ← 这就是缺口'}")


if __name__ == "__main__":
    main()
