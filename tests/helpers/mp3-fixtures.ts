/** Synthetic structural fixtures; they do not claim to contain decodable audio. */
export function createFrame(
  header: readonly number[],
  length: number,
  fill = 0,
): Uint8Array {
  if (header.length !== 4 || length < 4)
    throw new Error('Invalid fixture frame.');
  const frame = new Uint8Array(length).fill(fill);
  frame.set(header);
  return frame;
}

/** Literal MPEG-1 Layer III, 128 kbps, 44.1 kHz, stereo, unpadded: 417 bytes. */
export function defaultFrame(): Uint8Array {
  return createFrame([0xff, 0xfb, 0x90, 0x00], 417);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
