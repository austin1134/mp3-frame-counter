import busboy from 'busboy';
import type { Request, Response } from 'express';
import type { Readable } from 'node:stream';

import type { UploadLimits } from '../config.js';
import { Mp3FrameCounter } from '../mp3/frame-counter.js';

export class UploadError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** A disconnected client cannot receive an HTTP error response. */
export class UploadAbortedError extends Error {
  constructor() {
    super('The client disconnected before the upload completed.');
    this.name = 'UploadAbortedError';
  }
}

/**
 * Own the multipart lifetime, independently of the MP3 parser. A file ending is
 * not success: a later part or a missing closing boundary can invalidate it.
 */
export function readMp3Upload(
  request: Request,
  response: Response,
  limits: UploadLimits,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let multipart: ReturnType<typeof busboy>;
    try {
      multipart = busboy({
        headers: request.headers,
        highWaterMark: 64 * 1024,
        fileHwm: 64 * 1024,
        limits: {
          files: 1,
          fields: 0,
          // Busboy emits partsLimit at equality, including the final boundary.
          // Two lets one part finish; encountering a second remains an error.
          parts: 2,
          // Its file limit also fires at equality. One extra byte makes our
          // documented maximum inclusive instead of rejecting an exact match.
          fileSize: limits.maxFileBytes + 1,
        },
      });
    } catch {
      reject(
        new UploadError(
          400,
          'INVALID_MULTIPART',
          'Provide a valid multipart/form-data body with a boundary.',
        ),
      );
      return;
    }

    let settled = false;
    let rawBytes = 0;
    let fileSeen = false;
    let fileEnded = false;
    let multipartFinished = false;
    let frameCount: number | undefined;
    let activeFile: Readable | undefined;

    const stopReading = (destroyParser: boolean): void => {
      request.removeListener('data', onRequestData);
      response.removeListener('close', onResponseClose);
      request.unpipe(multipart);

      if (destroyParser) {
        multipart.destroy();
        activeFile?.destroy();
        // Discard bytes until the error response closes the connection. Do not
        // destroy the request here: it shares the socket needed to send JSON.
        if (!request.destroyed && !request.complete) request.resume();
      }
      activeFile = undefined;
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      // Busboy mutates its file stream after emitting limit/data events.
      // Deferring teardown avoids destroying it inside those mutations.
      queueMicrotask(() => stopReading(true));
      reject(
        error instanceof Error
          ? error
          : new Error('An unexpected upload failure occurred.', {
              cause: error,
            }),
      );
    };

    const complete = (): void => {
      if (settled || !multipartFinished) return;
      if (!fileSeen) {
        fail(
          new UploadError(400, 'MISSING_FILE', 'Upload exactly one MP3 file.'),
        );
        return;
      }
      if (!fileEnded || frameCount === undefined) return;
      settled = true;
      stopReading(false);
      resolve(frameCount);
    };

    function onRequestData(chunk: Buffer): void {
      if (settled) return;
      rawBytes += chunk.byteLength;
      // This also bounds preamble/epilogue bytes that Busboy's file limit skips.
      if (rawBytes > limits.maxRequestBytes) {
        fail(
          new UploadError(
            413,
            'REQUEST_TOO_LARGE',
            `The multipart request exceeds ${limits.maxRequestBytes} bytes.`,
          ),
        );
      }
    }

    function onRequestError(): void {
      fail(new UploadAbortedError());
    }

    function onRequestClose(): void {
      request.removeListener('error', onRequestError);
      // IncomingMessage also closes normally after a complete HTTP body.
      if (!request.complete) fail(new UploadAbortedError());
    }

    function onResponseClose(): void {
      if (!response.writableFinished) fail(new UploadAbortedError());
    }

    const onMultipartError = (): void => {
      fail(
        new UploadError(
          400,
          'INVALID_MULTIPART',
          'The multipart body is malformed or ended before its closing boundary.',
        ),
      );
    };

    const onUnexpectedPart = (): void => {
      fail(
        new UploadError(
          400,
          'UNEXPECTED_PART',
          'Upload exactly one file without additional files or form fields.',
        ),
      );
    };

    request.on('data', onRequestData);
    request.on('error', onRequestError);
    request.once('close', onRequestClose);
    response.once('close', onResponseClose);

    multipart.on('error', onMultipartError);
    multipart.once('close', () => {
      if (!settled && !multipart.writableFinished) onMultipartError();
      multipart.removeListener('error', onMultipartError);
    });
    multipart.on('filesLimit', onUnexpectedPart);
    multipart.on('fieldsLimit', onUnexpectedPart);
    multipart.on('partsLimit', onUnexpectedPart);
    multipart.once('finish', () => {
      multipartFinished = true;
      complete();
    });

    multipart.on('file', (_fieldName, file) => {
      if (settled) {
        file.on('error', () => undefined);
        file.resume();
        return;
      }
      fileSeen = true;
      activeFile = file;
      const counter = new Mp3FrameCounter();
      const onFileError = (): void => {
        if (request.destroyed && !request.complete) {
          fail(new UploadAbortedError());
        } else {
          onMultipartError();
        }
      };
      file.on('error', onFileError);
      file.once('close', () => file.removeListener('error', onFileError));
      file.on('limit', () => {
        fail(
          new UploadError(
            413,
            'FILE_TOO_LARGE',
            `The uploaded file exceeds ${limits.maxFileBytes} bytes.`,
          ),
        );
      });
      file.on('data', (chunk: Buffer) => {
        if (settled) return;
        try {
          counter.push(chunk);
        } catch (error) {
          fail(error);
        }
      });
      file.once('end', () => {
        if (settled) return;
        if (file.truncated) {
          fail(
            new UploadError(
              413,
              'FILE_TOO_LARGE',
              'The file was truncated by the upload limit.',
            ),
          );
          return;
        }
        try {
          frameCount = counter.finish();
          fileEnded = true;
          complete();
        } catch (error) {
          fail(error);
        }
      });
    });

    // All error handlers must be installed before incoming bytes start flowing.
    request.pipe(multipart);
  });
}
