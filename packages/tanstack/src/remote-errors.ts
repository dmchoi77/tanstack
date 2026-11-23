export const REMOTE_ERROR_CODES = {
  remoteFetchNetwork: "TANSTACK-REMOTE-FETCH-NETWORK",
  remoteFetchTimeout: "TANSTACK-REMOTE-FETCH-TIMEOUT",
  remoteFetchHttp: "TANSTACK-REMOTE-FETCH-HTTP",
  remoteFetchBodyTooLarge: "TANSTACK-REMOTE-FETCH-BODY-TOO-LARGE",
  remoteFetchParse: "TANSTACK-REMOTE-FETCH-PARSE",
  remoteEntryEvaluate: "TANSTACK-REMOTE-ENTRY-EVALUATE",
  remoteEntryLoader: "TANSTACK-REMOTE-ENTRY-LOADER",
  serverFunctionNetwork: "TANSTACK-SERVER-FUNCTION-NETWORK",
  serverFunctionTimeout: "TANSTACK-SERVER-FUNCTION-TIMEOUT",
  serverFunctionConfig: "TANSTACK-SERVER-FUNCTION-CONFIG",
} as const;

export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];

export const REMOTE_ERROR_DESCRIPTIONS: Record<RemoteErrorCode, string> = {
  [REMOTE_ERROR_CODES.remoteFetchNetwork]: "A remote resource could not be reached.",
  [REMOTE_ERROR_CODES.remoteFetchTimeout]: "A remote resource did not respond before the timeout.",
  [REMOTE_ERROR_CODES.remoteFetchHttp]: "A remote resource returned an HTTP error.",
  [REMOTE_ERROR_CODES.remoteFetchBodyTooLarge]:
    "A remote response exceeded the configured size limit.",
  [REMOTE_ERROR_CODES.remoteFetchParse]: "A remote response could not be parsed.",
  [REMOTE_ERROR_CODES.remoteEntryEvaluate]: "A remote server entry could not be evaluated.",
  [REMOTE_ERROR_CODES.remoteEntryLoader]: "A remote server entry loader could not load the entry.",
  [REMOTE_ERROR_CODES.serverFunctionNetwork]: "A remote server function could not be reached.",
  [REMOTE_ERROR_CODES.serverFunctionTimeout]: "A remote server function timed out.",
  [REMOTE_ERROR_CODES.serverFunctionConfig]: "A remote server function target is invalid.",
};

export type RemoteEntryPhase = "fetch" | "evaluate" | "loader";

export type RemoteErrorEvent = {
  error: Error;
  code: RemoteErrorCode;
  remote?: string;
  url?: string;
  phase?: RemoteEntryPhase;
  retryable: boolean;
  status?: number;
  statusText?: string;
  bodyPreview?: string;
};

export type RemoteErrorReporter = (event: RemoteErrorEvent) => void;

export function reportRemoteError(
  reporter: RemoteErrorReporter | undefined,
  event: RemoteErrorEvent,
) {
  if (!reporter) return;
  try {
    reporter(event);
  } catch {
    // Observability must never replace the original remote error.
  }
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
