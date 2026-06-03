# Voice Models

This directory holds Piper TTS ONNX models that get bundled with the application
via `electron-builder`'s `extraResources` configuration.

## Required files for default install

| File | Approx. size | Purpose |
| --- | --- | --- |
| `en_US-glados.onnx` | ~63 MB | Default English voice |
| `en_US-glados.onnx.json` | ~7 KB | Phoneme/inference config |

Optional voices (selectable from settings UI once added):

- `en_US-amy-medium.onnx` + `.json` (~63 MB, lighter alternative)

## How to populate

Run from the `02_application/` directory:

```
node scripts/download-voice-models.cjs
```

The script downloads GLaDOS from https://github.com/dnhkng/GLaDOS and optional
voices from their source repositories into this folder. Files in this directory
(other than `README.md`) are git-ignored.

## Licensing

The bundled Piper voices and the GLaDOS model source repository are MIT-licensed.
See https://github.com/rhasspy/piper and upstream model pages for original
authors and contributors.
