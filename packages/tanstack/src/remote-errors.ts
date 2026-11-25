export const REMOTE_ERROR_CODES = {
  remoteFetchNetwork: "TANSTACK-REMOTE-FETCH-NETWORK",
  remoteFetchTimeout: "TANSTACK-REMOTE-FETCH-TIMEOUT",
  remoteFetchHttp: "TANSTACK-REMOTE-FETCH-HTTP",
  remoteFetchBodyTooLarge: "TANSTACK-REMOTE-FETCH-BODY-TOO-LARGE",
  remoteFetchParse: "TANSTACK-REMOTE-FETCH-PARSE",
  remoteEntryEvaluate: "TANSTACK-REMOTE-ENTRY-EVALUATE",
  remoteEntryLoader: "TANSTACK-REMOTE-ENTRY-LOADER",
  remoteServerFunctionNetwork: "TANSTACK-SERVER-FUNCTION-NETWORK",
  remoteServerFunctionTimeout: "TANSTACK-SERVER-FUNCTION-TIMEOUT",
  remoteServerFunctionConfig: "TANSTACK-SERVER-FUNCTION-CONFIG",
} as const;

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];

export const REMOTE_ERROR_DESCRIPTIONS: Record<RemoteErrorCode, string> = {
  [REMOTE_ERROR_CODES.remoteFetchNetwork]: "A remote resource could not be reached.",
  [REMOTE_ERROR_CODES.remoteFetchTimeout]: "A remote request did not complete before the timeout.",
  [REMOTE_ERROR_CODES.remoteFetchHttp]: "A remote resource returned an HTTP error.",
  [REMOTE_ERROR_CODES.remoteFetchBodyTooLarge]:
    "A remote response exceeded the configured size limit.",
  [REMOTE_ERROR_CODES.remoteFetchParse]: "A remote response could not be parsed.",
  [REMOTE_ERROR_CODES.remoteEntryEvaluate]: "A remote server entry could not be evaluated.",
  [REMOTE_ERROR_CODES.remoteEntryLoader]: "A remote server entry loader could not load the entry.",
  [REMOTE_ERROR_CODES.remoteServerFunctionNetwork]:
    "A remote server function could not be reached.",
  [REMOTE_ERROR_CODES.remoteServerFunctionTimeout]:
    "A remote server function did not respond before the timeout.",
  [REMOTE_ERROR_CODES.remoteServerFunctionConfig]:
    "A remote server function has invalid configuration.",
};

export type RemoteErrorPhase = "fetch" | "evaluate" | "loader";

export type RemoteErrorEvent = {
  error: Error;
  code: RemoteErrorCode;
  remote?: string;
  url?: string;
  phase?: RemoteErrorPhase;
  retryable: boolean;
  status?: number;
  statusText?: string;
  bodyPreview?: string;
};

export type RemoteErrorReporter = (event: RemoteErrorEvent) => void | PromiseLike<void>;

/** Reports an error without allowing instrumentation to change application behavior. */
export function reportRemoteError(
  reporter: RemoteErrorReporter | undefined,
  event: RemoteErrorEvent,
): void {
  if (!reporter) return;
  try {
    void Promise.resolve(reporter(event)).catch(() => undefined);
  } catch {
    // Observability must never replace the original error or response.
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
