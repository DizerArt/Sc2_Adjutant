# SC2 Editor terrain exports

This portable directory contains 35 native terrain renders supplied by the user
on 2026-10-18, covering the 1v1, 2v2, 3v3 and 4v4 ladder inventory (9/9/9/8).
PNG files preserve every RGB pixel and the native dimensions of the TGA exports.
The original TGAs and SC2Map archives are not modified or required at runtime.

`catalog.json` records image/source checksums, source filenames, exact accepted
SC2Map archive hashes, camera bounds and image sizes. Registration is explicitly
**approximate-camera-bounds**. These images have no independently measured 2px
ground calibration; they are separate from the calibrated map background bank.

33 map titles are associated with 40 exact archive hashes. Seven titles have two
render-equivalent revisions: every listed archive member agrees except
`DocumentHeader` and `GameText.version`. Unsupported compressed/encrypted members
are compared as stored bytes plus decoding metadata; differing storage is refused
conservatively. Hash equality is checked before and after reading each archive.

Fields of Death CE and Sentinel CE are included as images, but their accepted
`map_sha256` lists are empty. Their candidate archives have genuine rendering
differences, and the exported revision is unconfirmed. Their candidate hashes are
retained in the catalog for later resolution; no revision is selected by name.

The older `Blackrock.tga` and `Blackrock2.tga` exports are excluded. The explicit
`Blackrock LE.tga` export is packaged. A small explicit filename map accounts for
the editor adding `LE` to five other ladder titles.

To reproduce from the repository root using existing local inputs:

```powershell
.\.venv\Scripts\python.exe scripts\package_map_editor_exports.py --input-dir work\map-bank-editor --inventory work\ladder-map-capture-2026-10-18\inventory.json
```

The script works offline, verifies source and output pixels/checksums, and refuses
to overwrite an existing different output. It neither deletes files nor invokes
the editor, application services, OBS or Git.
