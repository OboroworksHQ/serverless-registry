import { afterEach, expect, test, vi } from "vitest";
import type { Env } from "..";
import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { copyVerifiedBlob, verifiedBlobDigest } from "../src/registry/blob-copy";
import { MINIMUM_CHUNK } from "../src/chunk";
import { hexToDigest } from "../src/user";

const size = MINIMUM_CHUNK * 2 + 17;
const body = new Uint8Array(size).fill(37);
const digest = hexToDigest(await crypto.subtle.digest("SHA-256", body));

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

test("multipart copy preserves bytes and verified digest under repeated delivery", async () => {
  await (env as Env).REGISTRY.put("source", body);
  const create = vi.spyOn((env as Env).REGISTRY, "createMultipartUpload");
  await copyVerifiedBlob((env as Env).REGISTRY, "source", "target", digest, MINIMUM_CHUNK);
  const result = await (env as Env).REGISTRY.get("target");
  expect(result).not.toBeNull();
  expect(verifiedBlobDigest(result!, digest)).toBe(digest);
  expect(result!.size).toBe(body.byteLength);
  expect(hexToDigest(await crypto.subtle.digest("SHA-256", await result!.arrayBuffer()))).toBe(digest);
  await copyVerifiedBlob((env as Env).REGISTRY, "source", "target", digest, MINIMUM_CHUNK);
  expect(create).toHaveBeenCalledTimes(1);
  expect(await (env as Env).REGISTRY.head("source")).not.toBeNull();
});

test("wrong digest aborts multipart output and retains the source for retry", async () => {
  await (env as Env).REGISTRY.put("source", body);
  await expect(
    copyVerifiedBlob((env as Env).REGISTRY, "source", "target", "sha256:" + "0".repeat(64), MINIMUM_CHUNK),
  ).rejects.toThrow("checksum mismatch");
  expect(await (env as Env).REGISTRY.head("target")).toBeNull();
  expect(await (env as Env).REGISTRY.head("source")).not.toBeNull();
  await copyVerifiedBlob((env as Env).REGISTRY, "source", "target", digest, MINIMUM_CHUNK);
  expect(verifiedBlobDigest((await (env as Env).REGISTRY.head("target"))!, digest)).toBe(digest);
});

test("small object path keeps native R2 checksum verification", async () => {
  const small = new Uint8Array([1, 2, 3]);
  const sha = hexToDigest(await crypto.subtle.digest("SHA-256", small));
  await (env as Env).REGISTRY.put("source", small);
  const create = vi.spyOn((env as Env).REGISTRY, "createMultipartUpload");
  await copyVerifiedBlob((env as Env).REGISTRY, "source", "target", sha);
  expect(create).not.toHaveBeenCalled();
  expect(verifiedBlobDigest((await (env as Env).REGISTRY.head("target"))!, sha)).toBe(sha);
});

test("unverified multipart metadata fails closed", async () => {
  await (env as Env).REGISTRY.put("source", body);
  const stored = (await (env as Env).REGISTRY.head("source"))!;
  expect(() => verifiedBlobDigest({ ...stored, checksums: {} } as R2Object, digest)).toThrow("checksum");
});

test("failed part aborts the destination and can be retried", async () => {
  const bucket = (env as Env).REGISTRY;
  await bucket.put("source", body);
  const create = bucket.createMultipartUpload.bind(bucket);
  const abort = vi.fn();
  const spy = vi.spyOn(bucket, "createMultipartUpload").mockImplementationOnce(async (...args) => {
    const upload = await create(...args);
    const originalAbort = upload.abort.bind(upload);
    vi.spyOn(upload, "uploadPart").mockImplementationOnce(async (_part, stream) => {
      // Model a provider failure after receiving a part, before acknowledging it.
      await new Response(stream as ReadableStream).arrayBuffer();
      throw new Error("synthetic part failure");
    });
    vi.spyOn(upload, "abort").mockImplementation(async () => {
      abort();
      await originalAbort();
    });
    return upload;
  });
  await expect(copyVerifiedBlob(bucket, "source", "target", digest, MINIMUM_CHUNK)).rejects.toThrow(
    "synthetic part failure",
  );
  expect(abort).toHaveBeenCalledTimes(1);
  expect(await bucket.head("target")).toBeNull();
  spy.mockRestore();
  await copyVerifiedBlob(bucket, "source", "target", digest, MINIMUM_CHUNK);
  expect(verifiedBlobDigest((await bucket.head("target"))!, digest)).toBe(digest);
});

test("registry HEAD, GET and mount accept verified multipart blobs", async () => {
  const { R2Registry } = await import("../src/registry/r2");
  const bindings = { ...(env as Env) };
  const registry = new R2Registry(bindings);
  bindings.REGISTRY_CLIENT = registry;
  await bindings.REGISTRY.put("source", body);
  await copyVerifiedBlob(bindings.REGISTRY, "source", `first/blobs/${digest}`, digest, MINIMUM_CHUNK);
  const head = await registry.layerExists("first", digest);
  expect(head).toMatchObject({ exists: true, digest, size });
  const blob = await registry.getLayer("first", digest);
  expect(blob).toMatchObject({ digest, size });
  if ("response" in blob) throw new Error("Expected a blob");
  await new Response(blob.stream).arrayBuffer();
  expect(await registry.mountExistingLayer("first", digest, "second")).toMatchObject({ digest });
  expect(await registry.layerExists("second", digest)).toMatchObject({ exists: true, digest, size });
});
