# -*- coding: utf-8 -*-
"""
doc-to-image.py — Office/PDF 逐页转 PNG 渲染脚本（由 DSH document_to_image 工具调用）。

完整链路:
  .pdf                       ──直接──► PyMuPDF(fitz) 逐页渲染 PNG
  .docx/.doc/.xlsx/.xls/.pptx/.ppt ──► LibreOffice(soffice) headless 转 PDF ──► fitz 渲染 PNG

用法（argv）:
  python doc-to-image.py <input> <out_dir> <prefix> <dpi> <max_pages>

  <input>      源文档的绝对本地路径（pdf 或 office 文件；Node 侧已落盘）。
  <out_dir>    输出目录（已存在；PNG 写到这里）。
  <prefix>     PNG 文件名前缀，输出形如 <out_dir>/<prefix>_<i>.png，i 从 1 起。
  <dpi>        渲染分辨率（72..300，默认 150）。
  <max_pages>  最多渲染前 N 页（默认 50）。

输出:
  stdout 打印一行 JSON:
    {"pages": [{"path": "...", "width": 888, "height": 1258, "bytes": 123456}], "page_count": 42, "truncated": false}

  page_count 是文档实际总页数；pages 只含实际渲染的（<= max_pages）页面。
  任何错误以非零退出码 + stderr 信息返回。

soffice 可执行路径:
  优先读环境变量 DSH_SOFFICE；未设置则用默认
  C:/Program Files/LibreOffice/program/soffice.exe，并通过 glob 兜底大小写
  （实际 Windows 安装是 "Program"/"program" 小写目录）。soffice 缺失时报清晰错误。
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile

# ---- 常量 ------------------------------------------------------------------

SUPPORTED_EXTS = {".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"}
OFFICE_EXTS = SUPPORTED_EXTS - {".pdf"}
DEFAULT_SOFFICE = r"C:/Program Files/LibreOffice/program/soffice.exe"
SOFFICE_CANDIDATES = (
    "C:/Program Files/LibreOffice/program/soffice.exe",
    "C:/Program Files/LibreOffice/Program/soffice.exe",
    "C:/Program Files (x86)/LibreOffice/program/soffice.exe",
    "C:/Program Files (x86)/LibreOffice/Program/soffice.exe",
)


def find_soffice():
    """返回可用的 soffice 可执行路径，找不到返回 None。glob 兜底大小写差异。"""
    env = os.environ.get("DSH_SOFFICE", "").strip()
    if env:
        if os.path.exists(env):
            return env
        # 环境变量指了但不存在 -> 继续往下，但先尝试把它的上级目录 glob 一下
        pattern = os.path.join(os.path.dirname(env), "soffice.exe")
        for hit in glob.glob(pattern):
            return hit
    for cand in SOFFICE_CANDIDATES:
        if os.path.exists(cand):
            return cand
    # 大小写兜底：在标准根目录里找 program* / Program* 下的 soffice.exe
    for base in ("C:/Program Files/LibreOffice", "C:/Program Files (x86)/LibreOffice"):
        for sub in ("program", "Program", "PROGRAM", "Program Files"):
            p = os.path.join(base, sub, "soffice.exe")
            if os.path.exists(p):
                return p
    return None


def soffice_to_pdf(src, out_dir, soffice, timeout_s=120):
    """headless 把 office 文件转成 pdf，返回 pdf 路径。带独立 UserInstallation profile 避免锁冲突。"""
    profile_dir = os.path.join(out_dir, ".lo_profile")
    os.makedirs(profile_dir, exist_ok=True)
    profile_uri = "file:///" + profile_dir.replace("\\", "/")
    cmd = [
        soffice,
        "--headless",
        "--norestore",
        "--nofirststartwizard",
        "-env:UserInstallation=" + profile_uri,
        "--convert-to", "pdf",
        "--outdir", out_dir,
        src,
    ]
    # soffice 不开管道，capture_output 会乖乖返回；timeout 兜底防挂起。
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
    base = os.path.splitext(os.path.basename(src))[0]
    pdf_path = os.path.join(out_dir, base + ".pdf")
    if not os.path.exists(pdf_path):
        msg = "soffice 未产出 pdf"
        if proc.stderr and proc.stderr.strip():
            msg += ": " + proc.stderr.strip()[-500:]
        raise RuntimeError(msg)
    return pdf_path


def render_pdf(pdf_path, out_dir, prefix, dpi, max_pages):
    """用 fitz 把 pdf 逐页渲染成 PNG，返回 (pages:list[dict], page_count:int, truncated:bool)。"""
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    total = doc.page_count
    n = min(total, max_pages)
    pages = []
    for i in range(n):
        pix = doc[i].get_pixmap(dpi=dpi)
        p = os.path.join(out_dir, "{}_{}.png".format(prefix, i + 1))
        pix.save(p)
        size = os.path.getsize(p)
        pages.append({
            "path": p,
            "width": pix.width,
            "height": pix.height,
            "bytes": size,
            "index": i + 1,
        })
    truncated = total > max_pages
    return pages, total, truncated


def main(argv):
    if len(argv) < 5:
        print(json.dumps({"error": "usage: doc-to-image.py <input> <out_dir> <prefix> <dpi> <max_pages>"}))
        return 2

    src, out_dir, prefix = argv[0], argv[1], argv[2]
    dpi = int(argv[3])
    max_pages = int(argv[4])

    if not os.path.exists(src):
        print(json.dumps({"error": "input file not found: {}".format(src)}))
        return 1

    ext = os.path.splitext(src)[1].lower()
    if ext not in SUPPORTED_EXTS:
        print(json.dumps({"error": "unsupported extension '{}' (supported: {})".format(
            ext, ", ".join(sorted(SUPPORTED_EXTS)))}))
        return 1

    os.makedirs(out_dir, exist_ok=True)

    # 1) 得到待渲染的 pdf 路径。
    pdf_path = None
    tmp_dir = None
    if ext == ".pdf":
        pdf_path = src
    else:
        soffice = find_soffice()
        if not soffice:
            print(json.dumps({"error": "LibreOffice(soffice) 未找到。请安装 LibreOffice，或设置环境变量 "
                                        "DSH_SOFFICE 指向 soffice.exe 的可执行路径。"}))
            return 1
        # 独立临时目录放中间 pdf，避免多个同 base 文件互覆盖。
        tmp_dir = tempfile.mkdtemp(prefix="lo_pdf_", dir=out_dir)
        try:
            pdf_path = soffice_to_pdf(src, tmp_dir, soffice)
        except subprocess.TimeoutExpired:
            print(json.dumps({"error": "soffice 转换超时（>120s），请检查文档是否损坏或过大。"}))
            return 1
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"error": "soffice 转换失败: {}".format(e)}))
            return 1

    # 2) fitz 渲染。
    try:
        pages, page_count, truncated = render_pdf(pdf_path, out_dir, prefix, dpi, max_pages)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": "pdf 渲染失败: {}".format(e)}))
        return 1
    finally:
        # 清理中间 pdf 临时目录（保留最终 PNG）。
        if tmp_dir and os.path.isdir(tmp_dir):
            shutil.rmtree(tmp_dir, ignore_errors=True)

    print(json.dumps({
        "pages": pages,
        "page_count": page_count,
        "truncated": truncated,
        "input": os.path.basename(src),
        "out_dir": out_dir,
    }))
    return 0


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception as e:  # 顶层兜底：任何未捕获异常都以 JSON error 传出
        print(json.dumps({"error": "unexpected: {}".format(e)}))
        code = 1
    sys.exit(code)
