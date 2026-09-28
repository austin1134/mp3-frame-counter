import { fileURLToPath } from 'node:url';
import request, { type Response as TestResponse } from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/http/app.js';
import {
  DEFAULT_UPLOAD_LIMITS,
  MULTIPART_OVERHEAD_BYTES,
} from '../../src/config.js';
import { Mp3FrameCounter } from '../../src/mp3/frame-counter.js';
import { defaultFrame } from '../helpers/mp3-fixtures.js';

function expectError(
  response: TestResponse,
  status: number,
  code: string,
): void {
  expect(response.status).toBe(status);
  expect(response.get('Content-Type')).toMatch(/^application\/json\b/u);
  expect(response.body).toMatchObject({
    error: { code, message: expect.any(String) as unknown },
  });
  expect(response.text).not.toContain('Error:');
}

afterEach(() => vi.restoreAllMocks());

describe('POST /file-upload', () => {
  it('counts every physical frame in the supplied assessment sample', async () => {
    const fixturePath = fileURLToPath(
      new URL('../fixtures/assessment-sample.mp3', import.meta.url),
    );
    const response = await request(createApp())
      .post('/file-upload')
      .attach('file', fixturePath);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ frameCount: 6090 });
  });

  it('returns only the physical frame count with a JSON content type', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach('file', Buffer.from(defaultFrame()), 'sample.mp3');

    expect(response.status).toBe(200);
    expect(response.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.body).toEqual({ frameCount: 1 });
    expect(response.get('X-Powered-By')).toBeUndefined();
  });

  it('accepts any file field name and determines the format from bytes', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach('recording', Buffer.from(defaultFrame()), {
        filename: 'not-an-mp3.txt',
        contentType: 'application/octet-stream',
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ frameCount: 1 });
  });

  it('rejects a request without a file', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .set('Content-Type', 'multipart/form-data; boundary=empty-form')
      .send('--empty-form--\r\n');

    expectError(response, 400, 'MISSING_FILE');
  });

  it('rejects an empty file rather than reporting zero frames', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach('file', Buffer.alloc(0), 'empty.mp3');

    expectError(response, 400, 'INVALID_MP3');
    expect(response.body).toMatchObject({
      error: { offset: expect.any(Number) as unknown },
    });
  });

  it.each(['application/json', 'audio/mpeg', 'text/plain'])(
    'rejects the unsupported request content type %s',
    async (contentType) => {
      const response = await request(createApp())
        .post('/file-upload')
        .set('Content-Type', contentType)
        .send(Buffer.from(defaultFrame()));

      expectError(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
    },
  );

  it('rejects a missing multipart boundary', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .set('Content-Type', 'multipart/form-data')
      .send('no boundary');

    expectError(response, 400, 'INVALID_MULTIPART');
  });

  it('rejects two files without returning the first file count', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach('first', Buffer.from(defaultFrame()), 'first.mp3')
      .attach('second', Buffer.from(defaultFrame()), 'second.mp3');

    expectError(response, 400, 'UNEXPECTED_PART');
    expect(response.body).not.toHaveProperty('frameCount');
  });

  it.each(['before', 'after'])(
    'rejects a text field %s the file',
    async (order) => {
      const upload = request(createApp()).post('/file-upload');
      if (order === 'before') upload.field('extra', 'unneeded');
      upload.attach('file', Buffer.from(defaultFrame()), 'sample.mp3');
      if (order === 'after') upload.field('extra', 'unneeded');

      expectError(await upload, 400, 'UNEXPECTED_PART');
    },
  );

  it('accepts a file exactly at the configured inclusive limit', async () => {
    const response = await request(
      createApp({ maxFileBytes: 417, maxRequestBytes: 2048 }),
    )
      .post('/file-upload')
      .attach('file', Buffer.from(defaultFrame()), 'sample.mp3');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ frameCount: 1 });
  });

  it('rejects the first extra byte without a reentrant Busboy error', async () => {
    const response = await request(
      createApp({ maxFileBytes: 417, maxRequestBytes: 2048 }),
    )
      .post('/file-upload')
      .attach(
        'file',
        Buffer.concat([Buffer.from(defaultFrame()), Buffer.from([0])]),
        'large.mp3',
      );

    expectError(response, 413, 'FILE_TOO_LARGE');
  });

  it('rejects upload truncation exactly after a complete frame', async () => {
    const response = await request(
      createApp({ maxFileBytes: 417, maxRequestBytes: 2048 }),
    )
      .post('/file-upload')
      .attach(
        'file',
        Buffer.concat([
          Buffer.from(defaultFrame()),
          Buffer.from(defaultFrame()),
        ]),
        'large.mp3',
      );

    expectError(response, 413, 'FILE_TOO_LARGE');
  });

  it('checks a declared request size before consuming the body', async () => {
    const response = await request(
      createApp({ maxFileBytes: 417, maxRequestBytes: 500 }),
    )
      .post('/file-upload')
      .attach('file', Buffer.from(defaultFrame()), 'sample.mp3');

    expectError(response, 413, 'REQUEST_TOO_LARGE');
  });

  it('rejects a truncated frame with a useful file-relative offset', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach(
        'file',
        Buffer.from(defaultFrame()).subarray(0, 416),
        'truncated.mp3',
      );

    expectError(response, 400, 'INVALID_MP3');
    expect(response.body).toMatchObject({
      error: { offset: expect.any(Number) as unknown },
    });
  });

  it('rejects ordinary non-MP3 bytes', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach('file', Buffer.from('This is not an MP3 file.'), 'fake.mp3');

    expectError(response, 400, 'INVALID_MP3');
  });

  it('reports another MPEG version as unsupported', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach(
        'file',
        Buffer.concat([Buffer.from([0xff, 0xf3, 0x90, 0]), Buffer.alloc(413)]),
        'mpeg-2.mp3',
      );

    expectError(response, 415, 'UNSUPPORTED_MP3');
  });

  it('reports an undetermined short free-format stream as unsupported', async () => {
    const response = await request(createApp())
      .post('/file-upload')
      .attach(
        'file',
        Buffer.concat([Buffer.from([0xff, 0xfb, 0, 0]), Buffer.alloc(413)]),
        'free.mp3',
      );

    expectError(response, 415, 'FREE_FORMAT_UNDETERMINED');
  });

  it('logs unexpected failures without exposing their details to the client', async () => {
    const failure = new Error('private implementation detail');
    vi.spyOn(Mp3FrameCounter.prototype, 'push').mockImplementationOnce(() => {
      throw failure;
    });
    const logger = vi.fn<(error: unknown) => void>();
    const response = await request(createApp({}, logger))
      .post('/file-upload')
      .attach('file', Buffer.from(defaultFrame()), 'sample.mp3');

    expectError(response, 500, 'INTERNAL_ERROR');
    expect(response.text).not.toContain(failure.message);
    expect(logger).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('handles a non-Error rejection as a sanitized internal failure', async () => {
    vi.spyOn(Mp3FrameCounter.prototype, 'push').mockImplementationOnce(() => {
      const thrownValue: unknown = 'unexpected third-party rejection';
      throw thrownValue;
    });
    const response = await request(createApp())
      .post('/file-upload')
      .attach('file', Buffer.from(defaultFrame()), 'sample.mp3');

    expectError(response, 500, 'INTERNAL_ERROR');
    expect(response.text).not.toContain('third-party');
  });
});

describe('HTTP application boundary', () => {
  it('derives the total request cap when only the file cap is overridden', async () => {
    const boundary = 'coherent-limits';
    const body = Buffer.concat([
      Buffer.alloc(MULTIPART_OVERHEAD_BYTES, 0x61),
      Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp3"\r\n\r\n`,
      ),
      Buffer.from(defaultFrame()),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await request(createApp({ maxFileBytes: 417 }))
      .post('/file-upload')
      .set('Content-Type', `multipart/form-data; boundary=${boundary}`)
      .send(body);

    expectError(response, 413, 'REQUEST_TOO_LARGE');
    expect(() =>
      createApp({ maxFileBytes: DEFAULT_UPLOAD_LIMITS.maxFileBytes + 1 }),
    ).not.toThrow();
  });

  it('returns a JSON method error and lists the supported method', async () => {
    const response = await request(createApp()).get('/file-upload');

    expectError(response, 405, 'METHOD_NOT_ALLOWED');
    expect(response.get('Allow')).toBe('POST');
  });

  it('returns a JSON not-found error', async () => {
    expectError(await request(createApp()).get('/missing'), 404, 'NOT_FOUND');
  });

  it.each([
    { maxFileBytes: 0 },
    { maxFileBytes: Number.NaN },
    { maxFileBytes: Number.MAX_SAFE_INTEGER },
    { maxRequestBytes: Number.POSITIVE_INFINITY },
    { maxFileBytes: 417, maxRequestBytes: 416 },
  ])('rejects invalid programmatic upload limits %j', (limits) => {
    expect(() => createApp(limits)).toThrow(RangeError);
  });
});
