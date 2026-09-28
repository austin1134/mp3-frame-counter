export type Mp3ErrorCode =
  'INVALID_MP3' | 'UNSUPPORTED_MP3' | 'FREE_FORMAT_UNDETERMINED';

/** A structural parsing failure with an offset relative to the uploaded file. */
export class Mp3Error extends Error {
  constructor(
    public readonly code: Mp3ErrorCode,
    message: string,
    public readonly offset: number,
  ) {
    super(message);
    this.name = 'Mp3Error';
  }
}
