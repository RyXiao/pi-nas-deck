#!/usr/bin/env python3
"""pdf → markdown 文本提取（PiNasDeck 服务端转换器）。

用法: pdf2md.py <input.pdf> <output.md> [max_pages]

目的：让 agent 只读文本而不是按页截图喂视觉模型——token 成本降一个数量级。
优先 pdfplumber（版面还原更好），缺库回退 pypdf（镜像 venv 两者都装了）。
产物 = 开头一段来源说明 + 按页分节的纯文本；stdout 输出 JSON 元信息。
图表/扫描页可能提取不出文本，产物头部会提示按需查原 PDF。
"""
import json
import sys


def extract_pages(path, max_pages):
    try:
        import pdfplumber

        with pdfplumber.open(path) as pdf:
            total = len(pdf.pages)
            pages = []
            for i, page in enumerate(pdf.pages):
                if i >= max_pages:
                    break
                pages.append(page.extract_text() or "")
            return pages, total, "pdfplumber"
    except ImportError:
        pass
    from pypdf import PdfReader

    reader = PdfReader(path)
    total = len(reader.pages)
    pages = []
    for i, page in enumerate(reader.pages):
        if i >= max_pages:
            break
        pages.append(page.extract_text() or "")
    return pages, total, "pypdf"


def to_markdown(pages, source_name, total, engine):
    truncated = total > len(pages)
    header = (
        f"> 本文件由 PiNasDeck 从 `{source_name}` 自动提取（{engine}，共 {total} 页"
        f"{'，超上限已截断' if truncated else ''}，已提取 {len(pages)} 页）。\n"
        f"> 图表/扫描页可能没有文本，需要时再查看原 PDF。\n"
    )
    parts = [header, ""]
    for i, text in enumerate(pages):
        body = text.strip()
        parts.append(f"## 第 {i + 1} 页")
        parts.append("")
        parts.append(body if body else "（本页无可提取文本）")
        parts.append("")
    return "\n".join(parts)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "error": "用法: pdf2md.py <input.pdf> <output.md> [max_pages]"}))
        sys.exit(2)
    pdf_path, md_path = sys.argv[1], sys.argv[2]
    try:
        max_pages = min(int(sys.argv[3]) if len(sys.argv) > 3 else 500, 2000)
    except ValueError:
        max_pages = 500
    try:
        pages, total, engine = extract_pages(pdf_path, max_pages)
    except Exception as error:  # noqa: BLE001 —— 任何解析失败都回 JSON 给调用方
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        sys.exit(1)
    md = to_markdown(pages, pdf_path.replace("\\", "/").split("/")[-1], total, engine)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(md)
    print(json.dumps({"ok": True, "pages": len(pages), "total": total, "engine": engine, "chars": len(md)}))


if __name__ == "__main__":
    main()
