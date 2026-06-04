#!/usr/bin/env python
"""Small Silero TTS sidecar for SC2 Adjutant.

Input text is read from stdin as UTF-8. The generated WAV is written to stdout.
Diagnostics and dependency errors are written to stderr.
"""

from __future__ import annotations

import argparse
import io
import re
import sys
import wave


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--speaker", default="xenia")
    parser.add_argument("--sample-rate", type=int, default=48000)
    parser.add_argument("--rate", type=float, default=1.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = normalize_for_russian_tts(read_stdin_text())
    if not text:
        write_wav([], args.sample_rate)
        return 0

    try:
        import torch  # type: ignore
    except Exception as exc:
        print(
            "PyTorch is required for Silero Russian voice. "
            "Install it in the Python environment used by SC2 Adjutant.",
            file=sys.stderr,
        )
        print(str(exc), file=sys.stderr)
        return 2

    try:
        model = load_model(torch, args.model)
        audio = model.apply_tts(
            text=text,
            speaker=args.speaker,
            sample_rate=args.sample_rate,
            put_accent=True,
            put_yo=True,
        )
        samples = audio.detach().cpu().numpy().tolist() if hasattr(audio, "detach") else list(audio)
        write_wav(samples, args.sample_rate)
        return 0
    except Exception as exc:
        print(f"Silero synthesis failed: {exc}", file=sys.stderr)
        return 1


def load_model(torch, model_path: str):
    try:
        return torch.package.PackageImporter(model_path).load_pickle("tts_models", "model")
    except Exception:
        return torch.jit.load(model_path, map_location="cpu")


def read_stdin_text() -> str:
    data = sys.stdin.buffer.read()
    if not data:
        return ""
    try:
        return data.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        print(f"Silero sidecar expected UTF-8 stdin: {exc}", file=sys.stderr)
        raise


def normalize_for_russian_tts(text: str) -> str:
    """Silero RU is Cyrillic-first; expand latin, digits, and acronyms."""
    normalized = text.strip()
    normalized = re.sub(r"\bMMR\b|\u041c\u041c\u0420", " эм эм эр ", normalized, flags=re.IGNORECASE)
    normalized = re.sub(
        r"\b([A-Za-z][A-Za-z0-9_'-]*)#(\d+)\b",
        lambda match: f"{normalize_latin_token(match.group(1))} номер {number_to_ru(int(match.group(2)))}",
        normalized,
    )
    normalized = re.sub(r"\d+", lambda match: number_to_ru(int(match.group(0))), normalized)
    normalized = re.sub(r"\b[A-Za-z][A-Za-z0-9_'-]*\b", lambda match: normalize_latin_token(match.group(0)), normalized)
    normalized = normalized.replace("#", " номер ")
    normalized = re.sub(r"\s+", " ", normalized)
    return normalized.strip()


LATIN_LETTERS = {
    "a": "\u044d\u0439",
    "b": "\u0431\u0438",
    "c": "\u0441\u0438",
    "d": "\u0434\u0438",
    "e": "\u0438",
    "f": "\u044d\u0444",
    "g": "\u0434\u0436\u0438",
    "h": "\u044d\u0439\u0447",
    "i": "\u0430\u0439",
    "j": "\u0434\u0436\u0435\u0439",
    "k": "\u043a\u0435\u0439",
    "l": "\u044d\u043b",
    "m": "\u044d\u043c",
    "n": "\u044d\u043d",
    "o": "\u043e\u0443",
    "p": "\u043f\u0438",
    "q": "\u043a\u044c\u044e",
    "r": "\u0430\u0440",
    "s": "\u044d\u0441",
    "t": "\u0442\u0438",
    "u": "\u044e",
    "v": "\u0432\u0438",
    "w": "\u0434\u0430\u0431\u043b \u044e",
    "x": "\u044d\u043a\u0441",
    "y": "\u0443\u0430\u0439",
    "z": "\u0437\u0435\u0434",
}

TRANSLIT_CHUNKS = [
    ("tion", "\u0448\u0435\u043d"),
    ("show", "\u0448\u043e\u0443"),
    ("time", "\u0442\u0430\u0439\u043c"),
    ("one", "\u0432\u0430\u043d"),
    ("oo", "\u0443"),
    ("ee", "\u0438"),
    ("sh", "\u0448"),
    ("ch", "\u0447"),
    ("ph", "\u0444"),
    ("th", "\u0442"),
    ("ck", "\u043a"),
    ("qu", "\u043a\u0432"),
    ("x", "\u043a\u0441"),
    ("a", "\u0430"),
    ("b", "\u0431"),
    ("c", "\u043a"),
    ("d", "\u0434"),
    ("e", "\u0435"),
    ("f", "\u0444"),
    ("g", "\u0433"),
    ("h", "\u0445"),
    ("i", "\u0438"),
    ("j", "\u0434\u0436"),
    ("k", "\u043a"),
    ("l", "\u043b"),
    ("m", "\u043c"),
    ("n", "\u043d"),
    ("o", "\u043e"),
    ("p", "\u043f"),
    ("q", "\u043a"),
    ("r", "\u0440"),
    ("s", "\u0441"),
    ("t", "\u0442"),
    ("u", "\u0443"),
    ("v", "\u0432"),
    ("w", "\u0432"),
    ("y", "\u0439"),
    ("z", "\u0437"),
]


def normalize_latin_token(token: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9]", "", token)
    if not compact:
        return ""

    if any(char.isdigit() for char in compact):
        return spell_latin_token(compact)
    if compact.isupper() or len(compact) <= 3 or is_barcode_like(compact):
        return spell_latin_token(compact)
    return transliterate_latin_token(compact)


def is_barcode_like(token: str) -> bool:
    lowered = token.lower()
    return len(token) >= 5 and all(char in {"i", "l"} for char in lowered)


def spell_latin_token(token: str) -> str:
    parts = []
    for char in token:
        if char.isdigit():
            parts.append(number_to_ru(int(char)))
        else:
            parts.append(LATIN_LETTERS.get(char.lower(), char))
    return " ".join(parts)


def transliterate_latin_token(token: str) -> str:
    lowered = split_camel_case(token).lower()
    result = []
    index = 0
    while index < len(lowered):
        if lowered[index].isspace():
            result.append(" ")
            index += 1
            continue
        matched = False
        for latin, cyrillic in TRANSLIT_CHUNKS:
            if lowered.startswith(latin, index):
                result.append(cyrillic)
                index += len(latin)
                matched = True
                break
        if not matched:
            result.append(lowered[index])
            index += 1
    return "".join(result)


def split_camel_case(token: str) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", token)


ONES = [
    "",
    "\u043e\u0434\u0438\u043d",
    "\u0434\u0432\u0430",
    "\u0442\u0440\u0438",
    "\u0447\u0435\u0442\u044b\u0440\u0435",
    "\u043f\u044f\u0442\u044c",
    "\u0448\u0435\u0441\u0442\u044c",
    "\u0441\u0435\u043c\u044c",
    "\u0432\u043e\u0441\u0435\u043c\u044c",
    "\u0434\u0435\u0432\u044f\u0442\u044c",
]
ONES_FEMININE = ["", "\u043e\u0434\u043d\u0430", "\u0434\u0432\u0435", *ONES[3:]]
TEENS = [
    "\u0434\u0435\u0441\u044f\u0442\u044c",
    "\u043e\u0434\u0438\u043d\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0434\u0432\u0435\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0442\u0440\u0438\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0447\u0435\u0442\u044b\u0440\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u043f\u044f\u0442\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0448\u0435\u0441\u0442\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0441\u0435\u043c\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0432\u043e\u0441\u0435\u043c\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0434\u0435\u0432\u044f\u0442\u043d\u0430\u0434\u0446\u0430\u0442\u044c",
]
TENS = [
    "",
    "",
    "\u0434\u0432\u0430\u0434\u0446\u0430\u0442\u044c",
    "\u0442\u0440\u0438\u0434\u0446\u0430\u0442\u044c",
    "\u0441\u043e\u0440\u043e\u043a",
    "\u043f\u044f\u0442\u044c\u0434\u0435\u0441\u044f\u0442",
    "\u0448\u0435\u0441\u0442\u044c\u0434\u0435\u0441\u044f\u0442",
    "\u0441\u0435\u043c\u044c\u0434\u0435\u0441\u044f\u0442",
    "\u0432\u043e\u0441\u0435\u043c\u044c\u0434\u0435\u0441\u044f\u0442",
    "\u0434\u0435\u0432\u044f\u043d\u043e\u0441\u0442\u043e",
]
HUNDREDS = [
    "",
    "\u0441\u0442\u043e",
    "\u0434\u0432\u0435\u0441\u0442\u0438",
    "\u0442\u0440\u0438\u0441\u0442\u0430",
    "\u0447\u0435\u0442\u044b\u0440\u0435\u0441\u0442\u0430",
    "\u043f\u044f\u0442\u044c\u0441\u043e\u0442",
    "\u0448\u0435\u0441\u0442\u044c\u0441\u043e\u0442",
    "\u0441\u0435\u043c\u044c\u0441\u043e\u0442",
    "\u0432\u043e\u0441\u0435\u043c\u044c\u0441\u043e\u0442",
    "\u0434\u0435\u0432\u044f\u0442\u044c\u0441\u043e\u0442",
]


def number_to_ru(number: int) -> str:
    if number == 0:
        return "\u043d\u043e\u043b\u044c"
    if number < 0:
        return f"\u043c\u0438\u043d\u0443\u0441 {number_to_ru(abs(number))}"
    if number >= 1_000_000:
        return " ".join(number_to_ru(int(digit)) for digit in str(number))

    thousands = number // 1000
    rest = number % 1000
    parts = []
    if thousands:
        parts.append(number_under_1000_to_ru(thousands, feminine=True))
        parts.append(plural_thousand(thousands))
    if rest:
        parts.append(number_under_1000_to_ru(rest))
    return " ".join(part for part in parts if part)


def number_under_1000_to_ru(number: int, feminine: bool = False) -> str:
    hundreds = number // 100
    last_two = number % 100
    parts = []
    if hundreds:
        parts.append(HUNDREDS[hundreds])
    if 10 <= last_two <= 19:
        parts.append(TEENS[last_two - 10])
    else:
        tens = last_two // 10
        ones = last_two % 10
        if tens:
            parts.append(TENS[tens])
        if ones:
            parts.append((ONES_FEMININE if feminine else ONES)[ones])
    return " ".join(parts)


def plural_thousand(number: int) -> str:
    last_two = number % 100
    last = number % 10
    if 11 <= last_two <= 14:
        return "\u0442\u044b\u0441\u044f\u0447"
    if last == 1:
        return "\u0442\u044b\u0441\u044f\u0447\u0430"
    if 2 <= last <= 4:
        return "\u0442\u044b\u0441\u044f\u0447\u0438"
    return "\u0442\u044b\u0441\u044f\u0447"


def write_wav(samples, sample_rate: int) -> None:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(to_pcm16(samples))
    sys.stdout.buffer.write(buffer.getvalue())


def to_pcm16(samples) -> bytes:
    data = bytearray()
    for sample in samples:
        value = int(max(-1.0, min(1.0, float(sample))) * 32767)
        data.extend(value.to_bytes(2, byteorder="little", signed=True))
    return bytes(data)


if __name__ == "__main__":
    raise SystemExit(main())
