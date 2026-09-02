import { ApiError } from './api-error.ts';

export async function readJson(request: Request, maximumBytes = 16_384) {
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ApiError(
      413,
      'PAYLOAD_TOO_LARGE',
      'The request body is too large.',
    );
  }

  const reader = request.body?.getReader();
  if (!reader)
    throw new ApiError(
      400,
      'INVALID_JSON',
      'The request body must be valid JSON.',
    );

  const decoder = new TextDecoder();
  let body = '';
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel();
        throw new ApiError(
          413,
          'PAYLOAD_TOO_LARGE',
          'The request body is too large.',
        );
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch {
    if (receivedBytes > maximumBytes) {
      throw new ApiError(
        413,
        'PAYLOAD_TOO_LARGE',
        'The request body is too large.',
      );
    }
    throw new ApiError(
      400,
      'INVALID_JSON',
      'The request body must be valid JSON.',
    );
  }
}
