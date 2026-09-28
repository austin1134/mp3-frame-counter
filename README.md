# MP3 frame counter

A TypeScript API that counts complete **MPEG-1 Audio Layer III** frames by parsing uploaded bytes. The supplied assessment sample returns `{"frameCount":6090}`. No audio parsing package, decoder, temporary file, or external executable is used by the application.

## Run it

Use Node.js **22.14+ (22.x), 24, or 26+** and npm. From the repository root:

```sh
npm ci
npm run dev
```

The server listens at `http://127.0.0.1:3000`. In another terminal, upload the included sample:

```sh
curl -i -F "file=@tests/fixtures/assessment-sample.mp3" http://127.0.0.1:3000/file-upload
```

On Windows PowerShell, use `curl.exe` to avoid the `curl` alias:

```powershell
curl.exe -i -F "file=@tests/fixtures/assessment-sample.mp3" http://127.0.0.1:3000/file-upload
```

Expect HTTP `200`, `Content-Type: application/json; charset=utf-8`, and:

```json
{ "frameCount": 6090 }
```

For a compiled run:

```sh
npm run build
npm start
```

Stop the server with Ctrl+C. Run all automated checks with `npm run check`: formatting, linting, strict TypeScript checking, tests with coverage, and the production build.

## API contract

`POST /file-upload` accepts `multipart/form-data` containing exactly one file part and no other parts. The example uses the name `file`; any file field name is accepted. Its filename and declared MIME type do not determine whether it is an MP3: the parser checks the bytes. Files must contain at least one complete supported audio frame.

Success contains exactly `{ "frameCount": number }`. Application errors also use JSON:

```json
{
  "error": {
    "code": "INVALID_MP3",
    "message": "Explanation of the structural failure",
    "offset": 123
  }
}
```

`offset`, when present, is a zero-based byte position within the uploaded file, not the multipart body. Internal exceptions do not expose stack traces.

| Status        | Meaning                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `400`         | Missing file, extra parts, malformed multipart, invalid header, or truncated MP3/tag.                                                |
| `413`         | File or whole-request byte limit exceeded.                                                                                           |
| `415`         | Wrong request content type, another MPEG version/layer, or free-format length that cannot be established within the supported bound. |
| `404` / `405` | Unknown route / wrong method; `405` includes `Allow: POST`.                                                                          |
| `500`         | Unexpected server failure.                                                                                                           |

An interrupted connection has no deliverable response. The handler cancels outstanding work and releases its streams. Node handles transport deadlines separately: a request deadline can return `408`, while inactivity closes the socket. A result is returned only after both the file and the enclosing multipart request complete successfully.

## How counting works

The HTTP layer feeds chunks into an independent parser with `push(chunk)` and `finish()` operations. Chunk boundaries have no meaning to the MP3 format: a header, frame, or tag may span many chunks.

1. Skip recognized ID3 metadata using its declared size; do not scan its contents for audio sync patterns.
2. Validate the four-byte MPEG header: sync, version, layer, bitrate, sample rate, and reserved values.
3. For ordinary bitrate headers, calculate the total frame length:

   ```text
   floor(144000 × bitrateKbps / sampleRateHz) + paddingBit
   ```

4. Consume the complete frame, then increment the count and inspect the next exact boundary. Frame length includes the header and any CRC bytes. Bitrate and padding are read again for each frame, which supports CBR and VBR.
5. At end of input, reject an incomplete header, frame, or tag instead of returning a partial count.

The factor 144 comes from 1,152 samples per frame divided by eight bits per byte ([ITU MPEG audio guidance](https://www.itu.int/dms_pubrec/itu-r/rec/bs/R-REC-BS.1115-1-200504-W!!PDF-E.pdf)). The calculation can be cross-checked against [FFmpeg's MPEG header decoder](https://ffmpeg.org/doxygen/trunk/mpegaudiodecheader_8c_source.html).

An apparent header inside audio payload cannot create an extra frame. There is no arbitrary byte scanning or corruption recovery. Supported metadata is leading ID3v2.2/2.3/2.4, appended ID3v2.4 with its required footer, and a final 128-byte ID3v1 tag. Metadata bodies are skipped without retaining them.

Free-format headers have no table bitrate. The parser finds the earliest next free-format header with matching sample rate/channel count and confirms the inferred spacing with a third header. This remains a synchronization heuristic. Bounded lookahead supports frame lengths through **1,441 bytes**, including padding, using a **2,886-byte window**. Short streams without confirming headers and larger free-format frames receive `415`; they are a disclosed limitation within MPEG-1 Layer III, not another MPEG format.

## Resource limits and choices

| Setting              | Default                          |
| -------------------- | -------------------------------- |
| `HOST`               | `127.0.0.1`                      |
| `PORT`               | `3000`                           |
| `MAX_UPLOAD_BYTES`   | `104857600` (100 MiB, inclusive) |
| `REQUEST_TIMEOUT_MS` | `120000` (120 seconds)           |

The whole multipart body is limited to the file limit plus 64 KiB of overhead. Header and socket inactivity timeouts default to 30 seconds; the header timeout is reduced if `REQUEST_TIMEOUT_MS` is shorter. Invalid configuration fails at startup. Bind `HOST=0.0.0.0` when access outside the local machine is needed.

**Express** makes the HTTP contract familiar; **Busboy** handles streaming multipart framing and limits. Neither interprets MP3 data. The parser uses a small state machine rather than buffering the upload or writing it to disk, keeping parser memory independent of file size. Node and Busboy still maintain bounded stream buffers. Ordinary counting takes linear time in uploaded bytes; bounded free-format discovery does not grow with file size.

This is a synchronous lightweight parser running in the Node process. Upload limits bound an individual request; concurrent uploads still consume aggregate memory, bandwidth, and CPU. A public deployment would add ingress concurrency/rate limits and monitoring based on measured traffic. A queue, worker pool, storage layer, frontend, or authentication system would add scope without improving the required endpoint.

## Verification and boundaries

Tests exercise the header rules and known frame lengths, CBR/VBR/padding/CRC, false sync patterns, metadata, free-format discovery, arbitrary chunk splits, truncation, and the supplied real file. HTTP tests cover the response shape/headers, malformed multipart, extra parts, byte limits, and aborted requests. Formatting, linting, strict TypeScript checking, and tests are included in the repository tooling and CI.

The clean-install verification passed **160 tests**, with **97.56% line coverage** and **92.70% branch coverage** across parsing, HTTP handling, and configuration. The compiled server was also tested with a real upload. See [verification evidence](docs/verification.md) for the environment, commands, coverage scope, and independent sample check.

The fixture is the supplied `sample (2).mp3`, copied unchanged to `tests/fixtures/assessment-sample.mp3`: **1,458,172 bytes**, SHA-256 `97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3`.

The sample contains **6,090 physical MPEG frames**; its first carries Xing metadata with an embedded count of **6,089**. Independently, FFprobe 9.0.2 reports **6,089 audio packets**:

```sh
ffprobe -v error -select_streams a:0 -count_packets -show_entries stream=nb_read_packets -of json tests/fixtures/assessment-sample.mp3
```

[FFmpeg skips the Xing information frame](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3dec.c) before reading audio packets, explaining the difference. This optional verification tool is not an application dependency.

Structural validation does not prove audio decodability or verify CRC checksums. MPEG-2/2.5, other layers, APE metadata, arbitrary leading/trailing junk, and corruption recovery are outside the implemented contract. Unsupported content is rejected explicitly.

Additional references: [ID3v2.4 structure](https://id3.org/id3v2.4.0-structure) and [Busboy streaming contract](https://github.com/mscdex/busboy#special-parser-stream-events).
