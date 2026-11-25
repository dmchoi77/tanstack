// Routes a federated remote's server function calls to the remote's own server.
//
// A remote compiles its server functions with `serverFns.base` set to
// `/_federation/<name>/_serverFn`. In the browser, its code calls that path on the page's
// origin, which is the host's: the host forwards those requests to the remote's server.
// While the host renders the remote on the server, the remote's Node container calls the
// remote's server directly. Both read the remote's origin from the host's configuration.
// The container is bundled separately from the host, so the configuration lives on
// `globalThis`.

import {
  REMOTE_ERROR_CODES,
  errorMessage,
  reportRemoteError,
  type RemoteErrorCode,
  type RemoteErrorReporter,
} from "./remote-errors";

export type { RemoteErrorEvent, RemoteErrorReporter } from "./remote-errors";

const REGISTRY_KEY = Symbol.for("module-federation:tanstack:remote-server-functions");
// TanStack Start keeps its request context in one AsyncLocalStorage on `globalThis`, so
// every copy of Start in the process, including a remote container's, sees the same request.
const START_STORAGE_KEY = Symbol.for("tanstack-start:start-storage-context");

const BASE_PREFIX = "/_federation/";
const BASE_SUFFIX = "/_serverFn/";
const REMOTE_NAME = /^[A-Za-z0-9_$-]+$/;
const DEFAULT_TIMEOUT_MS = 10_000;

// The request headers TanStack Start's server function protocol uses. Credentials and
// any other header reach the remote only when `headers` returns them.
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "x-tsr-serverfn"];
// `fetch` decodes the body, so its encoding and length no longer apply. A remote does not
// set cookies for the host's origin.
const DROPPED_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "set-cookie",
  "transfer-encoding",
];

export type RemoteServerFunctionsTarget = {
  /**
   * The origin of the remote's server, such as `https://catalog.internal`. A function is
   * called for every request, so it can read the environment at runtime.
   */
  origin: string | (() => string);
  /**
   * Headers sent with every call to the remote, from the browser through the host and from
   * the host while it renders. Receives the request the host is handling. Cookies and
   * authorization headers reach the remote only when this returns them.
   */
  headers?: (context: {
    request: Request | undefined;
  }) => HeadersInit | undefined | Promise<HeadersInit | undefined>;
  /** Milliseconds to wait for the remote's response headers. Defaults to 10 seconds; 0 waits indefinitely. */
  timeoutMs?: number;
};

export type RemoteServerFunctionsOptions = {
  /** The remotes whose server functions the host routes, by their federation `name`. */
  remotes: Record<string, RemoteServerFunctionsTarget>;
  /** Receives structured server function failures. Callback errors are ignored. */
  onError?: RemoteErrorReporter;
};

export class RemoteServerFunctionError extends Error {
  readonly code: RemoteErrorCode;
  readonly remote: string;
  readonly url?: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      code: RemoteErrorCode;
      remote: string;
      retryable: boolean;
      url?: string;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "RemoteServerFunctionError";
    this.code = options.code;
    this.remote = options.remote;
    this.retryable = options.retryable;
    this.url = options.url;
  }
}

export type RemoteServerFunctions = {
  /**
   * Forwards a browser's call to a remote's server function, or returns `undefined` for
   * any other request.
   */
  handle(request: Request): Promise<Response> | undefined;
};

/** The `serverFns.base` a remote named `name` must use. */
export function remoteServerFunctionBase(name: string): string {
  return `${BASE_PREFIX}${name}${BASE_SUFFIX}`;
}

/**
 * Routes the server function calls of the given remotes to their servers. Call it where
 * the host's server loads it on startup, such as `src/start.ts`, and pass `handle` to a
 * request middleware.
 */
export function createRemoteServerFunctions({
  remotes,
  onError,
}: RemoteServerFunctionsOptions): RemoteServerFunctions {
  const targets = new Map<string, RegisteredTarget>();
  for (const [name, target] of Object.entries(remotes)) {
    if (!REMOTE_NAME.test(name)) throw new Error(`Invalid remote name "${name}"`);
    try {
      if (typeof target.origin === "string") resolveOrigin(name, target);
    } catch (cause) {
      const error = asRemoteServerFunctionError(cause, name);
      reportServerFunctionError(onError, error);
      throw error;
    }
    const registeredTarget = { ...target, onError };
    targets.set(name, registeredTarget);
    registry().set(name, registeredTarget);
  }

  return {
    handle(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(BASE_PREFIX)) return undefined;
      const name = url.pathname.slice(BASE_PREFIX.length).split("/", 1)[0] ?? "";
      const target = targets.get(name);
      const base = remoteServerFunctionBase(name);
      if (!target || !url.pathname.startsWith(base)) return undefined;
      return forward(request, url, name, base, target);
    },
  };
}

/**
 * Calls a remote's server function from the host's server. A remote's Node container
 * uses it in place of TanStack Start's server-rendering RPC.
 */
export function fetchRemoteServerFunction(
  name: string,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const target = registry().get(name);
  if (!target) {
    return Promise.reject(
      new Error(
        `The host rendered remote "${name}" on the server, and the remote called one of its ` +
          "server functions, but the host does not route that remote's server functions. " +
          "Pass the remote to createRemoteServerFunctions() from " +
          '"@module-federation/tanstack/server-functions" on the host.',
      ),
    );
  }
  const request = currentStartRequest();
  return fetchRemote(name, target, path, init, request, fetchImpl).catch((cause) => {
    if (init.signal?.aborted || request?.signal.aborted) throw cause;
    const error = asRemoteServerFunctionError(cause, name);
    reportServerFunctionError(target.onError, error);
    throw error;
  });
}

async function forward(
  request: Request,
  url: URL,
  name: string,
  base: string,
  target: RegisteredTarget,
): Promise<Response> {
  const functionId = url.pathname.slice(base.length);
  if (!functionId || /[/%]/.test(functionId) || functionId === "." || functionId === "..") {
    return new Response("Not found", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { headers: { allow: "GET, POST" }, status: 405 });
  }
  // The remote's server checks that calls come from its own origin, and every call
  // forwarded here does. Only forward calls from the host's own pages.
  if (!isSameOrigin(request, url.origin)) return new Response("Forbidden", { status: 403 });

  const headers = new Headers();
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(header);
    if (value !== null) headers.set(header, value);
  }

  let response: Response;
  try {
    response = await fetchRemote(
      name,
      target,
      url.pathname + url.search,
      {
        body: request.method === "POST" ? request.body : undefined,
        // Streams the browser's request body to the remote.
        duplex: "half",
        headers,
        method: request.method,
        signal: request.signal,
      } as RequestInit,
      request,
      fetch,
    );
  } catch (error) {
    if (request.signal.aborted) throw error;
    const remoteError = asRemoteServerFunctionError(error, name, url.toString());
    reportServerFunctionError(target.onError, remoteError);
    return new Response(`Remote "${name}" is unavailable`, { status: 502 });
  }

  const responseHeaders = new Headers(response.headers);
  for (const header of DROPPED_RESPONSE_HEADERS) responseHeaders.delete(header);
  return new Response(response.body, {
    headers: responseHeaders,
    status: response.status,
    statusText: response.statusText,
  });
}

async function fetchRemote(
  name: string,
  target: RegisteredTarget,
  path: string,
  init: RequestInit,
  request: Request | undefined,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const origin = resolveOrigin(name, target);
  const url = new URL(path, origin).toString();
  const headers = new Headers(init.headers);
  let extraHeaders: HeadersInit | undefined;
  try {
    extraHeaders = await target.headers?.({ request });
    if (extraHeaders) new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  } catch (cause) {
    throw new RemoteServerFunctionError(
      `Could not prepare headers for remote "${name}" server function.`,
      {
        cause,
        code: REMOTE_ERROR_CODES.remoteServerFunctionConfig,
        remote: name,
        retryable: false,
        url,
      },
    );
  }
  // Server-to-server calls carry no browser headers, so they present the remote's origin to
  // pass its cross-site request check.
  headers.set("origin", origin);

  const timeoutMs = target.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new AbortController();
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          timeout.abort(new Error(`Remote "${name}" did not respond in ${timeoutMs} ms`));
        }, timeoutMs)
      : undefined;
  const signals = [timeout.signal, init.signal, request?.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  try {
    // The timeout covers the response headers only, so a streamed response can take longer.
    return await fetchImpl(new URL(path, origin), {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch (cause) {
    if (init.signal?.aborted || request?.signal.aborted) throw cause;
    throw new RemoteServerFunctionError(
      timedOut
        ? `Remote "${name}" did not respond in ${timeoutMs} ms.`
        : `Could not reach remote "${name}" at ${url}: ${errorMessage(cause)}`,
      {
        cause,
        code: timedOut
          ? REMOTE_ERROR_CODES.remoteServerFunctionTimeout
          : REMOTE_ERROR_CODES.remoteServerFunctionNetwork,
        remote: name,
        retryable: true,
        url,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function resolveOrigin(name: string, target: RemoteServerFunctionsTarget): string {
  let value: string;
  try {
    value = typeof target.origin === "function" ? target.origin() : target.origin;
  } catch (cause) {
    throw new RemoteServerFunctionError(
      `Could not resolve the origin of remote "${name}" server functions.`,
      {
        cause,
        code: REMOTE_ERROR_CODES.remoteServerFunctionConfig,
        remote: name,
        retryable: false,
      },
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteServerFunctionError(`Remote "${name}" has an invalid origin: ${value}`, {
      code: REMOTE_ERROR_CODES.remoteServerFunctionConfig,
      remote: name,
      retryable: false,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteServerFunctionError(
      `Remote "${name}" needs an http or https origin: ${value}`,
      {
        code: REMOTE_ERROR_CODES.remoteServerFunctionConfig,
        remote: name,
        retryable: false,
      },
    );
  }
  return url.origin;
}

function isSameOrigin(request: Request, origin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null) return requestOrigin === origin;
  const referer = request.headers.get("referer");
  if (referer === null) return false;
  try {
    return new URL(referer).origin === origin;
  } catch {
    return false;
  }
}

type RegisteredTarget = RemoteServerFunctionsTarget & { onError?: RemoteErrorReporter };

function registry(): Map<string, RegisteredTarget> {
  const global = globalThis as { [REGISTRY_KEY]?: Map<string, RegisteredTarget> };
  return (global[REGISTRY_KEY] ??= new Map());
}

function asRemoteServerFunctionError(
  cause: unknown,
  remote: string,
  url?: string,
): RemoteServerFunctionError {
  if (cause instanceof RemoteServerFunctionError) return cause;
  return new RemoteServerFunctionError(`Could not reach remote "${remote}" server function.`, {
    cause,
    code: REMOTE_ERROR_CODES.remoteServerFunctionNetwork,
    remote,
    retryable: true,
    url,
  });
}

function reportServerFunctionError(
  reporter: RemoteErrorReporter | undefined,
  error: RemoteServerFunctionError,
) {
  reportRemoteError(reporter, {
    code: error.code,
    error,
    remote: error.remote,
    retryable: error.retryable,
    url: error.url,
  });
}

function currentStartRequest(): Request | undefined {
  const storage = (globalThis as Record<symbol, unknown>)[START_STORAGE_KEY] as
    { getStore(): { request?: Request } | undefined } | undefined;
  return storage?.getStore()?.request;
}
