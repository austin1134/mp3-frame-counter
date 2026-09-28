# Verification evidence

Verified on 28 September 2026 using Windows, Node.js 22.14.0, and npm 10.9.2.

## Clean install and automated checks

```sh
npm ci
npm run check
```

All checks passed: Prettier, ESLint with type-aware rules and no warnings, strict TypeScript, 191 tests in six files, coverage thresholds, and the production build.

| Coverage   |             Result |
| ---------- | -----------------: |
| Statements | 95.82% (390 / 407) |
| Branches   | 92.85% (273 / 294) |
| Functions  |   98.03% (50 / 51) |
| Lines      | 97.58% (364 / 373) |

Coverage includes `src/mp3/`, `src/http/`, and `src/config.ts`. Process startup is excluded from coverage thresholds; real socket tests exercise server timeout configuration and bounded shutdown. Uncovered paths primarily concern defensive invariants and uncommon transport failure branches.

The tests include independently specified frame lengths, every supported bitrate/sample-rate pairing, CRC and padding, false headers within payload and metadata, free-format discovery and subsequent mode changes, malformed and truncated input, byte-by-byte and seeded chunk partitions, and a generated 50 MB stream with bounded retained parser input. HTTP tests check exact responses, the supplied sample, complete multipart validation, inclusive limits, large streaming requests, disconnects, inactivity, request deadlines, graceful draining, and forced shutdown.

Three generated real-encoder fixtures add CBR/VBR, all supported sample rates, LAME/Windows MediaFoundation, Info/Xing/no-carrier layouts, and independently established expected counts. Sample-copy regressions prove that a false stored Xing declaration does not change the count and that removing one carrier removes exactly one physical frame. [Additional comparisons](additional-validation.md) passed 105 generated-file chunk checks and 27 actual uploads covering 23 other real MP3 files plus the sample and three controlled copies.

The [GitHub Actions workflow](https://github.com/austin1134/mp3-frame-counter/actions/workflows/ci.yml) runs clean installs and `npm run check` on all four combinations: Node 22/24 on Ubuntu/Windows, covering formatting, linting, type checking, tests with coverage thresholds, and the production build.

## Compiled server check

The production build was started with `node dist/server.js`, bound to `127.0.0.1:3000`, and received a real multipart upload of the included sample:

```text
HTTP status: 200
Content-Type: application/json; charset=utf-8
Body: {"frameCount":6090}
```

A generated seven-frame free-format upload changed channel mode, CRC, and padding after discovery and returned `200` with `{"frameCount":7}`. Uploading README bytes returned `400` with `INVALID_MP3`. `GET /file-upload` returned `405` with `Allow: POST`.

## Independent sample verification

The fixture is 1,458,172 bytes, with SHA-256:

```text
97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3
```

Two independent development probes walked the sample's headers to exactly EOF and found 6,090 physical MPEG-1 Layer III frames. The leading ID3v2 tag occupies 44 bytes. The first MPEG frame occupies 208 bytes and carries Xing metadata advertising 6,089 audio frames.

FFprobe 9.0.2 independently identified MP3, 44,100 Hz, stereo, and 6,089 demuxed audio packets:

```sh
ffprobe -v error -select_streams a:0 -count_packets -show_entries stream=codec_name,sample_rate,channels,nb_read_packets -of json tests/fixtures/assessment-sample.mp3
ffprobe -v error -select_streams a:0 -read_intervals "%+#1" -show_packets -show_entries packet=pos,size -of json tests/fixtures/assessment-sample.mp3
```

Its first audio packet starts at byte **252** and is **104 bytes** long: `44 + 208 = 252`. FFmpeg intentionally [skips the VBR-tag frame](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/mp3dec.c), so the packet count excludes the initial physical Xing frame. The API's count includes that frame and never trusts the embedded counter. MediaInfoLib 26.05 reports 6,089 for this sample; its metadata-dependent results are documented separately in the comparison report.

The portable verification executable came from the Windows distributor linked by [FFmpeg's download page](https://ffmpeg.org/download.html). The downloaded archive checksum was verified against the distributor's SHA-256:

```text
60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba
```

FFprobe is a development cross-check, not an application or test dependency. Structural counting does not establish audio decodability or CRC correctness; the README documents the supported free-format and metadata boundaries.
