# -*- coding: utf-8 -*-
"""
image-edit.py — 本地修图 / 图像处理后端（由 DSH image_edit 工具调用）。

纯 CPU 轻量实现：核心用 Pillow（PIL），P1/P2 部分用 OpenCV（cv2，可选）；
rembg / rawpy / realesrgan-ncnn-vulkan 均为可选依赖，缺失时对应 action
返回清晰的"请装依赖"提示，而不是崩溃。

使用方式（argv）:
  python image-edit.py <request.json路径>

  <request.json路径>  指向一个 JSON 文件，内容为请求对象（Node 侧已把输入图
                      落盘为真实本地路径，from 域即绝对路径）。

请求对象通用字段:
  action           必填，字符串。见下面 ACTIONS 支持列表。
  from             必填，主输入图绝对路径。
  from_extra       可选，数组，附加输入图绝对路径（composite/stitch 等用）。
  out              必填，输出图绝对路径（含扩展名，决定格式）。
  ...action 专属参数（见各 handle_* 函数）。所有量均需 JSON 数值/字符串。

输出:
  stdout 打印一行 JSON:
    {"ok": true, "out_path": "...", "width": W, "height": H, "bytes": N,
     "format": "PNG", "summary": "...", "extra": {...}}
  或
    {"error": "清晰的中文提示", "action": "..."}
  任何未捕获异常都以 JSON error + 退出码 1 返回。

支持的 action:
  P0: resize, rotate, flip, convert, adjust, blur, sharpen, composite, watermark
  P1: remove_background, edges, equalize_hist, denoise, perspective, stitch, thumbnail
  P2: exif_read, exif_write, raw_convert, upscale, colorspace, morphology
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback


# ---- 图像打开/保存基元（把所有操作收敛到 Pillow，保证格式兼容）----------------

def open_image(path):
    """打开任意支持格式 -> RGBA 或 RGB 的 PIL Image。"""
    from PIL import Image
    im = Image.open(path)
    im.load()
    if "A" in im.getbands():
        return im.convert("RGBA")
    return im.convert("RGB")


def save_image(im, out, action):
    """按 out 扩展名保存，统一转 RGB/RGBA，返回 (width, height, bytes, format)。"""
    from PIL import Image
    ext = os.path.splitext(out)[1].lower()
    # 无损/带透明格式用 RGBA，其余用 RGB（JPEG 不支持 alpha）
    alpha_formats = {".png", ".webp", ".bmp", ".tiff", ".tif", ".gif"}
    if ext in alpha_formats and "A" in im.getbands():
        save_im = im
    else:
        save_im = im.convert("RGB")
    # JPEG/TIFF 需要处理 mode；webp 无动画
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    save_im.save(out)
    fmt = Image.open(out).format or "UNKNOWN"
    return im.width, im.height, os.path.getsize(out), fmt


# ---- P0: 基础变换（纯 Pillow）------------------------------------------------

def handle_resize(req, im):
    width = int(req.get("width", 0))
    height = int(req.get("height", 0))
    if width <= 0 or height <= 0:
        raise ValueError("resize 需要 width 和 height（>0 整数）")
    mode = req.get("mode", "stretch")  # stretch | fit | fill
    keep_ratio = bool(req.get("keep_ratio", False))
    img = im
    if mode == "stretch":
        w, h = width, height
    elif mode == "fit":  # 保持比例放入 width×height 画布，不留边（缩放比例取较小）
        ratio = min(width / im.width, height / im.height)
        w, h = max(1, round(im.width * ratio)), max(1, round(im.height * ratio))
    elif mode == "fill":  # 保持比例裁剪填充到 width×height
        ratio = max(width / im.width, height / im.height)
        w, h = round(im.width * ratio), round(im.height * ratio)
        img = im.resize((w, h), Image_LANCZOS())
        # 居中裁剪
        left = (w - width) // 2
        top = (h - height) // 2
        img = img.crop((left, top, left + width, top + height))
        w, h = width, height
    else:
        raise ValueError("resize mode 只能是 stretch/fit/fill")
    if img is im:
        if keep_ratio and mode == "stretch":
            ratio = min(width / im.width, height / im.height)
            w, h = max(1, round(im.width * ratio)), max(1, round(im.height * ratio))
        img = im.resize((w, h), Image_LANCZOS())
    return img


def Image_LANCZOS():
    from PIL import Image
    return Image.LANCZOS


def handle_rotate(req, im):
    angle = float(req.get("angle", 0))
    expand = bool(req.get("expand", True))
    fill = req.get("fill")  # 支持 "#rrggbb" 或 "255,255,255" 或 "transparent"
    from PIL import Image
    if not expand:
        return im.rotate(angle, expand=False)
    # expand=True 时若带 alpha 直接可旋转；RGB 加画布色
    if "A" in im.getbands():
        return im.rotate(angle, expand=True)
    color = parse_fill(fill) or (0, 0, 0)
    rgba = im.convert("RGBA")
    out = rgba.rotate(angle, expand=True, fillcolor=(*color, 255))
    return out


def parse_fill(fill):
    if not fill:
        return None
    s = str(fill).strip()
    if s.startswith("#") and len(s) == 7:
        try:
            return tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
        except ValueError:
            return None
    parts = [int(x) for x in s.replace(" ", "").split(",") if x != ""]
    if len(parts) == 3:
        return tuple(parts)
    return None


def handle_flip(req, im):
    from PIL import Image
    axis = req.get("axis", "horizontal")
    if axis == "horizontal":
        return im.transpose(Image.FLIP_LEFT_RIGHT)
    if axis == "vertical":
        return im.transpose(Image.FLIP_TOP_BOTTOM)
    if axis == "both":
        return im.transpose(Image.FLIP_LEFT_RIGHT).transpose(Image.FLIP_TOP_BOTTOM)
    raise ValueError("flip axis 只能是 horizontal/vertical/both")


def handle_convert(req, im):
    # 格式由 out 扩展名决定（Pillow 支持 png/jpg/jpeg/webp/bmp/tiff/gif）
    return im


def handle_adjust(req, im):
    from PIL import ImageEnhance
    brightness = float(req.get("brightness", 1.0))
    contrast = float(req.get("contrast", 1.0))
    saturation = float(req.get("saturation", 1.0))
    work = im
    if "A" in im.getbands():
        work = im.convert("RGB")
    if brightness != 1.0:
        work = ImageEnhance.Brightness(work).enhance(brightness)
    if contrast != 1.0:
        work = ImageEnhance.Contrast(work).enhance(contrast)
    if saturation != 1.0:
        work = ImageEnhance.Color(work).enhance(saturation)
    # 恢复 alpha
    if "A" in im.getbands():
        alpha = im.getchannel("A")
        work = work.convert("RGBA")
        work.putalpha(alpha)
    return work


def handle_blur(req, im):
    from PIL import ImageFilter
    blur_type = req.get("type", "gaussian")
    radius = float(req.get("radius", 2.0))
    if blur_type == "box":
        return im.filter(ImageFilter.BoxBlur(max(0.1, radius)))
    if blur_type == "motion":
        return im.filter(ImageFilter.GaussianBlur(max(0.1, radius * 2)))
    return im.filter(ImageFilter.GaussianBlur(max(0.1, radius)))


def handle_sharpen(req, im):
    from PIL import ImageFilter
    radius = float(req.get("radius", 2.0))
    percent = int(req.get("percent", 150))
    threshold = int(req.get("threshold", 3))
    return im.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))


def handle_composite(req, im):
    # 叠加前景图（from_extra[0]）到主图 im 上。
    from PIL import Image
    extra = req.get("from_extra") or []
    if not extra:
        raise ValueError("composite 需要 from_extra[0]（前景/贴图路径）+ from（背景）")
    fg = open_image(extra[0])
    pos = req.get("position", "center")  # 像素 "x,y" 或 宏
    alpha = float(req.get("alpha", 1.0))
    bg = im.convert("RGBA")
    x, y = resolve_position(bg, fg, pos)
    if alpha < 1.0:
        fg = fg.copy()
        if "A" in fg.getbands():
            a = fg.getchannel("A").point(lambda v: round(v * alpha))
            fg.putalpha(a)
        else:
            fg = fg.convert("RGBA")
            fg.putalpha(Image.new("L", fg.size, int(alpha * 255)))
    bg.alpha_composite(fg, (x, y))
    return bg


def resolve_position(bg, fg, pos):
    s = str(pos).strip().lower()
    if "," in s:
        parts = [int(x.strip()) for x in s.split(",") if x.strip() != ""]
        if len(parts) == 2:
            return parts[0], parts[1]
    if s == "center":
        return (bg.width - fg.width) // 2, (bg.height - fg.height) // 2
    if s == "top_left":
        return 0, 0
    if s == "top_right":
        return bg.width - fg.width, 0
    if s == "bottom_left":
        return 0, bg.height - fg.height
    if s == "bottom_right":
        return bg.width - fg.width, bg.height - fg.height
    if s == "top_center":
        return (bg.width - fg.width) // 2, 0
    if s == "bottom_center":
        return (bg.width - fg.width) // 2, bg.height - fg.height
    raise ValueError("composite position 未知: " + pos)


def handle_watermark(req, im):
    # 支持图片水印（from_extra[0]）或文字水印（text）。
    from PIL import Image, ImageDraw, ImageFont
    wtype = req.get("type", "text")
    pos = req.get("position", "bottom_right")
    alpha = float(req.get("alpha", 0.6))
    bg = im.convert("RGBA")
    overlay = Image.new("RGBA", bg.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    if wtype == "image":
        extra = req.get("from_extra") or []
        if not extra:
            raise ValueError("watermark(image) 需要 from_extra[0] 指向水印图片")
        wm = open_image(extra[0])
        x, y = resolve_position(bg, wm, pos)
        if alpha < 1.0:
            if "A" in wm.getbands():
                wm.putalpha(wm.getchannel("A").point(lambda v: round(v * alpha)))
            else:
                wm = wm.convert("RGBA")
                wm.putalpha(Image.new("L", wm.size, int(alpha * 255)))
        overlay.alpha_composite(wm, (x, y))
    else:
        text = str(req.get("text", ""))
        if not text:
            raise ValueError("watermark(text) 需要 text")
        size = int(req.get("font_size", 36))
        font = load_font(size)
        # 粗略测文本尺寸
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if pos == "center":
            x, y = (bg.width - tw) // 2, (bg.height - th) // 2
        elif pos == "top_left":
            x, y = 10, 10
        elif pos == "top_right":
            x, y = bg.width - tw - 10, 10
        elif pos == "bottom_left":
            x, y = 10, bg.height - th - 10
        else:
            x, y = bg.width - tw - 10, bg.height - th - 10
        color = parse_fill(req.get("color", "#ffffff")) or (255, 255, 255)
        draw.text((x, y), text, font=font, fill=(*color, int(alpha * 255)))
    bg.alpha_composite(overlay)
    return bg


def load_font(size):
    from PIL import ImageFont
    candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/msyhbd.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                continue
    try:
        return ImageFont.truetype("DejaVuSans.ttf", size)
    except Exception:
        return ImageFont.load_default()


def handle_thumbnail(req, im):
    from PIL import Image
    max_w = int(req.get("width", 256))
    max_h = int(req.get("height", 256))
    copy = im.copy()
    copy.thumbnail((max_w, max_h), Image.LANCZOS)
    return copy


# ---- P1: 进阶（OpenCV / rembg）-----------------------------------------------

def get_cv2():
    try:
        import cv2  # noqa
        return cv2
    except Exception as e:
        raise RuntimeError(
            "该操作需要 OpenCV。请先运行 `node scripts/setup-image-venv.mjs` 安装 "
            "opencv-python-headless（缺失原因: %s）" % e
        )


def handle_edges(req, im):
    cv2 = get_cv2()
    import numpy as np
    low = int(req.get("low", 100))
    high = int(req.get("high", 200))
    gray_pil = im.convert("L")
    arr = np.array(gray_pil)
    edges = cv2.Canny(arr, low, high)
    from PIL import Image
    return Image.fromarray(edges).convert("RGB")


def handle_equalize_hist(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    mode = req.get("mode", "auto")  # auto | clahe
    # 转灰度或彩色。彩色：对亮度通道做 CLAHE 再合并，保留色彩。
    if "A" in im.getbands():
        rgba = im.convert("RGBA")
        rgb = rgba.convert("RGB")
        alpha = rgba.getchannel("A")
    else:
        rgb = im.convert("RGB")
        alpha = None
    arr = np.array(rgb)
    if mode == "clahe":
        lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB)
        l, a, b = cv2.split(lab)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        l = clahe.apply(l)
        lab = cv2.merge((l, a, b))
        out = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB)
    else:
        hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
        h, s, v = cv2.split(hsv)
        v = cv2.equalizeHist(v)
        hsv = cv2.merge((h, s, v))
        out = cv2.cvtColor(hsv, cv2.COLOR_HSV2RGB)
    out_pil = Image.fromarray(out).convert("RGB")
    if alpha is not None:
        out_pil = out_pil.convert("RGBA")
        out_pil.putalpha(alpha)
    return out_pil


def handle_denoise(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    strength = float(req.get("strength", 10.0))
    rgba = im.convert("RGBA")
    rgb = rgba.convert("RGB")
    alpha = rgba.getchannel("A")
    bgr = cv2.cvtColor(np.array(rgb), cv2.COLOR_RGB2BGR)
    denoised = cv2.fastNlMeansDenoisingColored(bgr, None, strength, strength, 7, 21)
    out = cv2.cvtColor(denoised, cv2.COLOR_BGR2RGB)
    out_pil = Image.fromarray(out).convert("RGBA")
    out_pil.putalpha(alpha)
    return out_pil


def handle_perspective(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    pts = req.get("points")  # 4 点：从左上逆时针 [x1,y1,x2,y2,...]
    if not pts or len(pts) != 8:
        raise ValueError("perspective 需要 points（8 个数，从左上起顺时针/逆时针 4 点）")
    src = np.float32([[pts[0], pts[1]], [pts[2], pts[3]], [pts[4], pts[5]], [pts[6], pts[7]]])
    w = int(req.get("width", im.width))
    h = int(req.get("height", im.height))
    dst = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    arr = np.array(im.convert("RGB"))
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(bgr, M, (w, h))
    out = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB)
    return Image.fromarray(out)


def handle_stitch(req, im):
    from PIL import Image
    extras = (req.get("from_extra") or [])
    if not extras:
        raise ValueError("stitch 至少需要 from + from_extra[0] 两张图")
    direction = req.get("direction", "horizontal")
    imgs = [im] + [open_image(e).convert("RGBA") for e in extras]
    if req.get("mode", "resize") == "same_height" and direction == "horizontal":
        h = max(x.height for x in imgs)
        imgs = [x.resize((max(1, round(x.width * h / x.height)), h), Image_LANCZOS()) for x in imgs]
        total_w = sum(x.width for x in imgs)
        canvas = Image.new("RGBA", (total_w, h), (0, 0, 0, 0))
        cx = 0
        for x in imgs:
            canvas.alpha_composite(x, (cx, 0))
            cx += x.width
        return canvas
    if direction == "horizontal":
        w = max(x.width for x in imgs)
        h = sum(x.height for x in imgs)
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        cy = 0
        for x in imgs:
            canvas.alpha_composite(x, (0, cy))
            cy += x.height
        return canvas
    else:
        w = sum(x.width for x in imgs)
        h = max(x.height for x in imgs)
        canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        cx = 0
        for x in imgs:
            canvas.alpha_composite(x, (cx, 0))
            cx += x.width
        return canvas


def handle_remove_background(req, im):
    try:
        from rembg import remove
    except Exception as e:
        raise RuntimeError(
            "背景移除需要 rembg（基于 U²-Net，约 35MB，CPU 可跑）。请先运行 "
            "`node scripts/setup-image-venv.mjs`（会安装 rembg；缺失原因: %s）" % e
        )
    rgba = im.convert("RGBA")
    out = remove(rgba, post_process_mask=bool(req.get("post_process", False)))
    return out.convert("RGBA")


# ---- P2: 可选高级 -----------------------------------------------------------

def handle_exif_read(req, im):
    exif = im.getexif()
    fields = {}
    for tag_id, value in exif.items():
        name = EXIF_TAGS.get(tag_id, str(tag_id))
        # 压缩字节值仅保留摘要，避免超长 JSON
        if isinstance(value, bytes) and len(value) > 200:
            value = "<%d bytes>" % len(value)
        fields[name] = str(value)
    # Photo 标签的嵌套
    try:
        if hasattr(exif, "get_ifd"):
            for ifd in (0x8825, 0x927C):  # GPS, MakerNote
                sub = exif.get_ifd(ifd)
                for tag_id, value in sub.items():
                    fields["%s:%s" % (ifd, tag_id)] = str(value)
    except Exception:
        pass
    return im, {"exif": fields}


def handle_exif_write(req, im):
    # 基础 EXIF：写入用户提供的键值（覆盖打印字段）。使用 Pillow 原生 getexif 改写。
    im_with_exif = im.copy()
    exif = im_with_exif.getexif()
    kv = req.get("fields")
    for k, v in (kv or {}).items():
        try:
            tag = int(k) if str(k).isdigit() else EXIF_TAGS_REV.get(k)
            if tag is not None:
                exif[tag] = v
        except Exception:
            continue
    return im_with_exif


def handle_raw_convert(req, im):
    try:
        import rawpy
    except Exception as e:
        raise RuntimeError("RAW 处理需要 rawpy（基于 libraw）。先运行 `node scripts/setup-image-venv.mjs` 安装 rawpy（缺失: %s）" % e)
    src = req["from"]
    raw = rawpy.imread(src)
    try:
        rgb = raw.postprocess(use_camera_wb=bool(req.get("camera_wb", True)))
    finally:
        raw.close()
    from PIL import Image
    return Image.fromarray(rgb)


def handle_upscale(req, im):
    # 轻量超分：优先 realesrgan-ncnn-vulkan CLI（外部可执行文件，非本 venv）。
    exe = os.environ.get("DSH_REALESRGAN_EXE", "realesrgan-ncnn-vulkan")
    if shutil.which(exe) is None and not os.path.exists(exe):
        raise RuntimeError(
            "超分需要外部 CLI realesrgan-ncnn-vulkan（Vulkan 推理，无需 PyTorch）。"
            "请下载后设置环境变量 DSH_REALESRGAN_EXE 指向可执行文件。"
        )
    scale = int(req.get("scale", 2))
    src = req["from"]
    tmp = tempfile.mkdtemp(prefix="realesrgan_")
    try:
        # realesrgan-ncnn-vulkan 只输出 png，放到临时目录
        out_png = os.path.join(tmp, "sr.png")
        env = dict(os.environ)
        cmd = [exe, "-i", src, "-o", out_png, "-s", str(scale)]
        if req.get("model"):
            cmd += ["-m", str(req["model"])]
        if req.get("n"):
            cmd += ["-n", str(req["n"])]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=env)
        if proc.returncode != 0 or not os.path.exists(out_png):
            raise RuntimeError("realesrgan 失败: " + (proc.stderr or proc.stdout or "")[-400:])
        return open_image(out_png)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def handle_colorspace(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    target = req.get("target", "rgb").lower()
    rgb_arr = np.array(im.convert("RGB"))
    if target in ("hsv", "hsl"):
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2HSV)
        # 缩放到 0-255 便于存储
        h, s, v = out[:, :, 0] / 2, out[:, :, 1], out[:, :, 2]
        out = np.stack([h, s, v], axis=-1).astype(np.uint8)
    elif target == "lab":
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2LAB)
    elif target == "gray":
        out = cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2GRAY)
        return Image.fromarray(out).convert("L")
    elif target == "cmyk":
        cmyk = im.convert("RGB").convert("CMYK")
        return cmyk
    else:
        raise ValueError("colorspace target 只能是 rgb/hsv/lab/gray/cmyk")
    return Image.fromarray(out)


def handle_morphology(req, im):
    cv2 = get_cv2()
    import numpy as np
    from PIL import Image
    op = req.get("op", "erode").lower()
    size = int(req.get("size", 3))
    ops = {
        "erode": cv2.MORPH_ERODE,
        "dilate": cv2.MORPH_DILATE,
        "open": cv2.MORPH_OPEN,
        "close": cv2.MORPH_CLOSE,
        "gradient": cv2.MORPH_GRADIENT,
    }
    if op not in ops:
        raise ValueError("morphology op 只能是 erode/dilate/open/close/gradient")
    gray = np.array(im.convert("L"))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (size, size))
    out = cv2.morphologyEx(gray, ops[op], kernel)
    return Image.fromarray(out).convert("RGB")


# ---- EXIF 标签映射（常用）----------------------------------------------------

EXIF_TAGS = {
    0x010F: "Make", 0x0110: "Model", 0x0112: "Orientation", 0x0132: "DateTime",
    0x013B: "Artist", 0x01EA: "Photographer", 0x0827: "Comments",
    0x829A: "ExposureTime", 0x829D: "FNumber", 0x8827: "ISOSpeedRatings",
    0x9201: "ShutterSpeed", 0x9202: "Aperture", 0x9209: "Flash",
    0x920A: "FocalLength", 0x9003: "DateTimeOriginal", 0x9004: "DateTimeDigitized",
}
EXIF_TAGS_REV = {v: k for k, v in EXIF_TAGS.items()}


# ---- 分发 ---------------------------------------------------------------

P0 = {
    "resize": handle_resize, "rotate": handle_rotate, "flip": handle_flip,
    "convert": handle_convert, "adjust": handle_adjust, "blur": handle_blur,
    "sharpen": handle_sharpen, "composite": handle_composite,
    "watermark": handle_watermark, "thumbnail": handle_thumbnail,
}
P1 = {
    "edges": handle_edges, "equalize_hist": handle_equalize_hist,
    "denoise": handle_denoise, "perspective": handle_perspective,
    "stitch": handle_stitch, "remove_background": handle_remove_background,
}
P2 = {
    "exif_read": handle_exif_read, "exif_write": handle_exif_write,
    "raw_convert": handle_raw_convert, "upscale": handle_upscale,
    "colorspace": handle_colorspace, "morphology": handle_morphology,
}
ACTIONS = {**P0, **P1, **P2}
ACTIVITY = {
    "resize": "P0 基础变换", "rotate": "P0 基础变换", "flip": "P0 基础变换",
    "convert": "P0 基础变换", "adjust": "P0 基础变换", "blur": "P0 基础变换",
    "sharpen": "P0 基础变换", "composite": "P0 基础变换", "watermark": "P0 基础变换",
    "thumbnail": "P0 基础变换", "edges": "P1 进阶", "equalize_hist": "P1 进阶",
    "denoise": "P1 进阶", "perspective": "P1 进阶", "stitch": "P1 进阶",
    "remove_background": "P1 进阶", "exif_read": "P2 高级", "exif_write": "P2 高级",
    "raw_convert": "P2 高级", "upscale": "P2 高级", "colorspace": "P2 高级",
    "morphology": "P2 高级",
}


def main(argv):
    if len(argv) < 1:
        print(json.dumps({"error": "usage: image-edit.py <request.json路径>"}))
        return 2
    req_path = argv[0]
    if not os.path.exists(req_path):
        print(json.dumps({"error": "request file not found: %s" % req_path}))
        return 1
    with open(req_path, "r", encoding="utf-8") as f:
        req = json.load(f)

    action = req.get("action")
    if not action or action not in ACTIONS:
        print(json.dumps({"error": "未知 action '%s'（支持: %s）" % (action, ", ".join(sorted(ACTIONS)))}))
        return 1

    src = req.get("from")
    out = req.get("out")
    if not src or not os.path.exists(src):
        print(json.dumps({"error": "输入文件不存在: %s" % src, "action": action}))
        return 1
    if not out:
        print(json.dumps({"error": "需要 out（输出路径）", "action": action}))
        return 1

    try:
        if action == "raw_convert":
            im = None
            result = handle_raw_convert(req, None)
            width, height, bytes_n, fmt = save_image(result, out, action)
        elif action == "exif_read":
            im = open_image(src)
            result, extra = handle_exif_read(req, im)
            width, height = result.width, result.height
            bytes_n = os.path.getsize(out) if os.path.exists(out) else None
            fmt = None
            # exif_read 不改文件，直接输出 exif 信息
            print(json.dumps({
                "ok": True, "out_path": None, "width": result.width, "height": result.height,
                "bytes": 0, "format": None, "summary": "读取了 %d 个 EXIF 字段" % len(extra.get("exif", {})),
                "action": action, "extra": extra,
            }))
            return 0
        elif action == "exif_write":
            im = open_image(src)
            result = handle_exif_write(req, im)
            width, height, bytes_n, fmt = save_image(result, out, action)
        else:
            im = open_image(src)
            result = ACTIONS[action](req, im)
            width, height, bytes_n, fmt = save_image(result, out, action)

        print(json.dumps({
            "ok": True, "out_path": out, "width": width, "height": height,
            "bytes": bytes_n, "format": fmt, "action": action,
            "summary": "%s 完成（%s）：%dx%d -> %s（%d 字节）" % (
                ACTIVITY.get(action, action), action, width, height, os.path.basename(out), bytes_n),
        }))
        return 0
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": str(e), "action": action}))
        return 1


if __name__ == "__main__":
    try:
        code = main(sys.argv[1:])
    except Exception as e:  # 顶层兜底
        print(json.dumps({"error": "unexpected: %s" % e}))
        code = 1
    sys.exit(code)
