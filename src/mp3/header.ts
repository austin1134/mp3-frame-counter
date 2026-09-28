import { Mp3Error } from './errors.js';

const BITRATES_KBPS = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
] as const;
const SAMPLE_RATES_HZ = [44_100, 48_000, 32_000] as const;

/** Includes the optional padding byte; this is a structural bound, not a decoder. */
export const MAX_FRAME_BYTES = 1_441;

export interface Mp3FrameHeader {
  readonly bitrateIndex: number;
  readonly sampleRateHz: number;
  readonly padding: number;
  readonly channels: 1 | 2;
  readonly minimumFrameBytes: number;
  readonly frameBytes: number | undefined;
}

/** Read only the fields needed to find a physical MPEG-1 Layer III boundary. */
export function readFrameHeader(
  bytes: Uint8Array,
  offset: number,
): Mp3FrameHeader {
  const [first, second, third, fourth] = bytes;
  if (
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined
  ) {
    throw new Mp3Error('INVALID_MP3', 'Incomplete MPEG frame header.', offset);
  }
  if (first !== 0xff || (second & 0xe0) !== 0xe0) {
    throw new Mp3Error('INVALID_MP3', 'Expected an MPEG frame header.', offset);
  }

  const version = (second >>> 3) & 0x03;
  const layer = (second >>> 1) & 0x03;
  const bitrateIndex = third >>> 4;
  const sampleRateIndex = (third >>> 2) & 0x03;
  if (
    version === 1 ||
    layer === 0 ||
    bitrateIndex === 15 ||
    sampleRateIndex === 3 ||
    (fourth & 0x03) === 2
  ) {
    throw new Mp3Error(
      'INVALID_MP3',
      'MPEG frame header contains a reserved value.',
      offset,
    );
  }
  if (version !== 3 || layer !== 1) {
    throw new Mp3Error(
      'UNSUPPORTED_MP3',
      'Only MPEG-1 Audio Layer III is supported.',
      offset,
    );
  }

  const bitrateKbps = BITRATES_KBPS[bitrateIndex];
  const sampleRateHz = SAMPLE_RATES_HZ[sampleRateIndex];
  if (bitrateKbps === undefined || sampleRateHz === undefined) {
    throw new Mp3Error('INVALID_MP3', 'Invalid MPEG frame header.', offset);
  }

  const padding = (third >>> 1) & 1;
  const channels = fourth >>> 6 === 3 ? 1 : 2;
  const crcBytes = (second & 1) === 0 ? 2 : 0;
  const minimumFrameBytes = 4 + crcBytes + (channels === 1 ? 17 : 32);

  // 144 = 1,152 samples / 8 bits per byte. Length includes header and CRC;
  // adding either again would shift every subsequent frame boundary.
  const frameBytes =
    bitrateIndex === 0
      ? undefined
      : Math.floor((144_000 * bitrateKbps) / sampleRateHz) + padding;

  return {
    bitrateIndex,
    sampleRateHz,
    padding,
    channels,
    minimumFrameBytes,
    frameBytes,
  };
}
