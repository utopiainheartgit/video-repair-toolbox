# Video Repair Toolbox

[English](README.md) | [简体中文](README.zh-CN.md)

A local-first toolbox for repairing and merging videos. Diagnose first, confirm before writing, and repair files in place — your footage never leaves the machine.

## What it does

Broken MP4/MOV files usually come from an interrupted recording, an unsafe card removal, or a failed transfer. This toolbox inspects the file, tells you what is actually wrong, and then tries a chain of repair strategies from least invasive to most invasive. Only after the result passes validation is the original file replaced.

The same server also handles merging: it probes every clip, shows you the strategy per clip, and verifies the output before moving source files to the Trash.

## Features

- **Diagnose → confirm → repair.** Diagnosis is read-only. You see the problem and the proposed plan before anything is written.
- **Lossless-first repair chain.** Header repair, index rebuild, remux, raw stream recovery, and re-encode are tried in order, so the least destructive method that works wins.
- **Nothing is uploaded.** Node.js service binds to `127.0.0.1` only; paths are resolved on the machine that runs the server.
- **In-place repair with validation.** The original is swapped only after stream, audio, and duration checks pass.
- **Merge with a per-clip plan.** Each clip is labelled lossless, remux, or re-encode before you commit to a long job.
- **Queued merges with safe cleanup.** Each output is verified on its own; sources go to the Trash only when the product is clean. One failed task never blocks the rest.
- **Trash, not permanent delete.** The delete endpoint is limited to paths from the latest repair job.
- **Dark web UI** with native macOS folder/file pickers.

## Quick start

### macOS (easiest)

Double-click `启动视频修复.command` ("Start Video Repair"). It checks the dependencies, starts the local service, and opens the UI in your browser.

### Manual start

```bash
node server.mjs
```

Then open <http://127.0.0.1:8731>. The port can be changed with `PORT`:

```bash
PORT=9000 node server.mjs
```

Close the terminal window or press Ctrl+C to stop the service.

## Requirements

| Dependency | Notes |
| --- | --- |
| Node.js 20.11+ | The server uses `import.meta.dirname`. |
| ffmpeg / ffprobe | Must be on `PATH`; the launcher also checks `/opt/homebrew/bin`. |
| untrunc (optional) | Enables moov index rebuild. A prebuilt copy or sources are in `vendor/untrunc`; build `untrunc` or `untrunc-81`, or put one on `PATH`. |
| macOS (optional) | Required only for the `.command` launcher and the native picker/save panels. The web UI itself works with any modern browser. |

Install on macOS with Homebrew:

```bash
brew install node ffmpeg
```

## Usage

### Repair

1. Add files, add a whole folder, or paste paths. `file://` URLs and `~` are accepted.
2. Click **Start diagnosis**. This step only reads the files.
3. Review the results and click **Confirm repair**. Progress is shown per strategy.
4. Failed items can be retried. Failed source files can be moved to the Trash — but only those from the latest job.

A healthy reference video from the same device improves index rebuild. It should share the codec, resolution, and frame rate with the broken file.

### Merge

1. Add clips individually or add an entire folder.
2. Click **Save as** and choose the output location with the native save panel.
3. Click **Start merge**. The plan tells you whether each clip can be copied losslessly, needs a remux, or must be re-encoded.
4. Use **Show in Finder** to locate the result. The queue mode runs several merges back to back and verifies each one before cleaning up its sources.

## How repair works

The strategies are attempted in increasing order of invasiveness:

1. **Header/ftyp repair** — fixes a truncated leading header when the media data and moov box are intact. Byte-for-byte lossless.
2. **untrunc index rebuild** — reconstructs a missing moov box from a healthy reference recording.
3. **Remux** — rebuilds the container without touching the elementary streams.
4. **Raw stream recovery** — reassembles the media streams into a new container.
5. **Re-encode** — last resort when the streams themselves have to be rebuilt.

After each attempt the product is validated. A repair is accepted only if the streams, audio, and duration hold up; if the source duration is unknown, the tool tells you that completeness could not be confirmed.

## Privacy and safety

- The service listens on loopback only and is not exposed to the network.
- Video bytes are not streamed through the browser; the server works on real local paths.
- In-place replacement happens only after validation passes.
- Deletions go to the Trash. The delete endpoint accepts only paths recorded by the latest repair job, so a malformed client cannot turn it into a general delete.
- If a Trash operation fails across volumes, the tool reports the actual reason and keeps the files instead of silently losing footage.

## Project layout

```text
server.mjs              HTTP service and API routes
lib/probe.mjs           file detection and diagnosis
lib/repair.mjs          repair chain, validation, in-place swap
lib/headfix.mjs         header/ftyp repair
lib/rawstream.mjs       raw stream recovery
lib/audio.mjs           audio stream inspection
lib/bitstream.mjs       bitstream helpers
lib/merge.mjs           probing, planning and merging clips
lib/queue.mjs           output verification and source cleanup
lib/trash.mjs           move to Trash
lib/joblog.mjs          job log
public/                 web UI (HTML, CSS, JavaScript)
test/                   API and unit tests
vendor/untrunc/         bundled untrunc sources/build
启动视频修复.command      macOS launcher
```

## Tests

```bash
node test/run-tests.mjs
```

## Limitations

- Without a compiled untrunc binary, moov index rebuild is unavailable; other strategies still work.
- When the source duration is unknown, the tool cannot prove the recovery is complete. Check the length yourself and keep a backup.
- Moving files to the Trash across volumes can fail; the tool surfaces the reason and leaves the files untouched.
- The web UI is currently in Chinese only.

## License

Not specified yet.

---

Made for local repair workflows. Keep a backup of anything you cannot afford to lose.
