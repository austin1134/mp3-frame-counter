import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Mp3Error } from '../../src/mp3/errors.js';
import { Mp3FrameCounter } from '../../src/mp3/frame-counter.js';
import {
  concatBytes,
  createFrame,
  defaultFrame,
} from '../helpers/mp3-fixtures.js';

function count(bytes: Uint8Array, chunkSize = bytes.length || 1): number {
  const parser = new Mp3FrameCounter();
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parser.push(bytes.subarray(offset, offset + chunkSize));
  }
  return parser.finish();
}

function failure(action: () => unknown): Mp3Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Mp3Error) return error;
    throw error;
  }
  throw new Error('Expected an MP3 parsing failure.');
}

/** Literal synchsafe size 00 00 03 21 = 417, matching the opaque tag payload. */
function id3Tag(major: 2 | 3 | 4, flags = 0): Uint8Array {
  const header = new Uint8Array([
    0x49,
    0x44,
    0x33,
    major,
    0,
    flags,
    0,
    0,
    3,
    0x21,
  ]);
  const footer =
    major === 4 && (flags & 0x10) !== 0
      ? new Uint8Array([0x33, 0x44, 0x49, major, 0, flags, 0, 0, 3, 0x21])
      : new Uint8Array();
  return concatBytes(header, defaultFrame(), footer);
}

function id3v1(): Uint8Array {
  const tag = new Uint8Array(128);
  tag.set([0x54, 0x41, 0x47]);
  tag.set([0xff, 0xfb, 0x90, 0x00], 20);
  return tag;
}

function freeFrame(
  length = 417,
  padding = false,
  mode = 0x00,
  protection = 0xfb,
  rateBits = 0,
): Uint8Array {
  return createFrame(
    [0xff, protection, rateBits | (padding ? 0x02 : 0x00), mode],
    length,
  );
}

describe('physical frame counting', () => {
  it('counts a complete single frame and mixed bitrate, padding and channel modes', () => {
    expect(count(defaultFrame())).toBe(1);
    const bytes = concatBytes(
      defaultFrame(),
      createFrame([0xff, 0xfa, 0x12, 0xc0], 105),
      createFrame([0xff, 0xfb, 0xe8, 0x40], 1440),
    );
    expect(count(bytes)).toBe(3);
  });

  it('uses CRC bytes inside the declared length rather than adding them again', () => {
    const protectedFrame = createFrame([0xff, 0xfa, 0x90, 0x00], 417, 0x55);
    expect(count(concatBytes(protectedFrame, defaultFrame()))).toBe(2);
  });

  it('ignores plausible MPEG headers in payloads, including Xing/Info/VBRI values', () => {
    const frame = defaultFrame();
    frame.set([0xff, 0xfb, 0x90, 0x00], 40);
    frame.set(new TextEncoder().encode('Xing'), 36);
    frame.set([0, 0, 0, 1, 0x7f, 0xff, 0xff, 0xff], 44);
    const info = defaultFrame();
    info.set(new TextEncoder().encode('Info'), 36);
    const vbri = defaultFrame();
    vbri.set(new TextEncoder().encode('VBRI'), 36);
    expect(count(concatBytes(frame, info, vbri))).toBe(3);
  });

  it.each([1, 2, 3, 4, 7, 10, 103, 417, 418, 1024])(
    'is independent of %i-byte chunk boundaries',
    (chunkSize) => {
      const bytes = concatBytes(
        id3Tag(4, 0x10),
        defaultFrame(),
        createFrame([0xff, 0xfb, 0xa2, 0x40], 523),
        id3Tag(4, 0x10),
        id3v1(),
      );
      expect(count(bytes, chunkSize)).toBe(2);
    },
  );

  it('is independent of deterministic random chunk partitions', () => {
    const bytes = concatBytes(
      id3Tag(3, 0x80),
      ...Array.from({ length: 100 }, (_, index) =>
        index % 2 === 0
          ? defaultFrame()
          : createFrame([0xff, 0xfa, 0xa2, 0xc0], 523),
      ),
      id3v1(),
    );
    for (const initialSeed of [1, 17, 98765]) {
      const parser = new Mp3FrameCounter();
      let seed = initialSeed;
      let offset = 0;
      while (offset < bytes.length) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const size = (seed % 997) + 1;
        parser.push(bytes.subarray(offset, offset + size));
        offset += size;
      }
      expect(parser.finish()).toBe(100);
    }
  });

  it('retains bounded state across a generated 50 MB stream', () => {
    const parser = new Mp3FrameCounter();
    const frame = defaultFrame();
    let maximum = 0;
    for (let index = 0; index < 120_000; index += 1) {
      parser.push(frame.subarray(0, 3));
      maximum = Math.max(maximum, parser.bufferedByteCount);
      parser.push(frame.subarray(3, 4));
      parser.push(frame.subarray(4));
    }
    expect(parser.finish()).toBe(120_000);
    expect(maximum).toBeLessThanOrEqual(10);
    expect(parser.bufferedByteCount).toBe(0);
  });

  it('counts the supplied fixture independently of its Xing audio-frame declaration', () => {
    const sample = readFileSync(
      new URL('../fixtures/assessment-sample.mp3', import.meta.url),
    );
    expect(createHash('sha256').update(sample).digest('hex')).toBe(
      '97707a18a58ba75122b1668f5ed738f090121343432d9172a6409ddfa4fc5ab3',
    );
    expect(sample.readUInt32BE(88)).toBe(6089);
    expect(count(sample, 16_384)).toBe(6090);
  });
});

describe('metadata envelopes', () => {
  it.each([2, 3, 4] as const)(
    'skips leading ID3v2.%i metadata containing a false MPEG frame',
    (major) => {
      expect(count(concatBytes(id3Tag(major), defaultFrame()), 1)).toBe(1);
    },
  );

  it.each([
    [2, 0xc0],
    [3, 0xe0],
    [4, 0xf0],
  ] as const)('accepts defined flags for ID3v2.%i', (major, flags) => {
    expect(count(concatBytes(id3Tag(major, flags), defaultFrame()))).toBe(1);
  });

  it('skips multiple leading tags and a zero-length tag without allocating payloads', () => {
    const zeroLengthTag = new Uint8Array([
      0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0,
    ]);
    expect(
      count(
        concatBytes(id3Tag(2), zeroLengthTag, id3Tag(4, 0x10), defaultFrame()),
      ),
    ).toBe(1);
  });

  it('skips a large declared tag incrementally with no payload buffer', () => {
    const parser = new Mp3FrameCounter();
    // Synchsafe 00 40 00 00 = 1,048,576 bytes.
    parser.push(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0x40, 0, 0]));
    const payload = new Uint8Array(65_536).fill(0xff);
    for (let index = 0; index < 16; index += 1) {
      parser.push(payload);
      expect(parser.bufferedByteCount).toBe(0);
    }
    parser.push(defaultFrame());
    expect(parser.finish()).toBe(1);
  });

  it('accepts appended ID3v2.4 and exact final ID3v1', () => {
    expect(count(concatBytes(defaultFrame(), id3Tag(4, 0x10), id3v1()))).toBe(
      1,
    );
    expect(count(concatBytes(defaultFrame(), id3Tag(4, 0x10)))).toBe(1);
    expect(count(concatBytes(defaultFrame(), id3v1()))).toBe(1);
  });

  it.each([2, 3, 4] as const)(
    'rejects appended ID3v2.%i without a matching v2.4 footer',
    (major) => {
      expect(
        failure(() => count(concatBytes(defaultFrame(), id3Tag(major)))),
      ).toMatchObject({ code: 'INVALID_MP3', offset: 417 });
    },
  );

  it.each([0, 3, 4, 5, 6, 9])(
    'rejects a mismatched ID3v2.4 footer field at byte %i',
    (index) => {
      const tag = id3Tag(4, 0x10);
      const position = tag.length - 10 + index;
      tag[position] = (tag[position] ?? 0) ^ 0x01;
      expect(
        failure(() => count(concatBytes(defaultFrame(), tag))),
      ).toMatchObject({ code: 'INVALID_MP3', offset: 844 });
    },
  );

  it('rejects a footer with a non-synchsafe size even when low bits match', () => {
    const tag = id3Tag(4, 0x10);
    tag[tag.length - 1] = 0xa1;
    expect(
      failure(() => count(concatBytes(defaultFrame(), tag))),
    ).toMatchObject({ code: 'INVALID_MP3' });
  });

  it.each([
    [2, 0x01],
    [3, 0x10],
    [4, 0x01],
  ] as const)('rejects reserved flags for ID3v2.%i', (major, flags) => {
    expect(
      failure(() => count(concatBytes(id3Tag(major, flags), defaultFrame()))),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 0 });
  });

  it.each([6, 7, 8, 9])('rejects a non-synchsafe size byte at %i', (index) => {
    const tag = id3Tag(4);
    tag[index] = 0x80;
    expect(failure(() => count(tag))).toMatchObject({
      code: 'INVALID_MP3',
      offset: 0,
    });
  });

  it.each([1, 5])('rejects unsupported ID3v2 major version %i', (major) => {
    const tag = id3Tag(4);
    tag[3] = major;
    expect(failure(() => count(tag))).toMatchObject({
      code: 'UNSUPPORTED_MP3',
    });
  });

  it('rejects invalid ID3 revision, truncated payload and truncated footer', () => {
    const badRevision = id3Tag(4);
    badRevision[4] = 0xff;
    expect(failure(() => count(badRevision))).toMatchObject({
      code: 'INVALID_MP3',
    });
    const tag = id3Tag(4, 0x10);
    expect(failure(() => count(tag.subarray(0, 426)))).toMatchObject({
      code: 'INVALID_MP3',
      offset: 0,
    });
    expect(failure(() => count(tag.subarray(0, tag.length - 1)))).toMatchObject(
      { code: 'INVALID_MP3', offset: 0 },
    );
  });

  it('rejects audio after appended metadata', () => {
    expect(
      failure(() =>
        count(concatBytes(defaultFrame(), id3Tag(4, 0x10), defaultFrame())),
      ),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 854 });
  });

  it('rejects an incomplete ID3v1, bytes after it, and a leading ID3v1', () => {
    expect(
      failure(() =>
        count(concatBytes(defaultFrame(), id3v1().subarray(0, 127))),
      ),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 417 });
    expect(
      failure(() =>
        count(concatBytes(defaultFrame(), id3v1(), new Uint8Array([0]))),
      ),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 545 });
    expect(failure(() => count(id3v1()))).toMatchObject({
      code: 'INVALID_MP3',
      offset: 0,
    });
  });
});

describe('strict completion and lifecycle', () => {
  it('rejects empty and tag-only files', () => {
    expect(failure(() => count(new Uint8Array())).code).toBe('INVALID_MP3');
    expect(failure(() => count(id3Tag(3))).code).toBe('INVALID_MP3');
  });

  it.each([1, 2, 3, 4, 100, 416])(
    'rejects a frame truncated to %i bytes',
    (length) => {
      expect(
        failure(() => count(defaultFrame().subarray(0, length))),
      ).toMatchObject({ code: 'INVALID_MP3', offset: 0 });
    },
  );

  it('rejects incomplete metadata headers and unexplained bytes without resynchronizing', () => {
    expect(
      failure(() => count(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 0 });
    const damaged = concatBytes(
      defaultFrame(),
      new Uint8Array([1, 2, 3, 4]),
      defaultFrame(),
    );
    expect(failure(() => count(damaged))).toMatchObject({
      code: 'INVALID_MP3',
      offset: 417,
    });
    expect(
      failure(() =>
        count(concatBytes(new Uint8Array([0, 0, 0, 0]), defaultFrame())),
      ),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 0 });
  });

  it('ignores empty chunks, makes finish idempotent, and prevents use after finish', () => {
    const parser = new Mp3FrameCounter();
    parser.push(new Uint8Array());
    parser.push(defaultFrame());
    parser.push(new Uint8Array());
    expect(parser.finish()).toBe(1);
    expect(parser.finish()).toBe(1);
    expect(() => parser.push(defaultFrame())).toThrow(
      'Cannot push bytes after finish().',
    );
  });

  it('preserves its original failure for later calls', () => {
    const parser = new Mp3FrameCounter();
    const error = failure(() => parser.push(new Uint8Array([0, 0, 0, 0])));
    expect(failure(() => parser.push(defaultFrame()))).toBe(error);
    expect(failure(() => parser.finish())).toBe(error);
    const truncated = new Mp3FrameCounter();
    truncated.push(defaultFrame().subarray(0, 100));
    const incomplete = failure(() => truncated.finish());
    expect(failure(() => truncated.finish())).toBe(incomplete);
  });
});

describe('bounded free-format synchronization', () => {
  const modeChanges = concatBytes(
    id3Tag(3),
    // Establish spacing with stereo, joint stereo and dual-channel headers.
    freeFrame(),
    freeFrame(418, true, 0x40, 0xfa),
    freeFrame(417, false, 0x80),
    // After confirmation, mono/stereo transitions preserve the padded stride.
    freeFrame(418, true, 0xc0, 0xfa),
    freeFrame(),
    freeFrame(417, false, 0xc0),
    freeFrame(418, true, 0x40, 0xfa),
    id3v1(),
  );

  it.each([1, 3, 4, 7, 417, 418, 1024, 4096])(
    'accepts confirmed mode changes with padding and CRC in %i-byte chunks',
    (chunkSize) => {
      expect(count(modeChanges, chunkSize)).toBe(7);
    },
  );

  it('preserves confirmed mode changes across deterministic random partitions', () => {
    for (const initialSeed of [1, 17, 98765]) {
      const parser = new Mp3FrameCounter();
      let seed = initialSeed;
      let offset = 0;
      let maximum = 0;
      while (offset < modeChanges.length) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const size = (seed % 997) + 1;
        parser.push(modeChanges.subarray(offset, offset + size));
        maximum = Math.max(maximum, parser.bufferedByteCount);
        offset += size;
      }
      expect(parser.finish()).toBe(7);
      expect(maximum).toBeLessThanOrEqual(2886);
    }
  });

  it.each([1, 7, 417, 1024, 4096])(
    'infers unpadded size with alternating padding in %i-byte chunks',
    (chunkSize) => {
      const bytes = concatBytes(
        freeFrame(418, true),
        freeFrame(),
        freeFrame(418, true),
        freeFrame(),
        id3v1(),
      );
      expect(count(bytes, chunkSize)).toBe(4);
    },
  );

  it('discards a false second-header candidate until a third header confirms the true boundary', () => {
    const first = freeFrame();
    first.set([0xff, 0xfb, 0x00, 0x00], 100);
    first.set([0xff, 0xfb, 0x04, 0x00], 140); // Different sample rate.
    first.set([0xff, 0xfb, 0x00, 0xc0], 180); // Different channel count.
    first.set([0xff, 0xfb, 0x90, 0x00], 240); // Indexed bitrate.
    expect(count(concatBytes(first, freeFrame(), freeFrame()), 37)).toBe(3);
  });

  it.each([
    ['first sync byte', [0xfe, 0xfb, 0x00, 0x00]],
    ['remaining sync bits', [0xff, 0xdb, 0x00, 0x00]],
    ['reserved version', [0xff, 0xeb, 0x00, 0x00]],
    ['reserved layer', [0xff, 0xf9, 0x00, 0x00]],
    ['reserved bitrate', [0xff, 0xfb, 0xf0, 0x00]],
    ['reserved sample rate', [0xff, 0xfb, 0x0c, 0x00]],
    ['reserved emphasis', [0xff, 0xfb, 0x00, 0x02]],
  ] as const)('ignores a false candidate with invalid %s', (_field, header) => {
    const first = freeFrame();
    first.set(header, 60);
    // This predicted third header must not confirm a malformed second header.
    first.set([0xff, 0xfb, 0x00, 0x00], 120);
    const bytes = concatBytes(first, freeFrame(), freeFrame());
    for (const chunkSize of [1, 37, 4096]) {
      expect(count(bytes, chunkSize)).toBe(3);
    }
  });

  it.each([1, 2])(
    'requires matching channel counts at discovery header index %i',
    (index) => {
      const frames = [freeFrame(), freeFrame(), freeFrame()];
      frames[index] = freeFrame(417, false, 0xc0);
      const bytes = concatBytes(...frames);
      for (const chunkSize of [1, 417, 4096]) {
        expect(failure(() => count(bytes, chunkSize))).toMatchObject({
          code: 'FREE_FORMAT_UNDETERMINED',
          offset: 0,
        });
      }
    },
  );

  it('confirms the largest structural frames at the 2,886-byte discovery limit', () => {
    const parser = new Mp3FrameCounter();
    const bytes = concatBytes(
      freeFrame(1441, false, 0, 0xfb, 8),
      freeFrame(1441, false, 0, 0xfb, 8),
      freeFrame(1441, false, 0, 0xfb, 8),
    );
    let maximum = 0;
    for (const byte of bytes) {
      parser.push(new Uint8Array([byte]));
      maximum = Math.max(maximum, parser.bufferedByteCount);
    }
    expect(parser.finish()).toBe(3);
    expect(maximum).toBeLessThanOrEqual(2886);
  });

  it.each([1, 2])(
    'rejects %i free-format frames without a third header',
    (frames) => {
      expect(
        failure(() =>
          count(
            concatBytes(...Array.from({ length: frames }, () => freeFrame())),
          ),
        ),
      ).toMatchObject({ code: 'FREE_FORMAT_UNDETERMINED', offset: 0 });
    },
  );

  it('bounds discovery even for a single huge incoming chunk', () => {
    const parser = new Mp3FrameCounter();
    const bytes = new Uint8Array(100_000);
    bytes.set([0xff, 0xfb, 0, 0]);
    expect(failure(() => parser.push(bytes))).toMatchObject({
      code: 'FREE_FORMAT_UNDETERMINED',
      offset: 0,
    });
    expect(parser.bufferedByteCount).toBe(2886);
  });

  it('rejects a truncated final frame after synchronization', () => {
    const bytes = concatBytes(
      freeFrame(),
      freeFrame(),
      freeFrame(),
      freeFrame(),
    );
    expect(
      failure(() => count(bytes.subarray(0, bytes.length - 1))),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 1251 });
  });

  it.each([
    ['sample rate', [0xff, 0xfb, 0x04, 0x00]],
    ['indexed bitrate', [0xff, 0xfb, 0x90, 0x00]],
  ] as const)(
    'rejects changed %s after free-format synchronization',
    (_field, header) => {
      expect(
        failure(() =>
          count(
            concatBytes(
              freeFrame(),
              freeFrame(),
              freeFrame(),
              createFrame(header, 417),
            ),
          ),
        ),
      ).toMatchObject({ code: 'INVALID_MP3', offset: 1251 });
    },
  );

  it('rejects a CRC change with insufficient mandatory side information', () => {
    const shortMono = freeFrame(21, false, 0xc0);
    expect(
      failure(() =>
        count(
          concatBytes(
            shortMono,
            shortMono,
            shortMono,
            freeFrame(21, false, 0xc0, 0xfa),
          ),
        ),
      ),
    ).toMatchObject({ code: 'INVALID_MP3', offset: 63 });
  });

  it.each([
    [21, false, 0xfb],
    [36, true, 0xfa],
  ] as const)(
    'rejects a mono-to-stereo change when the %i-byte base lacks side information',
    (base, padding, protection) => {
      const parser = new Mp3FrameCounter();
      const mono = freeFrame(base, false, 0xc0);
      parser.push(concatBytes(mono, mono, mono));
      const error = failure(() =>
        parser.push(
          freeFrame(base + (padding ? 1 : 0), padding, 0, protection),
        ),
      );
      expect(error).toMatchObject({
        code: 'INVALID_MP3',
        message: 'Invalid MPEG frame length.',
        offset: 3 * base,
      });
      expect(failure(() => parser.finish())).toBe(error);
      expect(failure(() => parser.push(freeFrame()))).toBe(error);
    },
  );
});
