import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  assertExactChromeArchiveFiles,
  chromeArchiveFiles,
  createChromeArchive,
  listZipEntries,
} from "../scripts/package-chrome.mjs";

const runFile = promisify(execFile);

async function createChromeBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "inventory-chrome-package-test-"));
  const sourceDirectory = join(root, "chrome");
  const extensionDirectory = join(root, "apps", "extension");
  for (const path of chromeArchiveFiles) {
    const destination = join(sourceDirectory, path);
    await mkdir(dirname(destination), { recursive: true });
    const contents =
      path === "manifest.json"
        ? `${JSON.stringify({ manifest_version: 3, version: "0.1.7" })}\n`
        : `${path}\n`;
    await writeFile(destination, contents);
  }
  return { extensionDirectory, root, sourceDirectory };
}

describe("Chrome manual distribution package", () => {
  it("creates a deterministic versioned archive with exactly the required resources", async () => {
    const fixture = await createChromeBuildFixture();
    const first = await createChromeArchive({
      projectRoot: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
    });
    const firstContents = await readFile(first.archivePath);
    const unpacked = join(fixture.root, "unpacked");
    await runFile("unzip", ["-q", first.archivePath, "-d", unpacked]);

    expect(first.archiveName).toBe(
      "inventory-signal-local-monitor-0.1.7-chrome.zip",
    );
    expect(await listZipEntries(first.archivePath)).toEqual(chromeArchiveFiles);
    for (const path of chromeArchiveFiles) {
      await expect(readFile(join(unpacked, path))).resolves.toBeInstanceOf(
        Buffer,
      );
    }
    await expect(readFile(first.checksumPath, "utf8")).resolves.toBe(
      `${first.checksum}  ${first.archiveName}\n`,
    );

    const second = await createChromeArchive({
      projectRoot: fixture.root,
      sourceDirectory: fixture.sourceDirectory,
    });
    expect(second.checksum).toBe(first.checksum);
    await expect(readFile(second.archivePath)).resolves.toEqual(firstContents);
  });

  it("rejects development and secret files rather than silently omitting them", async () => {
    const fixture = await createChromeBuildFixture();
    await writeFile(join(fixture.sourceDirectory, ".env"), "should-not-ship\n");

    await expect(
      createChromeArchive({
        projectRoot: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
      }),
    ).rejects.toThrow("Archive path is not allowed");
  });

  it("rejects absolute, traversal, key, and source path entries", () => {
    for (const forbidden of [
      "/absolute.js",
      "../outside.js",
      "manifest.key",
      "release-secret.txt",
      "keys/signing.pem",
      "src/background.ts",
      "test/package-chrome.test.ts",
    ]) {
      expect(() => assertExactChromeArchiveFiles([forbidden])).toThrow(
        "Archive path is not allowed",
      );
    }
  });

  it("rejects symlinked input files", async () => {
    const fixture = await createChromeBuildFixture();
    const popup = join(fixture.sourceDirectory, "popup.js");
    const outside = join(fixture.root, "outside.js");
    await writeFile(outside, "outside\n");
    await rm(popup);
    await symlink(outside, popup);

    await expect(
      createChromeArchive({
        projectRoot: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
      }),
    ).rejects.toThrow("must not contain symlinks");
  });

  it("rejects a symlinked generated-resource directory", async () => {
    const fixture = await createChromeBuildFixture();
    const linkedSource = join(fixture.root, "linked-chrome");
    await symlink(fixture.sourceDirectory, linkedSource);

    await expect(
      createChromeArchive({
        projectRoot: fixture.root,
        sourceDirectory: linkedSource,
      }),
    ).rejects.toThrow("input must be a real directory");
  });

  it("rejects a release-directory symlink before changing the external target", async () => {
    const fixture = await createChromeBuildFixture();
    const outside = await mkdtemp(join(tmpdir(), "inventory-chrome-outside-"));
    const sentinel = join(outside, "sentinel.txt");
    await mkdir(fixture.extensionDirectory, { recursive: true });
    await writeFile(sentinel, "do not modify\n");
    await symlink(outside, join(fixture.extensionDirectory, "release"));

    await expect(
      createChromeArchive({
        projectRoot: fixture.root,
        sourceDirectory: fixture.sourceDirectory,
      }),
    ).rejects.toThrow("must not traverse a symlink");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("do not modify\n");
  });

  it("rejects archive and checksum symlinks before overwriting either output", async () => {
    for (const suffix of ["", ".sha256"]) {
      const fixture = await createChromeBuildFixture();
      const outside = join(fixture.root, "outside.txt");
      const archive = join(
        fixture.extensionDirectory,
        "release",
        `inventory-signal-local-monitor-0.1.7-chrome.zip${suffix}`,
      );
      await mkdir(dirname(archive), { recursive: true });
      await writeFile(outside, "do not modify\n");
      await symlink(outside, archive);

      await expect(
        createChromeArchive({
          projectRoot: fixture.root,
          sourceDirectory: fixture.sourceDirectory,
        }),
      ).rejects.toThrow("must not traverse a symlink");
      await expect(readFile(outside, "utf8")).resolves.toBe("do not modify\n");
    }
  });
});
