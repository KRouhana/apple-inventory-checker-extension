import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { assertSafeDistributionDestination } from "./distribution-notices.mjs";

const extensionRoot = resolve(import.meta.dirname, "..");
const chromeBuildDirectory = resolve(extensionRoot, "dist", "chrome");
const repositoryRoot = resolve(extensionRoot, "../..");
const archiveEpoch = new Date("2000-01-01T00:00:00.000Z");

export const chromeArchiveFiles = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.txt",
  "app.html",
  "app.js",
  "background.js",
  "icons/inventory-signal.png",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "manifest.json",
  "popup.css",
  "popup.html",
  "popup.js",
  "portable-catalog.json",
  "ui.css",
].sort();

const forbiddenPath =
  /(^|\/)(?:\.env(?:\..*)?|node_modules|src|test|tests|manifest\.key|[^/]*(?:credential|password|secret|token)[^/]*|[^/]*\.(?:key|pem|p12|pfx))(?:\/|$)/i;

function assertSafeRelativePath(path) {
  if (
    typeof path !== "string" ||
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    forbiddenPath.test(path)
  ) {
    throw new Error(`Archive path is not allowed: ${path}`);
  }
}

export function assertExactChromeArchiveFiles(files) {
  const actual = [...files].sort();
  for (const file of actual) assertSafeRelativePath(file);
  if (
    actual.length !== chromeArchiveFiles.length ||
    actual.some((file, index) => file !== chromeArchiveFiles[index])
  ) {
    throw new Error("Chrome archive must contain only the approved resources");
  }
}

async function listRegularFiles(root) {
  const files = [];

  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Chrome archive input must not contain symlinks");
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const normalized = relative(root, path).split(sep).join("/");
        files.push(normalized);
      } else {
        throw new Error("Chrome archive input must contain regular files only");
      }
    }
  }

  await walk(root);
  return files;
}

async function readManifestVersion(sourceDirectory) {
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "manifest.json"), "utf8"),
  );
  if (
    typeof manifest.version !== "string" ||
    !/^\d+(?:\.\d+){1,3}$/.test(manifest.version)
  ) {
    throw new Error(
      "Chrome archive requires a valid version in its built manifest",
    );
  }
  return manifest.version;
}

async function copyNormalizedFiles(sourceDirectory, stagingDirectory) {
  for (const relativePath of chromeArchiveFiles) {
    const sourcePath = join(sourceDirectory, relativePath);
    if (!(await lstat(sourcePath)).isFile()) {
      throw new Error(
        `Chrome archive input is not a regular file: ${relativePath}`,
      );
    }
    const stagedPath = join(stagingDirectory, relativePath);
    await mkdir(dirname(stagedPath), { recursive: true, mode: 0o755 });
    await writeFile(stagedPath, await readFile(sourcePath), { mode: 0o644 });
    await utimes(stagedPath, archiveEpoch, archiveEpoch);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: "pipe", ...options });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolveProcess();
      else reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
    });
  });
}

export async function listZipEntries(archivePath) {
  let stdout = "";
  await new Promise((resolveProcess, reject) => {
    const child = spawn("unzip", ["-Z1", archivePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolveProcess();
      else reject(new Error(`unzip failed (${code})`));
    });
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function createChromeArchive({
  projectRoot = repositoryRoot,
  sourceDirectory = chromeBuildDirectory,
} = {}) {
  const resolvedProjectRoot = resolve(projectRoot);
  const resolvedExtensionDirectory = resolve(
    resolvedProjectRoot,
    "apps",
    "extension",
  );
  const resolvedOutputDirectory = join(resolvedExtensionDirectory, "release");
  const resolvedSourceDirectory = resolve(sourceDirectory);
  if (!(await lstat(resolvedSourceDirectory)).isDirectory()) {
    throw new Error("Chrome archive input must be a real directory");
  }
  const sourceFiles = await listRegularFiles(resolvedSourceDirectory);
  assertExactChromeArchiveFiles(sourceFiles);
  const version = await readManifestVersion(resolvedSourceDirectory);
  const archiveName = `inventory-signal-local-monitor-${version}-chrome.zip`;
  await assertSafeDistributionDestination({
    destination: resolvedOutputDirectory,
    projectRoot: resolvedProjectRoot,
  });
  await mkdir(resolvedOutputDirectory, { recursive: true, mode: 0o755 });
  await assertSafeDistributionDestination({
    destination: resolvedOutputDirectory,
    projectRoot: resolvedProjectRoot,
  });
  const archivePath = join(resolvedOutputDirectory, archiveName);
  const checksumPath = `${archivePath}.sha256`;
  await Promise.all([
    assertSafeDistributionDestination({
      destination: archivePath,
      projectRoot: resolvedProjectRoot,
    }),
    assertSafeDistributionDestination({
      destination: checksumPath,
      projectRoot: resolvedProjectRoot,
    }),
  ]);
  const stagingDirectory = await mkdtemp(
    join(tmpdir(), "inventory-signal-chrome-"),
  );

  try {
    await copyNormalizedFiles(resolvedSourceDirectory, stagingDirectory);
    await rm(archivePath, { force: true });
    await rm(checksumPath, { force: true });
    await run("zip", ["-X", "-9", "-q", archivePath, ...chromeArchiveFiles], {
      cwd: stagingDirectory,
    });
    assertExactChromeArchiveFiles(await listZipEntries(archivePath));
    const checksum = await sha256(archivePath);
    await writeFile(checksumPath, `${checksum}  ${archiveName}\n`, {
      mode: 0o644,
    });
    return { archiveName, archivePath, checksum, checksumPath, version };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await createChromeArchive();
  process.stdout.write(
    `packaged Chrome ZIP ${result.archiveName}\nsha256 ${result.checksum}\n`,
  );
}
