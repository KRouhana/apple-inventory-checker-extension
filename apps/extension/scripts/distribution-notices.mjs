import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const thirdPartyNoticeFile = "THIRD_PARTY_NOTICES.txt";
const projectLicenseFile = "LICENSE";
const projectNoticeFile = "NOTICE";

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function assertString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
  return value;
}

async function assertNotSymlink(path, message) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(message);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function resolveExistingAncestor(path) {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      throw new Error("Could not resolve an existing notice output ancestor");
    }
    candidate = parent;
  }
}

/**
 * Checks the existing filesystem path before a build clears or writes it.
 * This guards accidental redirection through a pre-existing symlink; it does
 * not try to provide a concurrent-hostile-filesystem race guarantee.
 */
export async function assertSafeDistributionDestination({
  destination,
  projectRoot,
}) {
  const resolvedDestination = resolve(destination);
  const resolvedProjectRoot = resolve(projectRoot);
  if (!isWithin(resolvedProjectRoot, resolvedDestination)) {
    throw new Error("Notice destination must remain within the project root");
  }

  const relativeDestination = relative(
    resolvedProjectRoot,
    resolvedDestination,
  );
  let current = resolvedProjectRoot;
  for (const component of relativeDestination.split(sep).filter(Boolean)) {
    current = join(current, component);
    await assertNotSymlink(
      current,
      "Notice destination must not traverse a symlink",
    );
  }

  const [realProjectRoot, realExistingAncestor] = await Promise.all([
    realpath(resolvedProjectRoot),
    resolveExistingAncestor(resolvedDestination),
  ]);
  if (!isWithin(realProjectRoot, realExistingAncestor)) {
    throw new Error("Notice destination must remain within the project root");
  }

  return resolvedDestination;
}

async function assertNoticeArtifactsAreNotSymlinks(destination) {
  for (const filename of distributionNoticeFiles) {
    await assertNotSymlink(
      join(destination, filename),
      `Notice output ${filename} must not overwrite a symlink`,
    );
  }
}

async function readNonEmptyFile(path, message) {
  let contents;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(message);
    throw error;
  }
  if (contents.trim() === "") throw new Error(message);
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

async function findPackageRoot(inputPath) {
  if (!inputPath.split(sep).includes("node_modules")) return null;
  const sourcePath = await realpath(inputPath);
  const pathSegments = sourcePath.split(sep);
  const nodeModulesIndex = pathSegments.lastIndexOf("node_modules");
  const nodeModulesRoot = pathSegments.slice(0, nodeModulesIndex + 1).join(sep);
  const packageSegments = pathSegments.slice(nodeModulesIndex + 1);
  const packageSegmentCount = packageSegments[0]?.startsWith("@") ? 2 : 1;
  const packagePathSegments = packageSegments.slice(0, packageSegmentCount);
  if (packagePathSegments.length !== packageSegmentCount) {
    throw new Error("Could not resolve package metadata for bundled input");
  }
  const directory = join(nodeModulesRoot, ...packagePathSegments);
  try {
    return {
      directory,
      packageJson: JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ),
    };
  } catch {
    throw new Error("Could not resolve package metadata for bundled input");
  }
}

async function readDeclaredLicense(packageRoot, packageJson) {
  const packageName = assertString(
    packageJson.name,
    "Bundled package has no name in package.json",
  );
  const packageVersion = assertString(
    packageJson.version,
    `${packageName}: bundled package has no version in package.json`,
  );
  const declaredLicense = assertString(
    packageJson.license,
    `${packageName}@${packageVersion}: bundled package has no declared license`,
  );
  let directoryEntries;
  try {
    directoryEntries = await readdir(packageRoot, { withFileTypes: true });
  } catch {
    throw new Error(
      `${packageName}@${packageVersion}: could not inspect packaged license files`,
    );
  }
  const entries = directoryEntries
    .filter(
      (entry) =>
        entry.isFile() && /^(licen[cs]e)(\.[a-z0-9_-]+)?$/i.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (entries.length !== 1) {
    throw new Error(
      `${packageName}@${packageVersion}: expected exactly one packaged license file`,
    );
  }

  return {
    declaredLicense,
    licenseText: await readNonEmptyFile(
      join(packageRoot, entries[0]),
      `${packageName}@${packageVersion}: packaged license file is empty`,
    ),
    name: packageName,
    version: packageVersion,
  };
}

/**
 * Resolves only packages whose executable files esbuild put in this target's
 * bundle. Development-only lockfile packages never enter this list.
 */
export async function collectBundledPackages({ metafile, extensionRoot }) {
  if (!metafile || typeof metafile !== "object" || !metafile.inputs) {
    throw new Error("Build metafile is required to create third-party notices");
  }

  const packages = new Map();
  for (const input of Object.keys(metafile.inputs).sort()) {
    const packageRoot = await findPackageRoot(resolve(extensionRoot, input));
    if (!packageRoot) continue;
    const bundledPackage = await readDeclaredLicense(
      packageRoot.directory,
      packageRoot.packageJson,
    );
    const key = `${bundledPackage.name}@${bundledPackage.version}`;
    const prior = packages.get(key);
    if (
      prior &&
      (prior.declaredLicense !== bundledPackage.declaredLicense ||
        prior.licenseText !== bundledPackage.licenseText)
    ) {
      throw new Error(`${key}: bundled copies disagree on license material`);
    }
    packages.set(key, bundledPackage);
  }

  return [...packages.values()].sort((left, right) => {
    const name = left.name.localeCompare(right.name);
    return name === 0 ? left.version.localeCompare(right.version) : name;
  });
}

export function formatThirdPartyNotices(bundledPackages) {
  const header = [
    "Third-party notices for this extension distribution",
    "",
    "Generated from the esbuild metafile for executable inputs in this target.",
    "Development-only dependencies and tools are intentionally excluded.",
  ];
  const sections = bundledPackages.flatMap((bundledPackage) => [
    "",
    "=".repeat(72),
    `${bundledPackage.name}@${bundledPackage.version}`,
    `Declared license: ${bundledPackage.declaredLicense}`,
    "=".repeat(72),
    "",
    bundledPackage.licenseText.trimEnd(),
  ]);
  return [...header, ...sections, ""].join("\n");
}

export async function writeDistributionNotices({
  destination,
  extensionRoot,
  metafile,
  projectRoot,
}) {
  const resolvedDestination = await assertSafeDistributionDestination({
    destination,
    projectRoot,
  });
  const resolvedProjectRoot = resolve(projectRoot);

  const bundledPackages = await collectBundledPackages({
    extensionRoot: resolve(extensionRoot),
    metafile,
  });
  const [projectLicense, projectNotice] = await Promise.all([
    readNonEmptyFile(
      join(resolvedProjectRoot, projectLicenseFile),
      "Project LICENSE is required for extension distribution",
    ),
    readNonEmptyFile(
      join(resolvedProjectRoot, "NOTICE.md"),
      "Project NOTICE.md is required for extension distribution",
    ),
  ]);

  await mkdir(resolvedDestination, { recursive: true });
  await assertSafeDistributionDestination({
    destination: resolvedDestination,
    projectRoot: resolvedProjectRoot,
  });
  await assertNoticeArtifactsAreNotSymlinks(resolvedDestination);
  await Promise.all([
    writeFile(join(resolvedDestination, projectLicenseFile), projectLicense),
    writeFile(join(resolvedDestination, projectNoticeFile), projectNotice),
    writeFile(
      join(resolvedDestination, thirdPartyNoticeFile),
      formatThirdPartyNotices(bundledPackages),
    ),
  ]);

  return bundledPackages;
}

export const distributionNoticeFiles = [
  projectLicenseFile,
  projectNoticeFile,
  thirdPartyNoticeFile,
];
