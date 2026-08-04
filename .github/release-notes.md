# SC2 Adjutant 1.1.11+voiceEN+sileroRU

This release provides three Windows editions of SC2 Adjutant 1.1.11 with the same opponent identity fixes.

## Opponent identity fixes

- Fixed ordinary players being replaced by a different SC2Pulse profile that happened to have the same nickname.
- SC2 `battlenet::` profile links are now treated as stable opponent identities for every player, not only barcode accounts.
- Direct SC2Pulse profile-link lookups are accepted only when they resolve to one unambiguous player in the requested region.
- Blizzard web profile links continue to be verified by region, realm, and character ID.
- Ambiguous nickname-only SC2Pulse results are no longer used to assign BattleTag, MMR, league, or career statistics.
- A verified profile-link lookup can replace a stale BattleTag saved by an older application version.
- Players with stable profile links are no longer merged only because their visible nicknames match.

## Which installer should I use?

- `SC2 Adjutant Setup 1.1.11 Voice EN.exe`
  - Standard build with the local English Piper voice assistant.
- `SC2 Adjutant Setup 1.1.11 Silero Russian Voice.exe`
  - Extended build with English Piper and Russian Silero voices (`xenia` and `baya`).
  - Requires Python and PyTorch CPU; see the setup instructions below.
- `SC2 Adjutant Setup 1.1.11 No Voice.exe`
  - Lightweight build with all voice-assistant code and resources removed.

## Silero Russian Voice setup

1. Install Python for Windows from https://www.python.org/downloads/windows/ and enable `Add Python to PATH`.
2. Install PyTorch CPU:

```powershell
python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
```

3. Verify the installation:

```powershell
python --version
python -c "import torch; print(torch.__version__)"
```

If SC2 Adjutant must use a specific Python executable, set it and restart the application:

```powershell
setx SC2_ADJUTANT_PYTHON "C:\Path\To\python.exe"
```

PyTorch installation selector: https://pytorch.org/get-started/locally/

## Verification

- Full unit test suite passed: 48 test files, 289 tests.
- TypeScript typecheck passed.
- Production renderer and Electron build passed.
- All three Windows installer variants were built from their corresponding release branches.

