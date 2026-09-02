import type { ApiFailure } from './types';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

export async function parseApiResponse<T extends object>(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  let body: T | ApiFailure | undefined;
  if (contentType.toLowerCase().includes('json')) {
    try {
      body = (await response.json()) as T | ApiFailure;
    } catch {
      body = undefined;
    }
  }

  if (!response.ok) {
    const failure = body && 'error' in body ? body.error : undefined;
    throw new ApiClientError(
      failure?.message ?? `The server returned HTTP ${response.status}.`,
      response.status,
      failure?.code,
    );
  }
  if (!body) {
    throw new ApiClientError(
      'The server returned an unreadable response.',
      response.status,
    );
  }
  return body as T;
}
