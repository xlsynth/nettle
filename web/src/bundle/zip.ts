// SPDX-License-Identifier: Apache-2.0

import { RESOURCE_LIMITS } from "../generated/resource-limits";

const {
  eocdSearchBytes: MAX_EOCD_SEARCH,
  entryPathBytes: MAX_ENTRY_PATH_BYTES,
  entryCount: MAX_ENTRY_COUNT,
  entryBytes: MAX_ENTRY_BYTES,
  totalBytes: MAX_TOTAL_BYTES,
  compressionRatio: MAX_COMPRESSION_RATIO,
  manifestBytes: MAX_MANIFEST_BYTES,
} = RESOURCE_LIMITS.bundle.archive;
const pathEncoder = new TextEncoder();

const abortError = () => new DOMException("The operation was aborted", "AbortError");

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw signal.reason ?? abortError();
};

const signatures = {
  central: 0x02014b50,
  eocd: 0x06054b50,
  local: 0x04034b50,
  zip64Eocd: 0x06064b50,
  zip64Locator: 0x07064b50,
} as const;

export type BundleCompression = "stored" | "deflate";

export interface BundleManifestEntry {
  path: string;
  sha256: string;
  size: number;
  compression: BundleCompression;
}

export interface BundleManifest {
  formatVersion: { major: number; minor: number };
  producer: { name: string; version: string };
  snapshotId: string;
  top: string;
  designIndex: string;
  sourceIndex: string;
  diagnostics: string;
  features?: string[];
  entries: BundleManifestEntry[];
}

interface ZipEntry {
  name: string;
  compression: 0 | 8;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const safeNumber = (value: bigint, description: string) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${description} exceeds browser limits`);
  return number;
};

const viewFor = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const requireRange = (bytes: Uint8Array, offset: number, length: number, description: string) => {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    throw new Error(`Truncated ZIP ${description}`);
  }
};

const safeEntryName = (name: string) => {
  if (
    !name ||
    pathEncoder.encode(name).length > MAX_ENTRY_PATH_BYTES ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ZIP entry path ${JSON.stringify(name)}`);
  }
};

const readBlob = async (blob: Blob, offset: number, length: number, signal?: AbortSignal) => {
  throwIfAborted(signal);
  if (offset < 0 || length < 0 || offset + length > blob.size) {
    throw new Error("ZIP entry points outside the bundle");
  }
  const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
  throwIfAborted(signal);
  return bytes;
};

export const readStreamWithLimit = async (
  stream: ReadableStream<Uint8Array>,
  limit: number,
  description: string,
  signal?: AbortSignal,
) => {
  throwIfAborted(signal);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(signal?.reason ?? abortError()).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (!value) continue;
      if (value.byteLength > limit - length) {
        await reader.cancel();
        throw new Error(`${description} expands beyond its size limit`);
      }
      chunks.push(value);
      length += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  throwIfAborted(signal);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const findSignatureBackwards = (view: DataView, signature: number) => {
  for (let offset = view.byteLength - 4; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === signature) return offset;
  }
  return -1;
};

const parseZip64Extra = (
  extra: Uint8Array,
  size32: number,
  compressed32: number,
  localOffset32: number,
) => {
  let size = size32;
  let compressedSize = compressed32;
  let localOffset = localOffset32;
  let offset = 0;
  const view = viewFor(extra);
  while (offset + 4 <= extra.length) {
    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    offset += 4;
    requireRange(extra, offset, length, "extra field");
    if (id === 0x0001) {
      let cursor = offset;
      const next = (description: string) => {
        requireRange(extra, cursor, 8, "ZIP64 extra field");
        const value = safeNumber(view.getBigUint64(cursor, true), description);
        cursor += 8;
        return value;
      };
      if (size32 === 0xffffffff) size = next("entry size");
      if (compressed32 === 0xffffffff) compressedSize = next("compressed entry size");
      if (localOffset32 === 0xffffffff) localOffset = next("local header offset");
      break;
    }
    offset += length;
  }
  if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
    throw new Error("ZIP64 entry is missing its size or offset extra field");
  }
  return { size, compressedSize, localOffset };
};

const parseDirectoryLocation = async (blob: Blob, signal?: AbortSignal) => {
  const tailOffset = Math.max(0, blob.size - MAX_EOCD_SEARCH);
  const tail = await readBlob(blob, tailOffset, blob.size - tailOffset, signal);
  const view = viewFor(tail);
  const eocd = findSignatureBackwards(view, signatures.eocd);
  if (eocd < 0) throw new Error("Not a ZIP file: end-of-central-directory record is missing");
  requireRange(tail, eocd, 22, "end-of-central-directory record");
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== tail.length) {
    throw new Error("ZIP has trailing bytes or a malformed comment");
  }
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  if (disk !== 0 || directoryDisk !== 0) throw new Error("Multi-disk ZIP files are unsupported");
  let count = view.getUint16(eocd + 10, true);
  let directorySize = view.getUint32(eocd + 12, true);
  let directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    const locatorAbsolute = tailOffset + eocd - 20;
    const locator = await readBlob(blob, locatorAbsolute, 20, signal);
    const locatorView = viewFor(locator);
    if (locatorView.getUint32(0, true) !== signatures.zip64Locator) {
      throw new Error("ZIP64 locator is missing");
    }
    if (locatorView.getUint32(4, true) !== 0 || locatorView.getUint32(16, true) !== 1) {
      throw new Error("Multi-disk ZIP64 files are unsupported");
    }
    const zip64Offset = safeNumber(locatorView.getBigUint64(8, true), "ZIP64 directory offset");
    const zip64 = await readBlob(blob, zip64Offset, 56, signal);
    const zip64View = viewFor(zip64);
    if (zip64View.getUint32(0, true) !== signatures.zip64Eocd) {
      throw new Error("ZIP64 end-of-central-directory record is missing");
    }
    count = safeNumber(zip64View.getBigUint64(32, true), "ZIP entry count");
    directorySize = safeNumber(zip64View.getBigUint64(40, true), "ZIP directory size");
    directoryOffset = safeNumber(zip64View.getBigUint64(48, true), "ZIP directory offset");
  }
  if (count <= 0 || count > MAX_ENTRY_COUNT) {
    throw new Error(`ZIP entry count ${count} is outside the supported range`);
  }
  return { count, directorySize, directoryOffset };
};

export class NettleArchive {
  private constructor(
    private readonly blob: Blob,
    private readonly entries: ReadonlyMap<string, ZipEntry>,
  ) {}

  static async open(blob: Blob, signal?: AbortSignal) {
    const { count, directorySize, directoryOffset } = await parseDirectoryLocation(blob, signal);
    if (directorySize > MAX_ENTRY_BYTES) throw new Error("ZIP central directory is too large");
    const directory = await readBlob(blob, directoryOffset, directorySize, signal);
    const view = viewFor(directory);
    const entries = new Map<string, ZipEntry>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let offset = 0;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      requireRange(directory, offset, 46, "central directory header");
      if (view.getUint32(offset, true) !== signatures.central) {
        throw new Error("Malformed ZIP central directory");
      }
      const flags = view.getUint16(offset + 8, true);
      if ((flags & 1) !== 0) throw new Error("Encrypted ZIP entries are unsupported");
      const compression = view.getUint16(offset + 10, true);
      if (compression !== 0 && compression !== 8) {
        throw new Error(`Unsupported ZIP compression method ${compression}`);
      }
      const compressed32 = view.getUint32(offset + 20, true);
      const size32 = view.getUint32(offset + 24, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset32 = view.getUint32(offset + 42, true);
      const variableLength = nameLength + extraLength + commentLength;
      requireRange(directory, offset + 46, variableLength, "central directory entry");
      const name = decoder.decode(directory.subarray(offset + 46, offset + 46 + nameLength));
      safeEntryName(name);
      const extra = directory.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      );
      const { size, compressedSize, localOffset } = parseZip64Extra(
        extra,
        size32,
        compressed32,
        localOffset32,
      );
      if (size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry ${name} exceeds the size limit`);
      if (compressedSize > 0 && size / compressedSize > MAX_COMPRESSION_RATIO) {
        throw new Error(`ZIP entry ${name} exceeds the compression-ratio limit`);
      }
      total += size;
      if (total > MAX_TOTAL_BYTES) throw new Error("ZIP exceeds the total size limit");
      if (entries.has(name)) throw new Error(`ZIP contains duplicate entry ${name}`);
      entries.set(name, {
        name,
        compression,
        compressedSize,
        size,
        localOffset,
      });
      offset += 46 + variableLength;
    }
    if (offset !== directory.length) throw new Error("ZIP central directory size is inconsistent");
    return new NettleArchive(blob, entries);
  }

  names() {
    return [...this.entries.keys()].sort();
  }

  metadata(name: string) {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    return {
      size: entry.size,
      compression: entry.compression === 0 ? ("stored" as const) : ("deflate" as const),
    };
  }

  async read(name: string, maximum: number = MAX_ENTRY_BYTES, signal?: AbortSignal) {
    throwIfAborted(signal);
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Bundle entry ${name} is missing`);
    if (entry.size > maximum) throw new Error(`Bundle entry ${name} exceeds its size limit`);
    const header = await readBlob(this.blob, entry.localOffset, 30, signal);
    const view = viewFor(header);
    if (view.getUint32(0, true) !== signatures.local) {
      throw new Error(`Bundle entry ${name} has a malformed local header`);
    }
    const flags = view.getUint16(6, true);
    const compression = view.getUint16(8, true);
    if ((flags & 1) !== 0 || compression !== entry.compression) {
      throw new Error(`Bundle entry ${name} has an inconsistent local header`);
    }
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const localName = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBlob(this.blob, entry.localOffset + 30, nameLength, signal),
    );
    if (localName !== name) throw new Error(`Bundle entry ${name} has a mismatched local name`);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    const compressed = await readBlob(this.blob, dataOffset, entry.compressedSize, signal);
    let bytes: Uint8Array;
    if (entry.compression === 0) {
      bytes = compressed;
    } else {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("This browser does not support local DEFLATE decompression");
      }
      const stream = new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      bytes = await readStreamWithLimit(
        stream,
        Math.min(entry.size, maximum),
        `Bundle entry ${name}`,
        signal,
      );
    }
    throwIfAborted(signal);
    if (bytes.length !== entry.size || bytes.length > maximum) {
      throw new Error(`Bundle entry ${name} has an inconsistent expanded size`);
    }
    return bytes;
  }
}

const isManifest = (value: unknown): value is BundleManifest => {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<BundleManifest>;
  return (
    manifest.formatVersion?.major === 1 &&
    typeof manifest.formatVersion.minor === "number" &&
    typeof manifest.snapshotId === "string" &&
    Boolean(manifest.snapshotId) &&
    typeof manifest.top === "string" &&
    Boolean(manifest.top) &&
    typeof manifest.designIndex === "string" &&
    typeof manifest.sourceIndex === "string" &&
    typeof manifest.diagnostics === "string" &&
    Array.isArray(manifest.entries)
  );
};

export class NettleBundle {
  private readonly declarations: ReadonlyMap<string, BundleManifestEntry>;

  private constructor(
    private readonly archive: NettleArchive,
    readonly manifest: BundleManifest,
  ) {
    this.declarations = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  }

  static async open(blob: Blob, signal?: AbortSignal) {
    const archive = await NettleArchive.open(blob, signal);
    const manifestBytes = await archive.read("manifest.json", MAX_MANIFEST_BYTES, signal);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
    if (!isManifest(parsed))
      throw new Error("Bundle manifest is invalid or has an unsupported major version");
    const manifest = parsed;
    const declarations = new Map<string, BundleManifestEntry>();
    for (const entry of manifest.entries) {
      safeEntryName(entry.path);
      if (
        typeof entry.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        entry.size > MAX_ENTRY_BYTES ||
        (entry.compression !== "stored" && entry.compression !== "deflate")
      ) {
        throw new Error(`Bundle manifest declaration for ${entry.path} is invalid`);
      }
      if (declarations.has(entry.path)) {
        throw new Error(`Bundle manifest declares duplicate entry ${entry.path}`);
      }
      const archiveEntry = archive.metadata(entry.path);
      if (
        !archiveEntry ||
        archiveEntry.size !== entry.size ||
        archiveEntry.compression !== entry.compression
      ) {
        throw new Error(`ZIP metadata for ${entry.path} does not match the bundle manifest`);
      }
      declarations.set(entry.path, entry);
    }
    for (const required of [manifest.designIndex, manifest.sourceIndex, manifest.diagnostics]) {
      if (!declarations.has(required))
        throw new Error(`Bundle manifest does not declare ${required}`);
    }
    const archiveNames = archive.names();
    const expectedNames = ["manifest.json", ...declarations.keys()].sort();
    if (
      archiveNames.length !== expectedNames.length ||
      archiveNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new Error("ZIP entries do not exactly match the bundle manifest");
    }
    const supportedFeatures = new Set(["debugArtifacts"]);
    const unknownFeature = manifest.features?.find((feature) => !supportedFeatures.has(feature));
    if (unknownFeature) throw new Error(`Bundle requires unsupported feature ${unknownFeature}`);
    return new NettleBundle(archive, manifest);
  }

  async read(path: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const declaration = this.declarations.get(path);
    if (!declaration) throw new Error(`Bundle entry ${path} is not declared`);
    const bytes = await this.archive.read(path, declaration.size, signal);
    throwIfAborted(signal);
    const digest = await sha256(bytes);
    throwIfAborted(signal);
    if (digest !== declaration.sha256) {
      throw new Error(`Bundle entry ${path} failed its SHA-256 integrity check`);
    }
    return bytes;
  }

  declaration(path: string) {
    return this.declarations.get(path);
  }
}

const sha256 = async (bytes: Uint8Array) => {
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "This browser does not provide the Web Crypto API needed for bundle validation",
    );
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
