# Meeting notes

Type `/meet` (or ⌘N → *New meeting notes*) to add a meeting block. **Start** records, Based transcribes in the
background, and when you stop it re-transcribes the whole recording, separates the speakers and — if an AI engine
is set up — writes a summary. Modelled on Notion's AI Meeting Notes, plus RemNote's click-to-play transcript and
context attachments.

## What you get

- **Tabs**: Summary · Notes · Transcript. Notes are ordinary blocks; every note typed while recording is stamped with
  the recording time, so clicking it plays the audio from there. Every transcript line plays from its start too.
- **Speakers**: microphone and system audio are recorded as separate tracks, so *Me* vs. *the others* is known
  live. After the recording the remote track (or the whole recording, for in-room meetings and uploads) is
  separated into *Speaker 1, 2, …*. Rename, merge, or reassign a line to another speaker by hand.
- **Context**: link pages or add a text note (agenda, a spec, slide notes); files and URLs are in the data model
  but not in the menu yet. Names and terms from the context,
  the attendees and your own vocabulary list bias recognition; the context text goes to the summary.
- **Summary** with an AI engine configured (BYOK API key, or a coding-agent CLI such as Claude Code / Codex):
  key points, decisions, action items, each citing the transcript as `[m:ss]` (click → play). Custom summary
  instructions per meeting. Without an engine, you get the transcript only.
- **Uploads**: add a recording made elsewhere (phone, Zoom export); it is transcribed the same way.
- **Notice**: a banner reminds you to tell the others you're transcribing (can be turned off per meeting).
- **Voice profiles** (opt-in, Settings → My settings → Meeting notes): once you name a speaker, Based recognises
  that voice in later meetings. Voice prints are biometric data, so they stay in this device's local database —
  never synced, exported or uploaded. Turning the setting off deletes them; *Forget* removes one person.

## How it works

```
capture (per track)          live                           after Stop
──────────────────           ─────────────────────────      ───────────────────────────────────────
mic  ── AVAudioEngine ─┐     UtteranceChunker (energy VAD)   Parakeet v3 over each whole track file
sys  ── Core Audio tap ┤──▶  → Parakeet v3 every ~1.5 s  ──▶ pyannote + VBx diarization (remote/in-room)
upload ────────────────┘     → partial / final segments      → speakers, voice-profile match, summary
     16 kHz mono → AAC .m4a (~10 MB / h / track) as workspace assets
```

| Part | Where | Notes |
|---|---|---|
| Model, chunked transcript records, speakers, context, vocabulary, summary prompt, Markdown/HTML export, search | `BasedCore/Model/Meeting.swift`, `Store/MeetingOps.swift` | unit-tested on Linux (`MeetingTests`) |
| Live utterance cutting for batch models | `BasedCore/Model/UtteranceChunker.swift` | |
| Voice profiles (centroids, cosine matching, learning, local storage) | `BasedCore/Model/VoiceProfiles.swift` | `VoiceProfileTests` |
| Capture: mic + Core Audio process tap (macOS 14.2+), mic with background audio (iPhone) | `legacy/App/Shared/Meeting/MeetingAudio.swift` | |
| Recognition + diarization (FluidAudio: Parakeet TDT 0.6B v3, pyannote community-1) | `legacy/App/Shared/Meeting/MeetingEngine.swift` | models ~0.5 GB, downloaded once, run on the Neural Engine |
| Recording lifecycle, final pass, summary | `legacy/App/Shared/Meeting/MeetingService.swift` | |
| UI | `legacy/App/Shared/Meeting/MeetingBlockView.swift` | web client renders meetings read-only |

The transcript is stored in `.transcript` chunk blocks of 40 segments, so live transcription rewrites (and syncs)
one small record instead of the whole meeting.

**Languages**: Parakeet v3 covers 25 European languages (incl. German and English) with automatic detection; the
language can be fixed per meeting.

**Permissions**: microphone (macOS + iOS) and *System Audio Recording* (macOS 14.2+, asked on first recording).
On iPhone the other side of a call can't be captured (iOS doesn't allow it) — use speaker mode or record on the Mac.

## Based Next (web / Tauri)

`/meet` inserts the same block (records byte-compatible with the Swift format). Logic: `packages/core`
(`model/meeting.ts`, `store/meeting-ops.ts` — chunks, timestamps, `[m:ss]` citations, summary blocks),
`packages/brain/src/meeting.ts` (`MeetingRecorder`, `Transcriber` interface, summary prompt over the configured
engine), view: `packages/editor/src/schema/meeting.tsx`, browser capture/playback: `apps/web/src/meeting/`.

- Records the microphone (`getUserMedia` + `MediaRecorder`); tab/system audio as a second track (*Others*) only
  where the browser shares audio via `getDisplayMedia` (Chromium). Tracks are stored as assets (BSD-78).
- Notes typed while recording get the recording time; transcript lines, stamped notes and summary citations play
  from there.
- The summary runs only when you click *Generate summary* (engine from Settings → Agents & AI).
- **No transcription yet**: the Swift app transcribes on the device (Parakeet), and there is no provider request
  format for audio in the Swift code to port. The `Transcriber` interface is ready; tests use a fixed transcript.
  No speaker separation (diarization) and no voice profiles in the web app.

## Other systems (planned)

Windows (WASAPI process loopback), Linux (PipeWire monitor) and Android capture in the Tauri shell with
sherpa-onnx running the same Parakeet / diarization models; the web client records the microphone (plus tab or
system audio in Chromium) and lets `based-server` transcribe the upload. See `docs/platforms.md`.
