import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages", "tanstack", "dist");
const { RemoteFetchError, fetchRemoteJson, fetchRemoteText } = await import(
  pathToFileURL(join(dist, "remote-fetch.js")).href
);

const originalFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = originalFetch;
});

test("fetchRemoteText enforces the response size limit while streaming", async () => {
  globalThis.fetch = async () => new Response("0123456789", { status: 200 });

  await assert.rejects(
    fetchRemoteText("https://remote.test/entry.js", { fetchMaxBytes: 5 }),
    (error) => {
      assert.ok(error instanceof RemoteFetchError);
      assert.equal(error.code, "TANSTACK-REMOTE-FETCH-BODY-TOO-LARGE");
      assert.equal(error.retryable, false);
      assert.match(error.message, /exceeds the maximum size of 5 bytes/);
      return true;
    },
  );
});

test("fetchRemoteText rejects a response whose content-length is already too large", async () => {
  globalThis.fetch = async () =>
    new Response("ok", { headers: { "content-length": "100" }, status: 200 });

  await assert.rejects(
    fetchRemoteText("https://remote.test/entry.js", { fetchMaxBytes: 5 }),
    /content-length: 100/,
  );
});

test("fetchRemoteJson rejects non-2xx and malformed responses", async () => {
  globalThis.fetch = async (url) =>
    url.endsWith("/missing")
      ? new Response("missing", { status: 404 })
      : new Response("not-json", { status: 200 });

  await assert.rejects(fetchRemoteJson("https://remote.test/missing"), (error) => {
    assert.ok(error instanceof RemoteFetchError);
    assert.equal(error.code, "TANSTACK-REMOTE-FETCH-HTTP");
    assert.equal(error.status, 404);
    assert.equal(error.retryable, false);
    assert.equal(error.bodyPreview, "missing");
    assert.match(error.message, /HTTP 404/);
    return true;
  });
  await assert.rejects(fetchRemoteJson("https://remote.test/malformed"), (error) => {
    assert.ok(error instanceof RemoteFetchError);
    assert.equal(error.code, "TANSTACK-REMOTE-FETCH-PARSE");
    assert.equal(error.retryable, false);
    assert.match(error.message, /Could not parse/);
    return true;
  });
});

test("fetchRemoteText bounds HTTP error previews", async () => {
  globalThis.fetch = async () => new Response("x".repeat(500), { status: 503 });

  await assert.rejects(fetchRemoteText("https://remote.test/unavailable"), (error) => {
    assert.ok(error instanceof RemoteFetchError);
    assert.equal(error.code, "TANSTACK-REMOTE-FETCH-HTTP");
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    assert.equal(error.bodyPreview.length, 240);
    return true;
  });
});

test("fetchRemoteText classifies a timeout while reading an HTTP error preview", async () => {
  globalThis.fetch = async (_url, { signal }) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("partial"));
          signal.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
      }),
      { status: 404 },
    );

  await assert.rejects(
    fetchRemoteText("https://remote.test/stalled", { fetchTimeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof RemoteFetchError);
      assert.equal(error.code, "TANSTACK-REMOTE-FETCH-TIMEOUT");
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test("fetchRemoteText aborts a request that exceeds the timeout", async () => {
  globalThis.fetch = async (_url, { signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

  await assert.rejects(
    fetchRemoteText("https://remote.test/slow", { fetchTimeoutMs: 5 }),
    (error) => {
      assert.ok(error instanceof RemoteFetchError);
      assert.equal(error.code, "TANSTACK-REMOTE-FETCH-TIMEOUT");
      assert.equal(error.retryable, true);
      assert.equal(error.cause.name, "AbortError");
      return true;
    },
  );
});

test("fetchRemoteText classifies network failures as retryable", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("socket closed");
  };

  await assert.rejects(fetchRemoteText("https://remote.test/offline"), (error) => {
    assert.ok(error instanceof RemoteFetchError);
    assert.equal(error.code, "TANSTACK-REMOTE-FETCH-NETWORK");
    assert.equal(error.retryable, true);
    assert.equal(error.cause.message, "socket closed");
    return true;
  });
});
