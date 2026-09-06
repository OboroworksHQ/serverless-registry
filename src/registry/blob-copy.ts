import { MAXIMUM_CHUNK, MINIMUM_CHUNK } from "../chunk";
import { hexToDigest } from "../user";

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
  partSize = MAXIMUM_CHUNK,
): Promise<void> {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected) || partSize < MINIMUM_CHUNK || partSize > MAXIMUM_CHUNK) {
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
  const writer = digest.getWriter();
  void writer.closed.catch(() => undefined);
  const upload = await bucket.createMultipartUpload(targetKey, {
    customMetadata: { [verifiedDigestMetadata]: expected },
  });
  try {
    const parts: R2UploadedPart[] = [];
    for (let offset = 0; offset < source.size; offset += partSize) {
      const length = Math.min(partSize, source.size - offset);
      const object = await bucket.get(sourceKey, { range: { offset, length } });
      if (!object) throw new Error("Upload object disappeared");
      // Hash in the same backpressured stream as the upload; tee() could buffer GBs.
      const fixed = new FixedLengthStream(length);
      const input = object.body.getReader();
      const output = fixed.writable.getWriter();
      void input.closed.catch(() => undefined);
      void output.closed.catch(() => undefined);
      const transfer = (async () => {
        try {
          while (true) {
            const chunk = await input.read();
            if (chunk.done) break;
            await writer.write(chunk.value);
            await output.write(chunk.value);
          }
          await output.close();
        } catch (error) {
          await output.abort().catch(() => undefined);
          throw error;
        } finally {
          input.releaseLock();
          output.releaseLock();
        }
      })();
      void transfer.catch(() => undefined);
      try {
        parts.push(await upload.uploadPart(parts.length + 1, fixed.readable));
        await transfer;
      } catch (error) {
        await input.cancel().catch(() => undefined);
        await fixed.readable.cancel().catch(() => undefined);
        await transfer.catch(() => undefined);
        throw error;
      }
    }
    await writer.close();
    if (hexToDigest(await digest.digest) !== expected) throw new Error("Blob checksum mismatch");
    // The target and its verified metadata become visible only after hash validation.
    await upload.complete(parts);
  } catch (error) {
    await writer.abort().catch(() => undefined);
    await upload.abort().catch(() => undefined);
    throw error;
  } finally {
    writer.releaseLock();
  }
}
