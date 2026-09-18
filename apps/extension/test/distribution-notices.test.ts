import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBundledPackages,
  formatThirdPartyNotices,
  writeDistributionNotices,
} from "../scripts/distribution-notices.mjs";

async function createPackageFixture({
  includeLicenseFile = true,
  license = "MIT",
  licenseText = "MIT text\n",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
  const packageRoot = join(root, "node_modules", "fixture-package");
  await mkdir(join(packageRoot, "lib"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "fixture-package", version: "1.2.3", license }),
  );
  if (includeLicenseFile) {
    await writeFile(join(packageRoot, "LICENSE"), licenseText);
  }
  await writeFile(join(packageRoot, "lib", "index.js"), "export {};");
  return { packageRoot, root };
}

describe("extension distribution notices", () => {
  it("formats a deterministic full notice for only actual bundled packages", async () => {
    const fixture = await createPackageFixture();
    await mkdir(join(fixture.root, "src"), { recursive: true });
    await writeFile(join(fixture.root, "src", "local.ts"), "export {};");
    const packages = await collectBundledPackages({
      extensionRoot: fixture.root,
      metafile: {
        inputs: {
          "node_modules/fixture-package/lib/index.js": {},
          "src/local.ts": {},
        },
      },
    });

    expect(packages).toEqual([
      {
        declaredLicense: "MIT",
        licenseText: "MIT text\n",
        name: "fixture-package",
        version: "1.2.3",
      },
    ]);
    expect(formatThirdPartyNotices(packages)).toContain(
      "fixture-package@1.2.3",
    );
    expect(formatThirdPartyNotices(packages)).toContain("MIT text");
  });

  it("fails closed when a bundled package has no packaged license", async () => {
    const fixture = await createPackageFixture({ includeLicenseFile: false });

    await expect(
      collectBundledPackages({
        extensionRoot: fixture.root,
        metafile: {
          inputs: { "node_modules/fixture-package/lib/index.js": {} },
        },
      }),
    ).rejects.toThrow("expected exactly one packaged license file");
  });

  it("fails closed when a bundled package has no declared license", async () => {
    const fixture = await createPackageFixture({ license: "" });

    await expect(
      collectBundledPackages({
        extensionRoot: fixture.root,
        metafile: {
          inputs: { "node_modules/fixture-package/lib/index.js": {} },
        },
      }),
    ).rejects.toThrow("bundled package has no declared license");
  });

  it("fails closed when a runtime package cannot be identified", async () => {
    const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
    await mkdir(join(root, "node_modules", "unknown", "lib"), {
      recursive: true,
    });
    await writeFile(
      join(root, "node_modules", "unknown", "lib", "index.js"),
      "",
    );

    await expect(
      collectBundledPackages({
        extensionRoot: root,
        metafile: { inputs: { "node_modules/unknown/lib/index.js": {} } },
      }),
    ).rejects.toThrow("Could not resolve package metadata");
  });

  it("requires project material before adding distribution notices", async () => {
    const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
    const extensionRoot = join(root, "apps", "extension");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(join(root, "NOTICE.md"), "Project notice\n");

    await expect(
      writeDistributionNotices({
        destination: join(root, "apps", "extension", "dist", "chrome"),
        extensionRoot,
        metafile: { inputs: {} },
        projectRoot: root,
      }),
    ).rejects.toThrow("Project LICENSE is required");
  });

  it("requires the repository notice before adding distribution notices", async () => {
    const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
    const extensionRoot = join(root, "apps", "extension");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(join(root, "LICENSE"), "Project license\n");

    await expect(
      writeDistributionNotices({
        destination: join(root, "apps", "extension", "dist", "chrome"),
        extensionRoot,
        metafile: { inputs: {} },
        projectRoot: root,
      }),
    ).rejects.toThrow("Project NOTICE.md is required");
  });

  it("does not let a caller write notices outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
    await expect(
      writeDistributionNotices({
        destination: resolve(root, "..", "outside"),
        extensionRoot: root,
        metafile: { inputs: {} },
        projectRoot: root,
      }),
    ).rejects.toThrow("must remain within the project root");
  });

  it("rejects a distribution directory symlink that escapes the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
    const outside = await mkdtemp(join(tmpdir(), "inventory-notice-outside-"));
    const extensionRoot = join(root, "apps", "extension");
    await mkdir(extensionRoot, { recursive: true });
    await writeFile(join(root, "LICENSE"), "Project license\n");
    await writeFile(join(root, "NOTICE.md"), "Project notice\n");
    await symlink(outside, join(extensionRoot, "dist"));

    await expect(
      writeDistributionNotices({
        destination: join(extensionRoot, "dist", "chrome"),
        extensionRoot,
        metafile: { inputs: {} },
        projectRoot: root,
      }),
    ).rejects.toThrow("must not traverse a symlink");
    await expect(
      readFile(join(outside, "chrome", "LICENSE")),
    ).rejects.toThrow();
  });

  it("rejects existing notice artifact symlinks before writing", async () => {
    for (const artifact of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.txt"]) {
      const root = await mkdtemp(join(tmpdir(), "inventory-notice-test-"));
      const outside = join(root, "outside.txt");
      const extensionRoot = join(root, "apps", "extension");
      const destination = join(extensionRoot, "dist", "chrome");
      await mkdir(destination, { recursive: true });
      await writeFile(join(root, "LICENSE"), "Project license\n");
      await writeFile(join(root, "NOTICE.md"), "Project notice\n");
      await writeFile(outside, "outside material\n");
      await symlink(outside, join(destination, artifact));

      await expect(
        writeDistributionNotices({
          destination,
          extensionRoot,
          metafile: { inputs: {} },
          projectRoot: root,
        }),
      ).rejects.toThrow(
        `Notice output ${artifact} must not overwrite a symlink`,
      );
      await expect(readFile(outside, "utf8")).resolves.toBe(
        "outside material\n",
      );
    }
  });
});
