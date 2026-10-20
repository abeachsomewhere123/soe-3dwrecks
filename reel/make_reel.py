#!/usr/bin/env python3
"""Make an Instagram dive reel from a wreck model.

    python3 reel/make_reel.py survey  reel/wrecks/euro.json   # pictures for choosing the route
    python3 reel/make_reel.py preview reel/wrecks/euro.json   # 12 stills along the route
    python3 reel/make_reel.py render  reel/wrecks/euro.json   # the finished video and cover
    add --draft for a quick half-size, 15 fps version

Output goes to reel/out/<name>/ (not committed). See reel/README.md.
"""
import argparse, json, os, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = ["/usr/share/fonts/opentype/inter/", os.path.join(HERE, "assets", "fonts") + "/"]

DEFAULT_LOOK = {
    "fog": "#0d4560", "fogDensity": 0.038, "waterAbove": "#3f93b5", "waterBelow": "#062536",
    "ambient": "#a8cde0", "ambientIntensity": 0.55, "hemiIntensity": 0.7, "sunIntensity": 1.0, "fillIntensity": 0.45,
    "torchIntensity": 55, "fov": 66, "sway": 1.0, "sandTile": 2.5, "sandTint": "#ffffff",
    "snowCount": 3500, "snowBox": 26, "snowSize": 0.07, "snowOpacity": 0.55,
}


def font(bold, size):
    names = ["InterDisplay-Bold.otf", "Inter-Bold.otf"] if bold else ["Inter-SemiBold.otf", "Inter-Medium.otf"]
    for d in FONTS:
        for n in names:
            if os.path.exists(d + n):
                return ImageFont.truetype(d + n, size)
    return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)


def load(cfg_path, draft):
    cfg = json.load(open(cfg_path))
    cfg.setdefault("duration", 45); cfg.setdefault("fps", 30); cfg.setdefault("width", 1080); cfg.setdefault("height", 1920)
    cfg["look"] = {**DEFAULT_LOOK, **cfg.get("look", {})}
    slug = os.path.splitext(os.path.basename(cfg_path))[0]
    if draft:
        cfg["width"], cfg["height"], cfg["fps"], slug = cfg["width"] // 2, cfg["height"] // 2, 15, slug + "-draft"
    job = os.path.join(HERE, "out", slug); os.makedirs(job, exist_ok=True)
    json.dump(cfg, open(os.path.join(job, "reel.json"), "w"), indent=1)
    glb = os.path.join(job, "model.glb")
    if not os.path.exists(glb):
        src = cfg["model"]
        if src.startswith("http"):
            print("Downloading", src)
            req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0 (dive reel maker)"})
            with urllib.request.urlopen(req, timeout=300) as r, open(glb + ".part", "wb") as f:
                while chunk := r.read(1 << 20):
                    f.write(chunk)
            os.replace(glb + ".part", glb)
        else:
            os.link(os.path.abspath(src), glb) if os.path.exists(src) else sys.exit(f"Model not found: {src}")
    return cfg, job


def node(job, *args):
    subprocess.run(["node", os.path.join(HERE, "render.js"), job, *args], check=True)


def survey(cfg, job):
    node(job, "survey")
    d = os.path.join(job, "survey"); info = json.load(open(os.path.join(d, "survey.json"))); t = info["top"]
    im = Image.open(os.path.join(d, "top.jpg")).convert("RGB"); dr = ImageDraw.Draw(im); W, H = im.size; f = font(False, 22)
    X = lambda x: (x - t["x0"]) / (t["x1"] - t["x0"]) * W
    Z = lambda z: (z - t["z0"]) / (t["z1"] - t["z0"]) * H
    step = 5 if max(t["x1"] - t["x0"], t["z1"] - t["z0"]) < 120 else 10
    for x in range(int(t["x0"] // step + 1) * step, int(t["x1"]), step):
        dr.line([(X(x), 0), (X(x), H)], fill=(255, 255, 0), width=1); dr.text((X(x) + 3, H - 28), f"x {x}", fill=(255, 255, 0), font=f)
    for z in range(int(t["z0"] // step + 1) * step, int(t["z1"]), step):
        dr.line([(0, Z(z)), (W, Z(z))], fill=(0, 255, 255), width=1); dr.text((4, Z(z) + 3), f"z {z}", fill=(0, 255, 255), font=f)
    im.save(os.path.join(d, "top-grid.jpg"), quality=88)
    sb = info.get("seabed") or {}
    print(f"Model box min {np.round(info['min'], 1).tolist()} max {np.round(info['max'], 1).tolist()}")
    print(f"Scan edge (levelled) at y {sb.get('edgeHeight', 0):.2f}, spread {sb.get('spread', 0):.2f} m")
    print("Survey pictures in", d)


def preview(cfg, job):
    n = round(cfg["duration"] * cfg["fps"]); idx = [round(i * (n - 1) / 11) for i in range(12)]
    node(job, "frames", ",".join(map(str, idx)))
    w, h = 270, 480; sheet = Image.new("RGB", (6 * w, 2 * h)); dr = ImageDraw.Draw(sheet)
    for k, i in enumerate(idx):
        sheet.paste(Image.open(os.path.join(job, "frames", f"f{i:05d}.jpg")).resize((w, h)), ((k % 6) * w, (k // 6) * h))
        dr.text(((k % 6) * w + 6, (k // 6) * h + 6), f"{i / cfg['fps']:.1f} s", fill=(255, 255, 0), font=font(False, 18))
    out = os.path.join(job, "preview.jpg"); sheet.save(out, quality=86); print("Preview sheet:", out)


def card(cfg, lines, y0, extra=None):
    """Centred text block with a soft shadow, as a full-frame transparent PNG."""
    W, H = 1080, 1920
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im); y = y0
    if extra:
        lg = Image.open(extra).convert("RGBA"); lg = lg.resize((420, int(420 * lg.height / lg.width)), Image.LANCZOS)
        a = np.asarray(lg).copy(); a[..., :3] = 255; im.alpha_composite(Image.fromarray(a), ((W - lg.width) // 2, y)); y += lg.height + 40
    for ln in lines:
        f = font(ln.get("bold", False), ln.get("size", 40)); tr = ln.get("track", 0); txt = ln["text"]
        col = (255, 255, 255, 255) if ln.get("bold") else (205, 232, 242, 255)
        w = sum(d.textlength(c, font=f) for c in txt) + tr * (len(txt) - 1); x = (W - w) / 2
        for c in txt:
            d.text((x, y), c, font=f, fill=col); x += d.textlength(c, font=f) + tr
        y += ln.get("size", 40) + ln.get("gap", 14)
    sh = Image.new("RGBA", im.size, (0, 10, 20, 0)); sh.putalpha(im.getchannel("A").filter(ImageFilter.GaussianBlur(10)).point(lambda v: int(v * 0.75)))
    sh.alpha_composite(im)
    if cfg["width"] != W:
        sh = sh.resize((cfg["width"], cfg["height"]), Image.LANCZOS)
    return sh


def render(cfg, job, workers):
    n = round(cfg["duration"] * cfg["fps"])
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda k: node(job, "frames", f"{k}:{n - 1}:{workers}"), range(workers)))
    ov = []  # (png, start, end or None)
    for k, t in enumerate(cfg.get("titles", [])):
        p = os.path.join(job, f"ov_title{k}.png"); card(cfg, t["lines"], t.get("y", 360)).save(p); ov.append((p, t["start"], t["end"]))
    for k, l in enumerate(cfg.get("labels", [])):
        p = os.path.join(job, f"ov_label{k}.png"); card(cfg, [{"text": l["text"], "bold": True, "size": 64, "track": 8}], l.get("y", 330)).save(p); ov.append((p, l["start"], l["end"]))
    if cfg.get("endcard"):
        e = cfg["endcard"]; p = os.path.join(job, "ov_end.png")
        card(cfg, e["lines"], e.get("y", 470), os.path.join(HERE, "assets", "soe-logo.png") if e.get("logo", True) else None).save(p); ov.append((p, e["start"], None))
    name = cfg.get("output", cfg["name"].replace(" ", "-") + "-dive-reel")
    out = os.path.join(job, name + ".mp4"); D = cfg["duration"]
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(cfg["fps"]), "-i", os.path.join(job, "frames", "f%05d.jpg")]
    for p, *_ in ov:
        cmd += ["-loop", "1", "-framerate", str(cfg["fps"]), "-t", str(D), "-i", p]
    cmd += ["-f", "lavfi", "-t", str(D), "-i", "anullsrc=r=48000:cl=stereo"]
    fg = ["[0:v]format=yuv444p,eq=contrast=1.06:saturation=1.08,vignette=angle=PI/5,fade=t=in:st=0:d=0.8,format=rgba[v0]"]
    for k, (p, s, e) in enumerate(ov, 1):
        f = f"[{k}:v]format=rgba,fade=t=in:st={s}:d=0.7:alpha=1" + (f",fade=t=out:st={e - 0.7}:d=0.7:alpha=1" if e else "") + f"[o{k}]"
        fg += [f, f"[v{k - 1}][o{k}]overlay=0:0:shortest=1[v{k}]"]
    fg += [f"[v{len(ov)}]format=yuv420p[vout]"]
    cmd += ["-filter_complex", ";".join(fg), "-map", "[vout]", "-map", f"{len(ov) + 1}:a", "-c:v", "libx264", "-profile:v", "high", "-level", "4.1",
            "-preset", "slow", "-crf", "17", "-maxrate", "14M", "-bufsize", "28M", "-r", str(cfg["fps"]), "-g", str(cfg["fps"] * 2),
            "-c:a", "aac", "-b:a", "128k", "-shortest", "-movflags", "+faststart", out]
    subprocess.run(cmd, check=True); print("Video:", out)
    c = cfg.get("cover")
    if c:
        im = Image.open(os.path.join(job, "frames", f"f{min(n - 1, round(c['time'] * cfg['fps'])):05d}.jpg")).convert("RGB")
        im = ImageEnhance.Color(ImageEnhance.Contrast(im).enhance(1.06)).enhance(1.08)
        a = np.asarray(im).astype(float); y = np.linspace(0, 1, a.shape[0])[:, None, None]; sh = np.clip((y - 0.55) / 0.4, 0, 1) * 0.55
        im = Image.fromarray((a * (1 - sh) + np.array([4, 22, 34]) * sh).clip(0, 255).astype("uint8")).convert("RGBA")
        lines = [{"text": c.get("kicker", "VIRTUAL DIVE"), "size": 40, "track": 10, "gap": 15},
                 {"text": c["title"], "bold": True, "size": 190, "track": 20, "gap": 35}, {"text": c.get("subtitle", ""), "size": 40}]
        im.alpha_composite(card(cfg, lines, c.get("y", 1130))); p = os.path.join(job, name + "-cover.jpg"); im.convert("RGB").save(p, quality=92)
        print("Cover:", p)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["survey", "preview", "render"]); ap.add_argument("config")
    ap.add_argument("--draft", action="store_true", help="half size, 15 fps, for checking the route quickly")
    ap.add_argument("--workers", type=int, default=2, help="browsers rendering at once (default 2)")
    a = ap.parse_args(); cfg, job = load(a.config, a.draft)
    {"survey": lambda: survey(cfg, job), "preview": lambda: preview(cfg, job), "render": lambda: render(cfg, job, a.workers)}[a.step]()
