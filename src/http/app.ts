import express, {
  type ErrorRequestHandler,
  type Express,
  type Request,
  type Response,
} from 'express';

import {
  DEFAULT_UPLOAD_LIMITS,
  MULTIPART_OVERHEAD_BYTES,
  type UploadLimits,
} from '../config.js';
import { Mp3Error } from '../mp3/errors.js';
import { readMp3Upload, UploadAbortedError, UploadError } from './upload.js';

interface ErrorBody {
  error: { code: string; message: string; offset?: number };
}

function closeIncompleteRequest(request: Request, response: Response): void {
  if (!request.complete) {
    response.setHeader('Connection', 'close');
    request.resume();
  }
}

export function createApp(
  options: Partial<UploadLimits> = {},
  logger?: (error: unknown) => void,
): Express {
  const maxFileBytes =
    options.maxFileBytes ?? DEFAULT_UPLOAD_LIMITS.maxFileBytes;
  const limits: UploadLimits = {
    maxFileBytes,
    maxRequestBytes:
      options.maxRequestBytes ?? maxFileBytes + MULTIPART_OVERHEAD_BYTES,
  };
  if (
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes <= 0 ||
    limits.maxFileBytes >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(limits.maxRequestBytes) ||
    limits.maxRequestBytes < limits.maxFileBytes
  ) {
    throw new RangeError(
      'Upload limits must be positive safe integers, with request bytes at least file bytes.',
    );
  }

  const app = express();
  app.disable('x-powered-by');

  app.post('/file-upload', async (request, response) => {
    const contentType = request.headers['content-type'];
    if (
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !==
      'multipart/form-data'
    ) {
      throw new UploadError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Send the MP3 file using multipart/form-data.',
      );
    }
    const contentLength = request.headers['content-length'];
    if (
      contentLength !== undefined &&
      Number(contentLength) > limits.maxRequestBytes
    ) {
      throw new UploadError(
        413,
        'REQUEST_TOO_LARGE',
        `The multipart request exceeds ${limits.maxRequestBytes} bytes.`,
      );
    }

    try {
      const frameCount = await readMp3Upload(request, response, limits);
      if (!response.destroyed && !response.writableEnded)
        response.json({ frameCount });
    } catch (error) {
      if (error instanceof UploadAbortedError) return;
      throw error;
    }
  });

  app.all('/file-upload', (request, response) => {
    closeIncompleteRequest(request, response);
    response.setHeader('Allow', 'POST');
    response.status(405).json({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'Use POST /file-upload to upload an MP3 file.',
      },
    } satisfies ErrorBody);
  });

  app.use((request, response) => {
    closeIncompleteRequest(request, response);
    response.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested endpoint does not exist.',
      },
    } satisfies ErrorBody);
  });

  const handleError: ErrorRequestHandler = (
    error: unknown,
    request,
    response,
    next,
  ) => {
    if (response.destroyed || response.writableEnded) return;
    if (response.headersSent) {
      next(error);
      return;
    }
    closeIncompleteRequest(request, response);
    if (error instanceof Mp3Error) {
      response.status(error.code === 'INVALID_MP3' ? 400 : 415).json({
        error: {
          code: error.code,
          message: error.message,
          offset: error.offset,
        },
      } satisfies ErrorBody);
    } else if (error instanceof UploadError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      } satisfies ErrorBody);
    } else {
      logger?.(error);
      response.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message:
            'The file could not be analyzed because of an internal error.',
        },
      } satisfies ErrorBody);
    }
  };
  app.use(handleError);
  return app;
}
