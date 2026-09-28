import { describe, expect, it } from 'vitest';
import { Mp3Error } from '../../src/mp3/errors.js';
import { readFrameHeader } from '../../src/mp3/header.js';

// Expected byte lengths are independent literals, not the production formula.
const BITRATE_CASES = [
  [0x10, 104, 96, 144],
  [0x20, 130, 120, 180],
  [0x30, 156, 144, 216],
  [0x40, 182, 168, 252],
  [0x50, 208, 192, 288],
  [0x60, 261, 240, 360],
  [0x70, 313, 288, 432],
  [0x80, 365, 336, 504],
  [0x90, 417, 384, 576],
  [0xa0, 522, 480, 720],
  [0xb0, 626, 576, 864],
  [0xc0, 731, 672, 1008],
  [0xd0, 835, 768, 1152],
  [0xe0, 1044, 960, 1440],
] as const;

describe('MPEG-1 Layer III headers', () => {
  it.each(BITRATE_CASES)(
    'reads bitrate byte %i across rates, padding, CRC and modes',
    (bitrate, rate44100, rate48000, rate32000) => {
      const rates = [
        [0x00, 44_100, rate44100],
        [0x04, 48_000, rate48000],
        [0x08, 32_000, rate32000],
      ] as const;
      for (const [rateBits, sampleRateHz, expectedLength] of rates) {
        for (const padding of [0, 1]) {
          for (const protection of [0xfa, 0xfb]) {
            for (const mode of [0x00, 0x40, 0x80, 0xc0]) {
              const parsed = readFrameHeader(
                new Uint8Array([
                  0xff,
                  protection,
                  bitrate | rateBits | (padding << 1),
                  mode,
                ]),
                0,
              );
              expect(parsed.frameBytes).toBe(expectedLength + padding);
              expect(parsed.sampleRateHz).toBe(sampleRateHz);
              expect(parsed.channels).toBe(mode === 0xc0 ? 1 : 2);
              expect(parsed.minimumFrameBytes).toBe(
                4 + (protection === 0xfa ? 2 : 0) + (mode === 0xc0 ? 17 : 32),
              );
            }
          }
        }
      }
    },
  );

  it('distinguishes free format from reserved bitrate indices', () => {
    expect(
      readFrameHeader(new Uint8Array([0xff, 0xfb, 0x00, 0x00]), 123),
    ).toMatchObject({
      bitrateIndex: 0,
      frameBytes: undefined,
      minimumFrameBytes: 36,
    });
  });

  it.each([
    [0xff, 0xeb, 0x90, 0x00], // Reserved version.
    [0xff, 0xf9, 0x90, 0x00], // Reserved layer.
    [0xff, 0xfb, 0xf0, 0x00], // Reserved bitrate.
    [0xff, 0xfb, 0x9c, 0x00], // Reserved frequency.
    [0xff, 0xfb, 0x90, 0x02], // Reserved emphasis.
    [0x00, 0xfb, 0x90, 0x00],
    [0xff, 0x00, 0x90, 0x00],
  ])('rejects malformed header %s %s %s %s', (...bytes) => {
    const parse = () => readFrameHeader(new Uint8Array(bytes), 27);
    expect(parse).toThrow(Mp3Error);
    try {
      parse();
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_MP3', offset: 27 });
    }
  });

  it.each([
    [0xff, 0xf3, 0x90, 0x00], // MPEG-2 Layer III.
    [0xff, 0xe3, 0x90, 0x00], // MPEG-2.5 Layer III.
    [0xff, 0xfd, 0x90, 0x00], // MPEG-1 Layer II.
    [0xff, 0xff, 0x90, 0x00], // MPEG-1 Layer I.
  ])('reports unsupported encoding %s %s %s %s', (...bytes) => {
    try {
      readFrameHeader(new Uint8Array(bytes), 4);
    } catch (error) {
      expect(error).toMatchObject({ code: 'UNSUPPORTED_MP3', offset: 4 });
      return;
    }
    throw new Error('Expected an unsupported header.');
  });

  it.each([0, 1, 2, 3])('rejects a %i-byte header', (length) => {
    expect(() =>
      readFrameHeader(
        new Uint8Array([0xff, 0xfb, 0x90, 0x00]).subarray(0, length),
        0,
      ),
    ).toThrow('Incomplete MPEG frame header.');
  });
});
