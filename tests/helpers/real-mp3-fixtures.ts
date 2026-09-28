/** Fixed expectations from FFprobe packet byte ranges, not the application parser.
 * See tests/fixtures/README.md for provenance, generation commands and hashes.
 */
export const realMp3Fixtures = [
  {
    file: 'lame-cbr-44100-mono.mp3',
    bytes: 11_786,
    frameCount: 55,
    sha256: 'ecdbf29a8cd4bf4c58a067635f7d17a5ddb1ba1cf14a418ef40709dfb7a89e0a',
  },
  {
    file: 'lame-vbr-48000-mono.mp3',
    bytes: 15_591,
    frameCount: 60,
    sha256: '4c7ccc60917dde5abb37b733ed491ab1cfa2112920d1c92bb701a638244d0285',
  },
  {
    file: 'mediafoundation-cbr-32000-stereo.mp3',
    bytes: 23_191,
    frameCount: 40,
    sha256: '6ccc082619ad7b545a8a78c7c43ffa53480239f4a95e3cef45b5eed651285e2f',
  },
] as const;
