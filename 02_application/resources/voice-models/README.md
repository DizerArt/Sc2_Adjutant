# Voice Models

This directory holds local TTS models that get bundled with the application via
`electron-builder`'s `extraResources` configuration.

## Required files for default install

| File | Approx. size | Purpose |
| --- | --- | --- |
| `en_US-glados.onnx` | ~63 MB | Default English voice |
| `en_US-glados.onnx.json` | ~7 KB | Phoneme/inference config |
| `silero-v5_5_ru.pt` | ~139 MB | Russian Silero speakers (`xenia`, `baya`) |

Optional Piper voices (selectable from settings UI once added):

- `en_US-amy-medium.onnx` + `.json` (~63 MB, lighter alternative)

## How to populate

Run from the `02_application/` directory:

```
node scripts/download-voice-models.cjs
node scripts/download-voice-models.cjs --all
```

The default command downloads GLaDOS. `--all` also downloads optional English
voices and the Russian Silero v5.5 model from:

- https://models.silero.ai/models/tts/ru/v5_5_ru.pt

Files in this directory (other than `README.md`) are git-ignored.

## Licensing

The bundled Piper voices and the GLaDOS model source repository are MIT-licensed.
Silero models are published by the Silero project:
https://github.com/snakers4/silero-models. See upstream model pages for original
authors, licenses, and contributors.
