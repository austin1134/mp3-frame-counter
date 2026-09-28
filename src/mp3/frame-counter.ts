import { Mp3Error } from './errors.js';
import { MAX_FRAME_BYTES, readFrameHeader } from './header.js';
import type { Mp3FrameHeader } from './header.js';

type Phase = 'header' | 'frame' | 'tag' | 'footer' | 'id3v1' | 'free' | 'ended';

interface Id3Header {
  readonly major: number;
  readonly revision: number;
  readonly flags: number;
  readonly size: number;
  readonly offset: number;
}

const FREE_FORMAT_WINDOW_BYTES = 2 * MAX_FRAME_BYTES + 4;

/**
 * Incremental structural counter: frame bodies and tag payloads are skipped,
 * never decoded or retained. finish() must see a complete, valid file before a
 * caller publishes the count. Byte offsets include metadata in the upload.
 */
export class Mp3FrameCounter {
  private phase: Phase = 'header';
  private readonly scratch = new Uint8Array(10);
  private scratchLength = 0;
  private offset = 0;
  private headerOffset = 0;
  private frameCount = 0;
  private bytesRemaining = 0;
  private id3Header: Id3Header | undefined;
  private audioEnded = false;
  private freeWindow: Uint8Array | undefined;
  private freeWindowLength = 0;
  private freeCandidateOffset = 0;
  private freeHeader: Mp3FrameHeader | undefined;
  private freeBaseLength: number | undefined;
  private freeStartOffset = 0;
  private finished = false;
  private failure: Mp3Error | undefined;

  /** Bytes retained for incomplete headers or bounded free-format discovery. */
  get bufferedByteCount(): number {
    return this.scratchLength + this.freeWindowLength;
  }

  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (this.finished) throw new Error('Cannot push bytes after finish().');
    try {
      this.consume(chunk);
    } catch (error) {
      if (error instanceof Mp3Error) this.failure = error;
      throw error;
    }
  }

  /** Returns complete physical frames, including a Xing/Info/VBRI carrier. */
  finish(): number {
    if (this.failure) throw this.failure;
    if (this.finished) return this.frameCount;

    let error: Mp3Error | undefined;
    if (this.phase === 'free') {
      error = this.undeterminedFreeFormat();
    } else if (this.phase === 'frame') {
      error = new Mp3Error(
        'INVALID_MP3',
        'Truncated MPEG frame.',
        this.headerOffset,
      );
    } else if (this.phase === 'tag' || this.phase === 'footer') {
      error = new Mp3Error(
        'INVALID_MP3',
        'Truncated ID3v2 tag or footer.',
        this.id3Header?.offset ?? this.headerOffset,
      );
    } else if (this.phase === 'id3v1') {
      error = new Mp3Error(
        'INVALID_MP3',
        'Truncated ID3v1 tag.',
        this.headerOffset,
      );
    } else if (this.scratchLength !== 0) {
      error = new Mp3Error(
        'INVALID_MP3',
        'Incomplete frame or tag header.',
        this.headerOffset,
      );
    } else if (this.frameCount === 0) {
      error = new Mp3Error(
        'INVALID_MP3',
        'The file contains no MPEG audio frames.',
        0,
      );
    }

    if (error) {
      this.failure = error;
      throw error;
    }
    this.finished = true;
    return this.frameCount;
  }

  private consume(chunk: Uint8Array): void {
    let cursor = 0;
    while (cursor < chunk.length) {
      switch (this.phase) {
        case 'header': {
          if (this.scratchLength === 0) this.headerOffset = this.offset;
          const wanted =
            this.scratchLength < 3 ? 3 : this.hasMagic('ID3') ? 10 : 4;
          cursor = this.readScratch(chunk, cursor, wanted);
          if (this.scratchLength < wanted) break;

          if (this.scratchLength === 3) {
            if (this.hasMagic('TAG')) {
              if (this.frameCount === 0) {
                throw new Mp3Error(
                  'INVALID_MP3',
                  'ID3v1 must follow MPEG audio.',
                  this.headerOffset,
                );
              }
              this.scratchLength = 0;
              this.bytesRemaining = 125;
              this.phase = 'id3v1';
            }
            break;
          }
          if (this.hasMagic('ID3')) this.beginId3Tag();
          else this.beginFrame();
          break;
        }
        case 'frame':
        case 'tag':
        case 'id3v1': {
          const consumed = Math.min(this.bytesRemaining, chunk.length - cursor);
          cursor += consumed;
          this.offset += consumed;
          this.bytesRemaining -= consumed;
          if (this.bytesRemaining === 0) {
            if (this.phase === 'frame') {
              this.frameCount += 1;
              this.phase = 'header';
            } else if (this.phase === 'tag') this.endId3Payload();
            else this.phase = 'ended';
          }
          break;
        }
        case 'footer':
          cursor = this.readScratch(chunk, cursor, 10);
          if (this.scratchLength === 10) this.endId3Footer();
          break;
        case 'free': {
          const window = this.freeWindow;
          if (!window) throw new Error('Free-format discovery has no buffer.');
          const consumed = Math.min(
            window.length - this.freeWindowLength,
            chunk.length - cursor,
          );
          window.set(
            chunk.subarray(cursor, cursor + consumed),
            this.freeWindowLength,
          );
          cursor += consumed;
          this.offset += consumed;
          this.freeWindowLength += consumed;
          if (
            !this.resolveFreeFormat() &&
            this.freeWindowLength === window.length
          ) {
            throw this.undeterminedFreeFormat();
          }
          break;
        }
        case 'ended':
          throw new Mp3Error(
            'INVALID_MP3',
            'Unexpected bytes after the final ID3v1 tag.',
            this.offset,
          );
      }
    }
  }

  private readScratch(
    chunk: Uint8Array,
    cursor: number,
    wanted: number,
  ): number {
    const consumed = Math.min(
      wanted - this.scratchLength,
      chunk.length - cursor,
    );
    this.scratch.set(
      chunk.subarray(cursor, cursor + consumed),
      this.scratchLength,
    );
    this.scratchLength += consumed;
    this.offset += consumed;
    return cursor + consumed;
  }

  private hasMagic(magic: 'ID3' | 'TAG'): boolean {
    return (
      this.scratch[0] === magic.charCodeAt(0) &&
      this.scratch[1] === magic.charCodeAt(1) &&
      this.scratch[2] === magic.charCodeAt(2)
    );
  }

  private beginFrame(): void {
    if (this.audioEnded) {
      throw new Mp3Error(
        'INVALID_MP3',
        'MPEG audio cannot follow appended metadata.',
        this.headerOffset,
      );
    }
    const header = readFrameHeader(
      this.scratch.subarray(0, 4),
      this.headerOffset,
    );
    // Once spacing is established, channel mode can change without changing
    // the stride. Each header still supplies its own side-information minimum.
    if (
      this.freeBaseLength !== undefined &&
      (header.bitrateIndex !== 0 ||
        header.sampleRateHz !== this.freeHeader?.sampleRateHz)
    ) {
      throw new Mp3Error(
        'INVALID_MP3',
        'Free-format stream parameters changed.',
        this.headerOffset,
      );
    }
    if (header.frameBytes === undefined && this.freeBaseLength === undefined) {
      this.freeHeader = header;
      this.freeStartOffset = this.headerOffset;
      this.freeWindow = new Uint8Array(FREE_FORMAT_WINDOW_BYTES);
      this.freeWindow.set(this.scratch.subarray(0, 4));
      this.freeWindowLength = 4;
      this.freeCandidateOffset = header.minimumFrameBytes;
      this.scratchLength = 0;
      this.phase = 'free';
      return;
    }

    const length =
      header.frameBytes ?? (this.freeBaseLength ?? 0) + header.padding;
    if (length < header.minimumFrameBytes || length > MAX_FRAME_BYTES) {
      throw new Mp3Error(
        'INVALID_MP3',
        'Invalid MPEG frame length.',
        this.headerOffset,
      );
    }
    this.scratchLength = 0;
    this.bytesRemaining = length - 4;
    this.phase = 'frame';
  }

  private beginId3Tag(): void {
    const major = this.scratch[3];
    const revision = this.scratch[4];
    const flags = this.scratch[5];
    const sizeBytes = this.scratch.subarray(6, 10);
    if (major === undefined || revision === undefined || flags === undefined) {
      throw new Error('ID3 header is incomplete.');
    }
    if (major < 2 || major > 4) {
      throw new Mp3Error(
        'UNSUPPORTED_MP3',
        'Only ID3v2.2, v2.3 and v2.4 tags are supported.',
        this.headerOffset,
      );
    }
    const reservedFlags = major === 2 ? 0x3f : major === 3 ? 0x1f : 0x0f;
    if (
      revision === 0xff ||
      (flags & reservedFlags) !== 0 ||
      sizeBytes.some((byte) => byte > 0x7f)
    ) {
      throw new Mp3Error(
        'INVALID_MP3',
        'Invalid ID3v2 header flags or synchsafe size.',
        this.headerOffset,
      );
    }
    if (this.frameCount > 0) {
      if (major !== 4 || (flags & 0x10) === 0) {
        throw new Mp3Error(
          'INVALID_MP3',
          'An appended ID3v2.4 tag requires a footer.',
          this.headerOffset,
        );
      }
      this.audioEnded = true;
    }
    const size = sizeBytes.reduce((value, byte) => value * 128 + byte, 0);
    this.id3Header = {
      major,
      revision,
      flags,
      size,
      offset: this.headerOffset,
    };
    this.scratchLength = 0;
    this.bytesRemaining = size;
    this.phase = 'tag';
    if (size === 0) this.endId3Payload();
  }

  private endId3Payload(): void {
    const header = this.id3Header;
    if (!header) throw new Error('ID3 payload has no header.');
    // The synchsafe size excludes both the 10-byte header and optional footer.
    if (header.major === 4 && (header.flags & 0x10) !== 0)
      this.phase = 'footer';
    else {
      this.id3Header = undefined;
      this.phase = 'header';
    }
  }

  private endId3Footer(): void {
    const header = this.id3Header;
    if (!header) throw new Error('ID3 footer has no header.');
    const size = this.scratch
      .subarray(6, 10)
      .reduce((value, byte) => value * 128 + byte, 0);
    if (
      this.scratch[0] !== 0x33 ||
      this.scratch[1] !== 0x44 ||
      this.scratch[2] !== 0x49 ||
      this.scratch[3] !== header.major ||
      this.scratch[4] !== header.revision ||
      this.scratch[5] !== header.flags ||
      size !== header.size ||
      this.scratch.subarray(6, 10).some((byte) => byte > 0x7f)
    ) {
      throw new Mp3Error(
        'INVALID_MP3',
        'ID3v2.4 footer does not match its header.',
        this.offset - 10,
      );
    }
    this.scratchLength = 0;
    this.id3Header = undefined;
    this.phase = 'header';
  }

  private matchesDiscoveryFreeHeader(header: Mp3FrameHeader): boolean {
    const first = this.freeHeader;
    return (
      first !== undefined &&
      header.bitrateIndex === 0 &&
      header.sampleRateHz === first.sampleRateHz &&
      header.channels === first.channels
    );
  }

  private tryFreeHeader(
    window: Uint8Array,
    position: number,
  ): Mp3FrameHeader | undefined {
    // Most payload offsets cannot be headers. Avoid allocating exceptions for
    // those bytes; the header reader remains responsible for full validation.
    const second = window[position + 1];
    if (
      window[position] !== 0xff ||
      second === undefined ||
      (second & 0xe0) !== 0xe0
    ) {
      return undefined;
    }
    try {
      const header = readFrameHeader(
        window.subarray(position, position + 4),
        this.freeStartOffset + position,
      );
      return this.matchesDiscoveryFreeHeader(header) ? header : undefined;
    } catch (error) {
      if (error instanceof Mp3Error) return undefined;
      throw error;
    }
  }

  private resolveFreeFormat(): boolean {
    const window = this.freeWindow;
    const first = this.freeHeader;
    if (!window || !first)
      throw new Error('Free-format discovery has no first header.');

    while (this.freeCandidateOffset <= MAX_FRAME_BYTES) {
      const next = this.freeCandidateOffset;
      if (next + 4 > this.freeWindowLength) return false;
      const second = this.tryFreeHeader(window, next);
      if (second) {
        const base = next - first.padding;
        const secondLength = base + second.padding;
        const thirdOffset = next + secondLength;
        if (
          secondLength >= second.minimumFrameBytes &&
          secondLength <= MAX_FRAME_BYTES
        ) {
          if (thirdOffset + 4 > this.freeWindowLength) return false;
          const third = this.tryFreeHeader(window, thirdOffset);
          if (
            third &&
            base + third.padding >= third.minimumFrameBytes &&
            base + third.padding <= MAX_FRAME_BYTES
          ) {
            // A second sync can occur in payload. Require a third at the inferred
            // padded boundary before locking; this remains a synchronization heuristic.
            this.freeBaseLength = base;
            this.frameCount += 2;
            const bufferedLength = this.freeWindowLength;
            this.freeWindow = undefined;
            this.freeWindowLength = 0;
            this.scratchLength = 0;
            this.phase = 'header';
            this.offset = this.freeStartOffset + thirdOffset;
            this.consume(window.subarray(thirdOffset, bufferedLength));
            return true;
          }
        }
      }
      this.freeCandidateOffset += 1;
    }
    return false;
  }

  private undeterminedFreeFormat(): Mp3Error {
    return new Mp3Error(
      'FREE_FORMAT_UNDETERMINED',
      'Cannot determine free-format frame length within 2,886 bytes; three compatible headers are required.',
      this.freeStartOffset,
    );
  }
}
