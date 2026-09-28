# MP3 regression fixtures

Tests read checked-in bytes; FFmpeg and FFprobe are not application or test dependencies. Expected counts below were established independently of the application parser from actual FFprobe packet records and their contiguous byte ranges. A leading Info/Xing carrier is one additional physical MPEG frame, even though FFprobe omits it from audio packets. Neither duration estimates nor embedded frame declarations determine the expectations.

| Fixture                                |     Bytes | Audio packets | Physical frames | Coverage                                                                             |
| -------------------------------------- | --------: | ------------: | --------------: | ------------------------------------------------------------------------------------ |
| `assessment-sample.mp3`                | 1,458,172 |         6,089 |       **6,090** | Supplied assessment recording; Xing carrier                                          |
| `lame-cbr-44100-mono.mp3`              |    11,786 |            54 |          **55** | LAME; 44.1 kHz mono, 64 kbps CBR, 52 padded audio frames, Info, ID3v2.3 and ID3v1    |
| `lame-vbr-48000-mono.mp3`              |    15,591 |            59 |          **60** | LAME; 48 kHz mono, VBR quality 3, five audio bitrate indexes, Xing, ID3v2.4          |
| `mediafoundation-cbr-32000-stereo.mp3` |    23,191 |            40 |          **40** | Windows Media Foundation; 32 kHz stereo, 128 kbps CBR, no Info/Xing carrier, ID3v2.4 |

The three generated recordings were created for this repository from mathematical tones and seeded pink noise, with no external recordings. The assessment recording was provided with the task; no license was supplied for it. No third-party test recording is redistributed here.

SHA-256 identities, also checked in parser tests:

```text
assessment-sample.mp3
97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3
lame-cbr-44100-mono.mp3
ecdbf29a8cd4bf4c58a067635f7d17a5ddb1ba1cf14a418ef40709dfb7a89e0a
lame-vbr-48000-mono.mp3
4c7ccc60917dde5abb37b733ed491ab1cfa2112920d1c92bb701a638244d0285
mediafoundation-cbr-32000-stereo.mp3
6ccc082619ad7b545a8a78c7c43ffa53480239f4a95e3cef45b5eed651285e2f
```

## Independent count evidence

Validated on 2026-09-28 with `FFmpeg/FFprobe 9.0.2-essentials_build-www.gyan.dev` on Windows. FFprobe's actual packet positions and sizes were checked for contiguous coverage through the last audio byte, leaving only the observed metadata envelopes:

| Generated fixture    | Leading ID3v2 bytes | Carrier byte range                     | Audio packet byte range     | Trailing bytes     |
| -------------------- | ------------------: | -------------------------------------- | --------------------------- | ------------------ |
| LAME CBR             |                 166 | `[166, 374)` — one 208-byte Info frame | `[374, 11658)` — 54 packets | 128-byte ID3v1 tag |
| LAME VBR             |                 135 | `[135, 327)` — one 192-byte Xing frame | `[327, 15591)` — 59 packets | None               |
| Media Foundation CBR |                 151 | None                                   | `[151, 23191)` — 40 packets | None               |

To inspect any fixture with FFprobe:

```powershell
ffprobe -v error -select_streams a:0 -count_packets -show_packets -show_entries 'stream=codec_name,sample_rate,channels,nb_read_packets:packet=pos,size' -of json lame-vbr-48000-mono.mp3
```

The assessment sample's 44-byte ID3v2 tag is followed by one 208-byte Xing frame at `[44, 252)`. The first audio packet starts at byte 252; the Xing marker is at 80 and its count field at 88 declares 6,089 audio frames. Two tests change only that declaration to 1 (still 6,090 physical frames) and remove only the carrier (6,089 physical frames), respectively. These derived copies stay in memory; the supplied fixture is unchanged.

## Recorded generation commands

Run these optional PowerShell commands in this directory with the recorded FFmpeg build on PATH. Commands use relative output paths. Build or operating-system differences can change encoded bytes; the hashes above identify the verified artifacts. Regenerating the Media Foundation fixture requires Windows; running the application and regression tests does not.

```powershell
ffmpeg -hide_banner -loglevel error -nostdin -y `
  -f lavfi -i 'aevalsrc=0.14*sin(2*PI*440*t)+0.06*sin(2*PI*880*t):s=44100:d=1.37' `
  -f lavfi -i 'anoisesrc=color=pink:amplitude=0.025:sample_rate=44100:duration=1.37:seed=42' `
  -filter_complex '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]' -map '[a]' `
  -ar 44100 -ac 1 -c:a libmp3lame -b:a 64k `
  -id3v2_version 3 -write_id3v1 1 -write_xing 1 `
  -metadata 'title=Generated cbr validation café' `
  -metadata 'artist=Owned synthetic tone and seeded noise' lame-cbr-44100-mono.mp3

ffmpeg -hide_banner -loglevel error -nostdin -y `
  -f lavfi -i 'aevalsrc=0.14*sin(2*PI*440*t)+0.06*sin(2*PI*880*t):s=48000:d=1.37' `
  -f lavfi -i 'anoisesrc=color=pink:amplitude=0.025:sample_rate=48000:duration=1.37:seed=42' `
  -filter_complex '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]' -map '[a]' `
  -ar 48000 -ac 1 -c:a libmp3lame -q:a 3 `
  -id3v2_version 4 -write_id3v1 0 -write_xing 1 `
  -metadata 'title=Generated vbr validation café' `
  -metadata 'artist=Owned synthetic tone and seeded noise' lame-vbr-48000-mono.mp3

ffmpeg -hide_banner -loglevel error -nostdin -y `
  -f lavfi -i 'aevalsrc=0.14*sin(2*PI*440*t)+0.06*sin(2*PI*880*t)|0.12*sin(2*PI*660*t)+0.05*sin(2*PI*1320*t):s=32000:d=1.37' `
  -f lavfi -i 'anoisesrc=color=pink:amplitude=0.025:sample_rate=32000:duration=1.37:seed=42' `
  -filter_complex '[0:a][1:a]amix=inputs=2:duration=first:normalize=0[a]' -map '[a]' `
  -ar 32000 -ac 2 -c:a mp3_mf -b:a 128k `
  -id3v2_version 4 -write_id3v1 0 -write_xing 0 `
  -metadata 'title=Generated alternative encoder validation café' `
  -metadata 'artist=Owned synthetic tone and seeded noise' mediafoundation-cbr-32000-stereo.mp3
```
