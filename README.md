# Video Summarizer

This app:

- transcribes a video with timestamps using OpenAI Whisper
- summarizes the transcript and picks key clips with the OpenAI API
- stitches those clips into a shorter MP4 with `ffmpeg`

## Requirements

- Node.js 20+
- `ffmpeg`
- `OPENAI_API_KEY`

## Usage

Run the app against a local video file:

```bash
OPENAI_API_KEY=your_key_here npm start -- ./input-video.mp4
```

Optional flags:

```bash
npm start -- ./input-video.mp4 \
  --output-dir ./output/my-run \
  --target-minutes 3 \
  --summary-model gpt-4.1-mini \
  --transcribe-model whisper-1
```

## Output

For an input video named `meeting.mp4`, the app writes files like:

- `output/meeting/transcript.json`
- `output/meeting/summary.json`
- `output/meeting/summary.txt`
- `output/meeting/summary-video.mp4`

`transcript.json` includes Whisper segment timestamps. `summary.json` includes the selected clips used to build the final video.

## Notes

- The summarizer picks timestamped transcript segments, so the final cut is only as good as the transcript quality.
- The current implementation assumes the source video has an audio track.
- OpenAI transcription uploads have size limits, so very large videos may need a preprocessing split step.
