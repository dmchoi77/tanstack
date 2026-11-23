import {
  REMOTE_ERROR_CODES,
  errorMessage,
  isRetryableHttpStatus,
  type RemoteErrorCode,
} from "./remote-errors";

export type RemoteFetchOptions = {
  /** Maximum time for the request and response body to complete. Defaults to 10 seconds. */
  fetchTimeoutMs?: number;
  /** Maximum response body size in bytes. Defaults to 10 MiB. Set to 0 to disable. */
  fetchMaxBytes?: number;
};

export type { RemoteErrorCode } from "./remote-errors";

export class RemoteFetchError extends Error {
  readonly code: RemoteErrorCode;
  readonly url: string;
  readonly status?: number;
  readonly statusText?: string;
  readonly bodyPreview?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      code: RemoteErrorCode;
      url: string;
      status?: number;
      statusText?: string;
      bodyPreview?: string;
      retryable: boolean;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "RemoteFetchError";
    this.code = options.code;
    this.url = options.url;
    this.status = options.status;
    this.statusText = options.statusText;
    this.bodyPreview = options.bodyPreview;
    this.retryable = options.retryable;
  }
}

export const DEFAULT_REMOTE_FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_REMOTE_FETCH_MAX_BYTES = 10 * 1024 * 1024;

/** Fetches a remote response as text with a bounded timeout and response body. */
export async function fetchRemoteText(
  url: string,
  options: RemoteFetchOptions = {},
): Promise<string> {
  const timeoutMs = options.fetchTimeoutMs ?? DEFAULT_REMOTE_FETCH_TIMEOUT_MS;
  const maxBytes = options.fetchMaxBytes ?? DEFAULT_REMOTE_FETCH_MAX_BYTES;
  const controller = timeoutMs === 0 ? undefined : new AbortController();
  let timedOut = false;
  const timeout = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs)
    : undefined;

  try {
    let response: Response;
    try {
      response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    } catch (cause) {
      if (timedOut) {
        throw new RemoteFetchError(`${url} did not respond within ${timeoutMs} ms.`, {
          cause,
          code: REMOTE_ERROR_CODES.remoteFetchTimeout,
          retryable: true,
          url,
        });
      }
      throw new RemoteFetchError(errorMessage(cause), {
        cause,
        code: REMOTE_ERROR_CODES.remoteFetchNetwork,
        retryable: true,
        url,
      });
    }

    if (!response.ok) {
      let bodyPreview: string | undefined;
      try {
        bodyPreview = await readBodyPreview(response);
      } catch (cause) {
        if (timedOut) {
          throw new RemoteFetchError(`${url} did not respond within ${timeoutMs} ms.`, {
            cause,
            code: REMOTE_ERROR_CODES.remoteFetchTimeout,
            retryable: true,
            url,
          });
        }
      }
      throw new RemoteFetchError(`${url} responded with HTTP ${response.status}.`, {
        bodyPreview,
        code: REMOTE_ERROR_CODES.remoteFetchHttp,
        retryable: isRetryableHttpStatus(response.status),
        status: response.status,
        statusText: response.statusText,
        url,
      });
    }

    const contentLength = response.headers.get("content-length");
    if (maxBytes > 0 && contentLength && Number(contentLength) > maxBytes) {
      await response.body?.cancel();
      throw new RemoteFetchError(
        `${url} response exceeds the maximum size of ${maxBytes} bytes ` +
          `(content-length: ${contentLength}).`,
        {
          code: REMOTE_ERROR_CODES.remoteFetchBodyTooLarge,
          retryable: false,
          url,
        },
      );
    }

    if (!response.body) {
      const text = await response.text();
      assertResponseSize(url, new TextEncoder().encode(text).byteLength, maxBytes);
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        assertResponseSize(url, bytes, maxBytes);
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  } catch (cause) {
    if (cause instanceof RemoteFetchError) throw cause;
    if (timedOut) {
      throw new RemoteFetchError(`${url} did not respond within ${timeoutMs} ms.`, {
        cause,
        code: REMOTE_ERROR_CODES.remoteFetchTimeout,
        retryable: true,
        url,
      });
    }
    throw new RemoteFetchError(errorMessage(cause), {
      cause,
      code: REMOTE_ERROR_CODES.remoteFetchNetwork,
      retryable: true,
      url,
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Fetches and parses a remote JSON response using the shared fetch policy. */
export async function fetchRemoteJson<T>(
  url: string,
  options: RemoteFetchOptions = {},
): Promise<T> {
  const text = await fetchRemoteText(url, options);
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new RemoteFetchError(`Could not parse the JSON response from ${url}.`, {
      cause,
      code: REMOTE_ERROR_CODES.remoteFetchParse,
      retryable: false,
      url,
    });
  }
}

function assertResponseSize(url: string, bytes: number, maxBytes: number) {
  if (maxBytes > 0 && bytes > maxBytes) {
    throw new RemoteFetchError(
      `${url} response exceeds the maximum size of ${maxBytes} bytes (received: ${bytes}).`,
      {
        code: REMOTE_ERROR_CODES.remoteFetchBodyTooLarge,
        retryable: false,
        url,
      },
    );
  }
}

const MAX_BODY_PREVIEW = 240;

async function readBodyPreview(response: Response): Promise<string | undefined> {
  if (!response.body) {
    const text = await response.text();
    return normalizePreview(text);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_BODY_PREVIEW) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return normalizePreview(text);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function normalizePreview(text: string): string | undefined {
  const preview = text.replace(/\s+/g, " ").trim().slice(0, MAX_BODY_PREVIEW);
  return preview || undefined;
}
