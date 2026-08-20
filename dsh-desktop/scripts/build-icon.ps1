# Generates build/icon.png, assets/icon.png and assets/tray-icon.png.
#
# Source of truth: assets/icon.jpg (user-provided design). Processing:
#   1. color-key the near-white background band ([228,248], max-min <= 10) to
#      transparent — removes the off-white square WITHOUT touching the white
#      wordmark (255,255,255 sits outside the keyed band);
#   2. clip to a rounded-rect mask with a large corner radius (~23% of canvas);
#   3. tray icon = 32x32 downscale with the same treatment (radius ~28%).
#
# If assets/icon.jpg is missing, falls back to the programmatic blue-gradient
# design so the repo stays self-contained.
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
$assetsDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $buildDir, $assetsDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

public static class IconMask
{
    static bool IsBackground(Color c)
    {
        int min = Math.Min(c.R, Math.Min(c.G, c.B));
        int max = Math.Max(c.R, Math.Max(c.G, c.B));
        return min >= 205 && max <= 252 && (max - min) <= 15;
    }

    // Flood-fill the near-white background from the border: removes the light
    // square while leaving enclosed light details (e.g. the whale's eye) intact.
    static void KeyBackground(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var done = new bool[w * h];
        var queue = new Queue<int>();
        for (int x = 0; x < w; x++) { queue.Enqueue(x); queue.Enqueue((h - 1) * w + x); }
        for (int y = 0; y < h; y++) { queue.Enqueue(y * w); queue.Enqueue(y * w + w - 1); }
        while (queue.Count > 0)
        {
            int idx = queue.Dequeue();
            if (done[idx]) continue;
            done[idx] = true;
            int x = idx % w, y = idx / w;
            Color c = bmp.GetPixel(x, y);
            if (!IsBackground(c)) continue;
            bmp.SetPixel(x, y, Color.FromArgb(0, c.R, c.G, c.B));
            if (x > 0) queue.Enqueue(idx - 1);
            if (x < w - 1) queue.Enqueue(idx + 1);
            if (y > 0) queue.Enqueue(idx - w);
            if (y < h - 1) queue.Enqueue(idx + w);
        }
    }

    // Remove the background, then clip to a rounded-rect mask.
    public static Bitmap Process(Bitmap src, int radius, bool colorKey)
    {
        int w = src.Width, h = src.Height;
        var canvas = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(canvas))
        {
            g.Clear(Color.Transparent);
            g.DrawImage(src, 0, 0, w, h);
        }
        if (colorKey) KeyBackground(canvas);
        if (radius <= 0) return canvas;
        var path = new GraphicsPath();
        int d = radius * 2;
        path.AddArc(0, 0, d, d, 180, 90);
        path.AddArc(w - d, 0, d, d, 270, 90);
        path.AddArc(w - d, h - d, d, d, 0, 90);
        path.AddArc(0, h - d, d, d, 90, 90);
        path.CloseFigure();
        var output = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        using (var g2 = Graphics.FromImage(output))
        {
            g2.Clear(Color.Transparent);
            g2.SmoothingMode = SmoothingMode.AntiAlias;
            g2.SetClip(path);
            g2.DrawImage(canvas, 0, 0, w, h);
        }
        canvas.Dispose();
        path.Dispose();
        return output;
    }

    public static Bitmap Resize(Bitmap src, int size, int radius)
    {
        var scaled = new Bitmap(src, size, size);
        return Process(scaled, radius, true);
    }

    // Tray icon: white rounded chip behind the keyed logo (legible on dark taskbars).
    public static Bitmap Tray(Bitmap src, int size, int radius)
    {
        var keyed = Resize(src, size, 0);
        var path = new GraphicsPath();
        int d = radius * 2;
        path.AddArc(0, 0, d, d, 180, 90);
        path.AddArc(size - d, 0, d, d, 270, 90);
        path.AddArc(size - d, size - d, d, d, 0, 90);
        path.AddArc(0, size - d, d, d, 90, 90);
        path.CloseFigure();
        var output = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(output))
        {
            g.Clear(Color.Transparent);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var brush = new SolidBrush(Color.FromArgb(255, 246, 248, 252)))
                g.FillPath(brush, path);
            g.SetClip(path);
            g.DrawImage(keyed, 0, 0, size, size);
        }
        keyed.Dispose();
        path.Dispose();
        return output;
    }

    // Multi-size .ico with PNG-compressed entries (Vista+): used for .lnk
    // shortcuts so they pick up the new icon without rebuilding the exe.
    public static void SaveIco(Bitmap src, string path, int[] sizes)
    {
        var entries = new List<byte[]>();
        foreach (var s in sizes)
        {
            using (var bmp = new Bitmap(src, s, s))
            using (var ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                entries.Add(ms.ToArray());
            }
        }
        using (var ms = new MemoryStream())
        using (var bw = new System.IO.BinaryWriter(ms))
        {
            bw.Write((ushort)0);
            bw.Write((ushort)1);
            bw.Write((ushort)entries.Count);
            int offset = 6 + 16 * entries.Count;
            for (int i = 0; i < entries.Count; i++)
            {
                int s = sizes[i];
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)(s >= 256 ? 0 : s));
                bw.Write((byte)0);
                bw.Write((byte)0);
                bw.Write((ushort)1);
                bw.Write((ushort)32);
                bw.Write((uint)entries[i].Length);
                bw.Write((uint)offset);
                offset += entries[i].Length;
            }
            foreach (var e in entries) bw.Write(e);
            System.IO.File.WriteAllBytes(path, ms.ToArray());
        }
    }
}
'@ -ReferencedAssemblies System.Drawing

$jpg = Join-Path $assetsDir 'icon.jpg'

if (Test-Path $jpg) {
    # --- Mask the user-provided design --------------------------------------
    $src = [System.Drawing.Bitmap]::FromFile($jpg)
    $main = [IconMask]::Process($src, 210, $true)
    $main.Save((Join-Path $buildDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $main.Save((Join-Path $assetsDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    [IconMask]::SaveIco($main, (Join-Path $buildDir 'icon.ico'), @(16, 24, 32, 48, 64, 128, 256))
    [IconMask]::SaveIco($main, (Join-Path $assetsDir 'icon.ico'), @(16, 24, 32, 48, 64, 128, 256))
    $tray = [IconMask]::Tray($src, 32, 9)
    $tray.Save((Join-Path $assetsDir 'tray-icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "icon masked from icon.jpg: icon.png (900x900, r=210), icon.ico (16-256), tray-icon.png (32x32, white chip)"
    $src.Dispose(); $main.Dispose(); $tray.Dispose()
    exit 0
}

# --- Fallback: programmatic blue-gradient design (legacy path) -------------
$size = 900
$radius = 210
$bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)
$d = $radius * 2
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.Color]::FromArgb(255, 0x5B, 0x8C, 0xFF),
  [System.Drawing.Color]::FromArgb(255, 0x1B, 0x2A, 0x6B))
$g.FillPath($bg, $path)
$prev = $g.Clip
$g.SetClip($path)
$hl = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point(0, $size)),
  [System.Drawing.Color]::FromArgb(70, 255, 255, 255),
  [System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillEllipse($hl, -210, -404, $size + 420, 756)
$g.Clip = $prev
$stroke = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(36, 255, 255, 255), 3)
$g.DrawPath($stroke, $path)
$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$sf.LineAlignment = [System.Drawing.StringAlignment]::Center
$fontMain = New-Object System.Drawing.Font('Segoe UI', 290, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fontSub = New-Object System.Drawing.Font('Segoe UI', 76, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString('DSH', $fontMain, $white, (New-Object System.Drawing.RectangleF(0, 105, $size, 527)), $sf)
$g.DrawString('Desktop', $fontSub, $white, (New-Object System.Drawing.RectangleF(0, 580, $size, 246)), $sf)
$icon = Join-Path $buildDir 'icon.png'
$bmp.Save($icon, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Save((Join-Path $assetsDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "icon generated (fallback design): $icon (${size}x${size}, r=${radius})"

$ts = 32
$tb = New-Object System.Drawing.Bitmap($ts, $ts, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tg = [System.Drawing.Graphics]::FromImage($tb)
$tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$tg.Clear([System.Drawing.Color]::Transparent)
$tr = 9
$td = $tr * 2
$tp = New-Object System.Drawing.Drawing2D.GraphicsPath
$tp.AddArc(0, 0, $td, $td, 180, 90)
$tp.AddArc($ts - $td, 0, $td, $td, 270, 90)
$tp.AddArc($ts - $td, $ts - $td, $td, $td, 0, 90)
$tp.AddArc(0, $ts - $td, $td, $td, 90, 90)
$tp.CloseFigure()
$tbg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($ts, $ts)),
  [System.Drawing.Color]::FromArgb(255, 0x5B, 0x8C, 0xFF),
  [System.Drawing.Color]::FromArgb(255, 0x1B, 0x2A, 0x6B))
$tg.FillPath($tbg, $tp)
$tstroke = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 255, 255, 255), 1.5)
$tg.DrawPath($tstroke, $tp)
$tray = Join-Path $assetsDir 'tray-icon.png'
$tb.Save($tray, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "tray icon saved: $tray (${ts}x${ts})"

$fontMain.Dispose(); $fontSub.Dispose(); $white.Dispose(); $sf.Dispose()
$hl.Dispose(); $bg.Dispose(); $stroke.Dispose(); $path.Dispose(); $g.Dispose(); $bmp.Dispose()
$tbg.Dispose(); $tstroke.Dispose(); $tp.Dispose(); $tg.Dispose(); $tb.Dispose()
