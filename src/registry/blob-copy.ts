import { MINIMUM_CHUNK } from "../chunk";
import { hexToDigest } from "../user";

const maximumCopyPart = 32 * 1024 * 1024;

const verifiedDigestMetadata = "registry-verified-sha256";

export function verifiedBlobDigest(object: R2Object, expected: string): string {
  const digest = object.checksums.sha256
    ? hexToDigest(object.checksums.sha256)
    : object.customMetadata?.[verifiedDigestMetadata];
  if (digest !== expected || !/^sha256:[a-f0-9]{64}$/.test(expected)) {
    throw new Error("Blob checksum is missing or inconsistent");
  }
  return digest;
}

/** Finalize large blobs without the 5 GiB single-PUT limit or buffering entire parts. */
export async function copyVerifiedBlob(
  bucket: R2Bucket,
  sourceKey: string,
  targetKey: string,
  expected: string,
  partSize = maximumCopyPart,
): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected) || partSize < MINIMUM_CHUNK || partSize > maximumCopyPart) {
    throw new Error("Invalid blob copy parameters");
  }
  const source = await bucket.head(sourceKey);
  if (!source) throw new Error("Upload object is missing");
  const existing = await bucket.head(targetKey);
  if (existing && existing.size === source.size) {
    verifiedBlobDigest(existing, expected);
    return;
  }
  if (source.size <= partSize) {
    const object = await bucket.get(sourceKey);
    if (!object) throw new Error("Upload object is missing");
    await bucket.put(targetKey, object.body, { sha256: expected.slice(7) });
    return;
  }

  const digest = new crypto.DigestStream("SHA-256");
  // Aborted digest streams reject their result promise as well as writes.
  void digest.digest.catch(() => undefined);
  const upload = await bucket.createMultipartUpload(targetKey, {
    customMetadata: { [verifiedDigestMetadata]: expected },
  });
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0; offset < source.size; offset += partSize) {
      const length = Math.min(partSize, source.size - offset);
      const object = await bucket.get(sourceKey, { range: { offset, length } });
      if (!object) throw new Error("Upload object disappeared");
      // Each tee is bounded by this range (32 MiB by default), never the whole blob.
      // Native pipeTo avoids per-chunk JavaScript promise/copy overhead on multi-GiB layers.
      const [hashBody, uploadBody] = object.body.tee();
      const hashing = hashBody.pipeTo(digest, { preventClose: true });
      const fixed = new FixedLengthStream(length);
      const transfer = uploadBody.pipeTo(fixed.writable);
      const uploading = upload.uploadPart(parts.length + 1, fixed.readable).catch(async (error: unknown) => {
        // A provider may reject before taking a reader. Drain this bounded part so
        // the source/hash pipes finish without cancelling a native R2 stream.
        if (!fixed.readable.locked) await fixed.readable.pipeTo(new WritableStream()).catch(() => undefined);
        return { failure: error };
      });
      const results = await Promise.allSettled([hashing, transfer, uploading]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      const uploaded = results[2];
      if (uploaded.status === "fulfilled") {
        if ("failure" in uploaded.value) throw uploaded.value.failure;
        parts.push(uploaded.value);
      }
    }
    await digest.close();
    if (hexToDigest(await digest.digest) !== expected) throw new Error("Blob checksum mismatch");
    // The target and its verified metadata become visible only after hash validation.
    await upload.complete(parts);
  } catch (error) {
    await digest.abort().catch(() => undefined);
    await upload.abort().catch(() => undefined);
    throw error;
  }
}
