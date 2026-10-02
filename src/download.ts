import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const REC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

function envByteLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum} bytes.`);
  }
  return parsed;
}

function envCountLimit(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export const MAX_PDF_BYTES = envByteLimit(
  "PHILPAPERS_MAX_PDF_BYTES",
  32 * 1024 * 1024,
  64 * 1024,
  256 * 1024 * 1024,
);

export const MAX_DOWNLOAD_TOTAL_BYTES = envByteLimit(
  "PHILPAPERS_MAX_DOWNLOAD_TOTAL_BYTES",
  512 * 1024 * 1024,
  MAX_PDF_BYTES,
  16 * 1024 * 1024 * 1024,
);

export const MAX_DOWNLOAD_FILES = envCountLimit(
  "PHILPAPERS_MAX_DOWNLOAD_FILES",
  64,
  1,
  10_000,
);

export const MAX_PENDING_DOWNLOADS = envCountLimit(
  "PHILPAPERS_MAX_PENDING_DOWNLOADS",
  4,
  1,
  64,
);

const UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const GENERATED_PDF_RE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9-]*-${UUID_SOURCE}\\.pdf$`,
  "i",
);
const GENERATED_PART_RE = new RegExp(
  `^\\.[A-Za-z0-9][A-Za-z0-9-]*\\.${UUID_SOURCE}\\.part$`,
  "i",
);

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
}

function sameIdentity(
  info: { dev: bigint; ino: bigint },
  expected: FileIdentity,
): boolean {
  return info.dev === expected.dev && info.ino === expected.ino;
}

function identityOf(info: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

async function captureDirectoryIdentity(path: string): Promise<DirectoryIdentity> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Download directory changed or is no longer a real directory: ${path}`);
  }
  if ((await realpath(path)) !== path) {
    throw new Error(`Download directory path changed while it was being used: ${path}`);
  }
  if (typeof process.getuid === "function") {
    if (info.uid !== BigInt(process.getuid())) {
      throw new Error(`Download directory must be owned by the current user: ${path}`);
    }
    if ((info.mode & 0o077n) !== 0n) {
      throw new Error(`Download directory must not be group/world writable or accessible: ${path}`);
    }
    await validateDirectoryAncestors(path);
  }
  return { path, ...identityOf(info) };
}

async function validateDirectoryAncestors(path: string): Promise<void> {
  if (typeof process.getuid !== "function") return;
  const currentUid = process.getuid();
  let current = dirname(path);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Download-directory ancestor is not a stable real directory: ${current}`);
    }
    if (info.uid !== currentUid && info.uid !== 0) {
      throw new Error(`Download-directory ancestor has an untrusted owner: ${current}`);
    }
    const writableByOthers = (info.mode & 0o022) !== 0;
    const sticky = (info.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) {
      throw new Error(`Download-directory ancestor is group/world writable: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertDirectoryIdentity(expected: DirectoryIdentity): Promise<void> {
  const current = await captureDirectoryIdentity(expected.path);
  if (!sameIdentity(current, expected)) {
    throw new Error(`Download directory was replaced while it was being used: ${expected.path}`);
  }
}

async function assertRegularFileIdentity(
  path: string,
  expected: FileIdentity,
  expectedSize: bigint,
): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    (info.mode & 0o077n) !== 0n ||
    !sameIdentity(info, expected) ||
    info.size !== expectedSize
  ) {
    throw new Error(`Download file was replaced or changed while it was being published: ${path}`);
  }
}

async function generatedDownloadUsage(
  directory: DirectoryIdentity,
  accessPath = directory.path,
): Promise<{
  bytes: bigint;
  files: number;
}> {
  await assertDirectoryIdentity(directory);
  const names = await readdir(accessPath);
  let bytes = 0n;
  let files = 0;
  for (const name of names) {
    if (!GENERATED_PDF_RE.test(name) && !GENERATED_PART_RE.test(name)) continue;
    const path = join(accessPath, name);
    const info = await lstat(path, { bigint: true });
    const wrongOwner =
      typeof process.getuid === "function" && info.uid !== BigInt(process.getuid());
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      (info.mode & 0o077n) !== 0n ||
      wrongOwner
    ) {
      throw new Error(`Generated download entry is not a private regular file: ${path}`);
    }
    files += 1;
    bytes += info.size;
  }
  await assertDirectoryIdentity(directory);
  return { bytes, files };
}

async function unlinkMatching(path: string, expected: FileIdentity): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true });
    if (info.isFile() && !info.isSymbolicLink() && sameIdentity(info, expected)) {
      await unlink(path);
    }
  } catch {
    // Best-effort cleanup; never unlink an entry whose identity we did not verify.
  }
}

let publicationQueue: Promise<void> = Promise.resolve();
let pendingPublications = 0;

function serializePublication<T>(operation: () => Promise<T>): Promise<T> {
  if (pendingPublications >= MAX_PENDING_DOWNLOADS) {
    return Promise.reject(
      new Error(
        `Download publication queue is full (${MAX_PENDING_DOWNLOADS.toLocaleString()} pending).`,
      ),
    );
  }
  pendingPublications += 1;
  const result = publicationQueue.then(operation, operation);
  publicationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result.finally(() => {
    pendingPublications -= 1;
  });
}

let defaultDirectory: Promise<string> | undefined;

async function validateDirectory(path: string): Promise<string> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Download path must be a real directory, not a symlink: ${path}`);
  }
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Download path is not a directory: ${canonical}`);
  if (typeof process.getuid === "function") {
    if (info.uid !== process.getuid()) {
      throw new Error(`Download directory must be owned by the current user: ${canonical}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new Error(
        `Download directory must not be group/world writable or accessible: ${canonical}`,
      );
    }
    await validateDirectoryAncestors(canonical);
  }
  return canonical;
}

/** Return a private configured directory or lazily create a private per-user directory. */
export async function getDownloadDirectory(
  configured = process.env.PHILPAPERS_DOWNLOAD_DIR,
): Promise<string> {
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("PHILPAPERS_DOWNLOAD_DIR must be an absolute path.");
    }
    const path = resolve(configured);
    await mkdir(path, { recursive: true, mode: 0o700 });
    return await validateDirectory(path);
  }
  defaultDirectory ??= (async () => {
    const owner = typeof process.getuid === "function" ? process.getuid().toString() : "downloads";
    const path = join(tmpdir(), `philosophy-mcp-${owner}`);
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const canonical = await validateDirectory(path);
    await chmod(canonical, 0o700);
    return await validateDirectory(canonical);
  })();
  return await defaultDirectory;
}

/** Publish a PDF through an exclusive private temp file and an atomic rename. */
export async function savePdfSafely(
  recId: string,
  pdf: Buffer,
  configuredDirectory = process.env.PHILPAPERS_DOWNLOAD_DIR,
): Promise<string> {
  if (recId.length > 128 || !REC_ID_RE.test(recId)) {
    throw new Error(`Unsafe record id "${recId.slice(0, 256)}".`);
  }
  if (pdf.length > MAX_PDF_BYTES) {
    throw new Error(
      `PDF is ${pdf.length.toLocaleString()} bytes; the limit is ` +
        `${MAX_PDF_BYTES.toLocaleString()} bytes.`,
    );
  }
  if (!pdf.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error("Downloaded body does not contain a PDF header.");
  }

  return await serializePublication(async () => {
    const directoryPath = await getDownloadDirectory(configuredDirectory);
    const directory = await captureDirectoryIdentity(directoryPath);
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
    let directoryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (process.platform === "win32") {
        throw new Error(
          "Secure PDF publication requires descriptor-relative directory access, which is " +
            "not available on this platform; refusing the write.",
        );
      }
      const directoryOnly =
        typeof constants.O_DIRECTORY === "number" ? constants.O_DIRECTORY : 0;
      directoryHandle = await open(
        directory.path,
        constants.O_RDONLY | noFollow | directoryOnly,
      );
      const openedDirectory = await directoryHandle.stat({ bigint: true });
      if (!openedDirectory.isDirectory() || !sameIdentity(openedDirectory, directory)) {
        throw new Error(`Download directory changed while it was being opened: ${directory.path}`);
      }
      const descriptorPaths =
        process.platform === "linux"
          ? [`/proc/self/fd/${directoryHandle.fd}`]
          : [`/dev/fd/${directoryHandle.fd}`, `/proc/self/fd/${directoryHandle.fd}`];
      let accessDirectory: string | undefined;
      for (const candidate of descriptorPaths) {
        try {
          if ((await realpath(candidate)) === directory.path) {
            accessDirectory = candidate;
            break;
          }
        } catch {
          // Try the next OS-specific descriptor filesystem.
        }
      }
      if (!accessDirectory) {
        throw new Error(
          "Unable to anchor the download directory descriptor; refusing the write.",
        );
      }

      const token = randomUUID();
      const temporaryName = `.${recId}.${token}.part`;
      const finalName = `${recId}-${token}.pdf`;
      const temporary = join(accessDirectory, temporaryName);
      const finalAccessPath = join(accessDirectory, finalName);
      const finalPath = join(directory.path, finalName);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let fileIdentity: FileIdentity | undefined;
      let renamed = false;
      try {
        await assertDirectoryIdentity(directory);
        handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
          0o600,
        );
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink !== 1n || (opened.mode & 0o077n) !== 0n) {
          throw new Error(`Temporary download is not a private regular file: ${temporary}`);
        }
        fileIdentity = identityOf(opened);

        // Reserve the full logical size before checking usage. Other server processes
        // see this .part file, so two publishers cannot both race past the quotas.
        await handle.truncate(pdf.length);
        const usage = await generatedDownloadUsage(directory, accessDirectory);
        if (usage.files > MAX_DOWNLOAD_FILES) {
          throw new Error(
            `Generated downloads would exceed the ${MAX_DOWNLOAD_FILES.toLocaleString()}-file ` +
              `limit (${usage.files.toLocaleString()} including pending files).`,
          );
        }
        if (usage.bytes > BigInt(MAX_DOWNLOAD_TOTAL_BYTES)) {
          throw new Error(
            `Generated downloads would exceed the ${MAX_DOWNLOAD_TOTAL_BYTES.toLocaleString()}-byte ` +
              "aggregate limit.",
          );
        }

        await handle.writeFile(pdf);
        await handle.sync();
        const written = await handle.stat({ bigint: true });
        if (
          !sameIdentity(written, fileIdentity) ||
          !written.isFile() ||
          written.size !== BigInt(pdf.length)
        ) {
          throw new Error(`Temporary download changed while it was being written: ${temporary}`);
        }
        await handle.close();
        handle = undefined;

        await assertDirectoryIdentity(directory);
        await assertRegularFileIdentity(temporary, fileIdentity, BigInt(pdf.length));
        await rename(temporary, finalAccessPath);
        renamed = true;
        await assertDirectoryIdentity(directory);
        await assertRegularFileIdentity(finalAccessPath, fileIdentity, BigInt(pdf.length));
        return finalPath;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (fileIdentity) {
          await unlinkMatching(renamed ? finalAccessPath : temporary, fileIdentity);
        }
        throw error;
      }
    } finally {
      await directoryHandle?.close().catch(() => {});
    }
  });
}
