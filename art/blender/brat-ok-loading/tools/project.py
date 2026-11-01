"""Explicit, offline Blender tools for the repository's BRAT_OK source copies.

blender --background --factory-startup --disable-autoexec --python tools/project.py -- audit --report <json>
Modes never install addons, download assets, or save user preferences.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parents[1]


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def curves(action):
    for layer in action.layers:
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", ()):
                yield from bag.fcurves


def animation_signature():
    return digest([
        [a.name, [[f.data_path, f.array_index, f.extrapolation,
                   [[list(p.co), p.interpolation, list(p.handle_left), list(p.handle_right)]
                    for p in f.keyframe_points]] for f in curves(a)]]
        for a in bpy.data.actions
    ])


def facts():
    return {
        "scenes": [{"name": s.name, "frames": [s.frame_start, s.frame_end],
                    "fps": s.render.fps, "fps_base": s.render.fps_base,
                    "size": [s.render.resolution_x, s.render.resolution_y],
                    "objects": len(s.objects)} for s in bpy.data.scenes],
        "objects": len(bpy.data.objects), "meshes": len(bpy.data.meshes),
        "materials": len(bpy.data.materials),
        "images": sum(i.source not in {"GENERATED", "VIEWER"} for i in bpy.data.images),
        "actions": len(bpy.data.actions), "animation_sha256": animation_signature(),
        "glyph_assets": sum(bool(o.get("glyph_char")) and o.asset_data is not None for o in bpy.data.objects),
    }


def dependencies():
    images = [i for i in bpy.data.images if i.source not in {"GENERATED", "VIEWER"}]
    fonts = [f for f in bpy.data.fonts if f.filepath != "<builtin>"]
    missing = ["image:" + i.name for i in images if not (i.packed_file or i.packed_files)]
    missing += ["font:" + f.name for f in fonts if not f.packed_file]
    missing += ["sound:" + s.name for s in bpy.data.sounds if not s.packed_file]
    missing += ["library:" + l.name for l in bpy.data.libraries]
    missing += ["movie:" + m.name for m in bpy.data.movieclips]
    for scene in bpy.data.scenes:
        if scene.sequence_editor and len(scene.sequence_editor.strips):
            missing.append("sequencer:" + scene.name)
    return {"packed_images": len(images), "packed_fonts": len(fonts), "external": missing}


def slug(value):
    return re.sub(r"[^\w-]+", "-", value, flags=re.UNICODE).strip("-")[:100] or "scene"


def output_path(path):
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT / "renders"):
        raise ValueError("Render output escaped this package's renders directory")
    return resolved


def prepare(file):
    before = facts()
    deps = dependencies()
    if deps["external"]:
        raise RuntimeError("Unpacked dependency: " + ", ".join(deps["external"]))
    # Preserve old unused editable assets as well; Blender otherwise drops orphans on save.
    for collection in (bpy.data.actions, bpy.data.materials, bpy.data.images):
        for item in collection:
            if item.users == 0 and getattr(item, "source", None) not in {"GENERATED", "VIEWER"}:
                item.use_fake_user = True
    # All source pixels/fonts are already packed. Only change their fallback names.
    for index, image in enumerate(bpy.data.images):
        if image.source not in {"GENERATED", "VIEWER"}:
            image.filepath = "//packed/" + str(index) + "-" + slug(image.name) + ".png"
    for index, font in enumerate(bpy.data.fonts):
        if font.filepath != "<builtin>":
            font.filepath = "//packed/font-" + str(index) + ".ttf"
    for scene in bpy.data.scenes:
        scene.render.filepath = "//renders/" + file.stem + "/" + slug(scene.name) + "/frame-"
    # Blender 5.x stores compositor trees among node groups (Scene.node_tree was removed).
    for tree in bpy.data.node_groups:
        for node in tree.nodes:
            if node.type == "OUTPUT_FILE":
                if not hasattr(node, "base_path"):
                    raise RuntimeError("Unknown compositor output destination API")
                node.base_path = "//renders/" + file.stem + "/compositor/"
    if before != facts():
        raise RuntimeError("Preparation changed scene or animation facts")
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(file), compress=True, check_existing=False)
    return before


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("audit", "prepare", "render"))
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--file", help="Repository-relative .blend; omit to audit/prepare all")
    parser.add_argument("--allow-save-copies", action="store_true")
    parser.add_argument("--scene")
    parser.add_argument("--start", type=int)
    parser.add_argument("--end", type=int)
    parser.add_argument("--percent", type=int, default=50)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    report_path = output_path(ROOT / args.report)
    if report_path.suffix.lower() != ".json":
        raise ValueError("Reports must be JSON files inside this package's renders directory")
    args.report = report_path
    if args.mode == "audit":
        manifest = json.loads((ROOT / "migration-sources.json").read_text(encoding="utf8"))
        for item in manifest["sources"]:
            asset = (ROOT / item["file"]).resolve()
            if not asset.is_relative_to(ROOT) or asset.is_symlink():
                raise ValueError("Asset escaped package")
            if hashlib.sha256(asset.read_bytes()).hexdigest() != item["sha256"]:
                raise ValueError("Asset checksum changed: " + item["file"])
    files = [ROOT / args.file] if args.file else sorted(ROOT.glob("scenes/*/*.blend"))
    if not files or any(not f.resolve().is_relative_to(ROOT / "scenes") or f.suffix != ".blend" for f in files):
        raise ValueError("Select source copies inside this package's scenes directory")
    if args.mode == "prepare" and not args.allow_save_copies:
        raise ValueError("Preparation requires explicit --allow-save-copies")
    if args.mode == "render" and (len(files) != 1 or not args.scene or args.start is None or args.end is None):
        raise ValueError("Rendering requires one --file, --scene, --start and --end")
    report = {"blender": bpy.app.version_string, "mode": args.mode, "files": []}
    for file in files:
        bpy.ops.wm.open_mainfile(filepath=str(file.resolve()), load_ui=False, use_scripts=False)
        before = prepare(file) if args.mode == "prepare" else facts()
        deps = dependencies()
        if deps["external"]:
            raise RuntimeError("Source is not self-contained: " + ", ".join(deps["external"]))
        outputs_relative = all(s.render.filepath.replace("\\", "/").startswith("//renders/") for s in bpy.data.scenes)
        if not outputs_relative:
            raise RuntimeError("Source has a non-portable render destination")
        row = {"file": file.relative_to(ROOT).as_posix(), "facts": before,
               "dependencies": deps, "relative_render_paths": outputs_relative}
        if args.mode == "render":
            if any(n.type == "OUTPUT_FILE" for t in bpy.data.node_groups for n in t.nodes):
                raise ValueError("Disable compositor file-output nodes before using the bounded render helper")
            scene = bpy.data.scenes[args.scene]
            if not (scene.frame_start <= args.start <= args.end <= scene.frame_end and 1 <= args.percent <= 100):
                raise ValueError("Frame interval or resolution percentage outside scene bounds")
            bpy.context.window.scene = scene
            scene.render.resolution_percentage = args.percent
            scene.render.image_settings.file_format = "PNG"
            output = output_path(ROOT / "renders" / file.stem / slug(scene.name))
            output.mkdir(parents=True, exist_ok=True)
            for frame in range(args.start, args.end + 1):
                scene.frame_set(frame)
                scene.render.filepath = str(output_path(output / ("frame-" + str(frame).zfill(4) + ".png")))
                bpy.ops.render.render(write_still=True)
            row["rendered"] = [args.start, args.end]
        report["files"].append(row)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf8")
        print("BRAT_OK_OK", row["file"], flush=True)


if __name__ == "__main__":
    main()
