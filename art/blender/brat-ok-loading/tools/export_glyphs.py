"""Explicit export of packed painted glyph meshes; never saves the source .blend."""
import argparse
import json
import math
import re
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--start", type=int, default=0)
parser.add_argument("--end", type=int, default=52)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
if not 0 <= args.start <= args.end < 53:
    raise ValueError("Select glyph indices 0..52")
source = ROOT / "scenes/alphabet-v1/BRAT_OK_letter_library_v1.blend"
bpy.ops.wm.open_mainfile(filepath=str(source), load_ui=False, use_scripts=False)
library = bpy.data.scenes["BRAT_OK — библиотека латинских букв"]
scene = bpy.data.scenes[library["export_scene"]]
instance = scene.objects[scene["export_instance"]]
metrics = json.loads(library["export_metrics_json"])
bottom = min(-0.65, min(g["bounds"][1] for g in metrics) - 0.10)
top = max(2.25, max(g["bounds"][3] for g in metrics) + 0.10)
pixels = 192
height = math.ceil((top - bottom) * pixels)
bottom = top - height / pixels
out = (ROOT / "renders/glyphs").resolve()
if not out.is_relative_to(ROOT / "renders"):
    raise ValueError("Glyph output escaped this package's renders directory")
out.mkdir(parents=True, exist_ok=True)
bpy.context.window.scene = scene
scene.camera.data.sensor_fit = "HORIZONTAL"
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.film_transparent = True
for index in range(args.start, args.end + 1):
    info = metrics[index]
    if not re.fullmatch(r"(?:upper-[A-Z_]|lower-[a-z])\.png", info["file"]):
        raise ValueError("Unexpected glyph filename")
    instance.data = library.objects[info["object"]].data
    instance.location = (0, 0, 0)
    left = min(-0.15, info["bounds"][0] - 0.08)
    right = max(info["advance"] + 0.10, info["bounds"][2] + 0.08)
    width = math.ceil((right - left) * pixels)
    right = left + width / pixels
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.camera.data.ortho_scale = width / pixels
    scene.camera.location = ((left + right) / 2, (top + bottom) / 2, 30)
    target = (out / info["file"]).resolve()
    if not target.is_relative_to(ROOT / "renders"):
        raise ValueError("Glyph image escaped this package's renders directory")
    scene.render.filepath = str(target)
    bpy.ops.render.render(write_still=True)
    info["png_size"] = [width, height]
    info["png_origin_from_top_left"] = [-left * pixels, top * pixels]
    info["png_advance_px"] = info["advance"] * pixels
    print("GLYPH_OK", info["char"], flush=True)
metrics_path = (out / "glyph-metrics.json").resolve()
if not metrics_path.is_relative_to(ROOT / "renders"):
    raise ValueError("Glyph metrics escaped this package's renders directory")
metrics_path.write_text(json.dumps({"glyphs": metrics}, ensure_ascii=False, indent=2), encoding="utf8")
