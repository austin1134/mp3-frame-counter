# Additional MP3 comparisons

Verified on 28 September 2026 with FFmpeg/FFprobe 9.0.2, MediaInfoLib 26.05, and the compiled application. No counting defect was found. The supplied file remains unchanged; its SHA-256 matches the committed assessment fixture.

## What was checked

**23 additional real MP3 files** passed: 18 generated LAME files, three generated Windows MediaFoundation files, and two public project fixtures. The generated files passed **105 parser checks** using one-byte, seven-byte, 4,093-byte, 65,536-byte, and seeded random partitions. All **27 real multipart uploads** returned the exact expected JSON and content type: those 23 files, the original assessment sample, and three controlled sample copies.

Expected physical counts were established from FFprobe's actual packet records and contiguous byte positions, adding one only when a complete leading Info/Xing frame occupied the gap before its first audio packet. Checks covered all audio bytes and recognized trailing ID3v1 tags. Embedded frame declarations and duration estimates did not determine these expected counts.

The [machine-readable evidence](additional-validation.json) records each file's SHA-256, size, tool results, and actual HTTP response. This is a snapshot of supplemental development checks. Three small generated files are permanent regression fixtures; normal tests require no external executable or service. Their exact generation commands and independent expectations are in [fixture provenance](../tests/fixtures/README.md).

| Generated cases                 | Coverage                     | FFprobe audio packets | Physical frames |
| ------------------------------- | ---------------------------- | --------------------: | --------------: |
| LAME, 32 kHz                    | Mono/stereo × CBR/VBR/ABR    |                    40 |        40 or 41 |
| LAME, 44.1 kHz                  | Mono/stereo × CBR/VBR/ABR    |                    54 |        54 or 55 |
| LAME, 48 kHz                    | Mono/stereo × CBR/VBR/ABR    |                    59 |        59 or 60 |
| MediaFoundation, 32/44.1/48 kHz | Stereo CBR without Info/Xing |          40 / 54 / 59 |    40 / 54 / 59 |

All generated signals are mathematical tones plus deterministic pink noise, 1.37 seconds long. Metadata variations include ID3v2.3, ID3v2.4, and ID3v1. The LAME cases include real padding, bitrate changes, 1,440-byte frames, Info/Xing carriers, and files without carriers. MediaFoundation mono generation attempts emitted no audio packets and were excluded from the valid encoder corpus; their metadata/carrier-only output is not evidence of an application counting failure.

Two additional examples came from pinned official project revisions. They were checked locally without adding their binaries to this repository:

| Public fixture          |   Bytes | FFprobe packets | Physical frames | Provenance                                                                                                                                                                                                                                             |
| ----------------------- | ------: | --------------: | --------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| mpg123 synthetic sweep  |  10,677 |              40 |              41 | [Fixture](https://github.com/madebr/mpg123/blob/db58b4ab4bca95032328b4dd01506aad54cb4ac8/src/tests/sweep.mp3), [LGPL-2.1](https://github.com/madebr/mpg123/blob/db58b4ab4bca95032328b4dd01506aad54cb4ac8/COPYING)                                      |
| SDL_mixer music example | 551,040 |           1,314 |           1,315 | [Fixture](https://github.com/libsdl-org/SDL_mixer/blob/df66ae893c91b0f6fa5d026a195bb278213d007d/examples/music.mp3), [CC-BY-4.0 attribution](https://github.com/libsdl-org/SDL_mixer/blob/df66ae893c91b0f6fa5d026a195bb278213d007d/examples/README.md) |

## Why tool counts can differ

The API counts physical MPEG frames. A tool's field named `FrameCount` may instead describe audio packets, decoded output, a stored declaration, or an estimate. Comparison needs to establish which quantity is being measured.

| Supplied sample or derived copy       | API physical frames | FFprobe audio packets | MediaInfo 26.05 `FrameCount` |
| ------------------------------------- | ------------------: | --------------------: | ---------------------------: |
| Original                              |               6,090 |                 6,089 |                        6,089 |
| Only stored Xing count changed to `1` |               6,090 |                 6,089 |                            1 |
| First 208-byte Xing frame removed     |               6,089 |                 6,089 |                        6,089 |
| Only four-byte Xing marker masked     |               6,090 |                 6,089 |                        6,090 |

The original's first physical frame starts at byte 44, contains Xing at byte 80, and ends at byte 252. Its stored audio count is at byte 88. The modified copies leave all frame boundaries intact except the explicit removal of that one frame. The source file is never edited.

MediaInfo still returns the deliberately false declaration of `1` with `--ParseSpeed=1`; its [MPEG audio implementation](https://github.com/MediaArea/MediaInfoLib/blob/v26.05/Source/MediaInfo/Audio/File_Mpega.cpp) can use Xing metadata. MediaInfo 26.05 includes the Info carrier in the tested CBR counts but excludes it in the tested VBR/ABR Xing counts. Tool versions and metadata affect the result; adding one to every MediaInfo result would be incorrect.

FFprobe normally [omits recognized VBR tag frames](https://github.com/FFmpeg/FFmpeg/blob/n9.0.2/libavformat/mp3dec.c). With the marker masked, this version's initial synchronization also omits the first 208 bytes because the first two headers differ in channel mode. This omission does not remove the complete physical frame from the file. Decoded counts are a separate quantity: the tampered declaration affects gapless trimming and produces 6,088 decoded frames while 6,089 packets remain. The comparison uses packet records and observed byte boundaries rather than decoded counts.

## Reproduce the optional tool checks

```sh
ffprobe -v error -select_streams a:0 -count_packets -show_entries stream=nb_read_packets -of json tests/fixtures/assessment-sample.mp3
ffprobe -v error -select_streams a:0 -show_packets -show_entries packet=pos,size -of json tests/fixtures/assessment-sample.mp3
MediaInfo --Full --ParseSpeed=1 --Output=JSON tests/fixtures/assessment-sample.mp3
```

The official [MediaInfo Windows download](https://mediaarea.net/en/MediaInfo/Download/Windows) provided CLI 26.05. The downloaded ZIP's SHA-256 is `f7f80620ce6d14f4995f0de6f98e3ef18ad29496db01899571152ee3311229f9`; the executable and JSON both identify MediaInfoLib 26.05.

The comparison above used the official local MediaInfo CLI. For an optional browser-local check with [MediaInfoOnline](https://mediaarea.net/MediaInfoOnline), select the fixture, choose MediaInfo JSON, and inspect the Audio track's `FrameCount` and reported library version.

These checks support structural counting. They do not establish CRC correctness, general audio decodability, unrestricted free-format support, or compatibility with metadata outside the documented contract.
