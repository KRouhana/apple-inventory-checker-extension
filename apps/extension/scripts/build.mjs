import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  assertSafeDistributionDestination,
  distributionNoticeFiles,
  writeDistributionNotices,
} from "./distribution-notices.mjs";
import { targets, validateManifest } from "./manifest-policy.mjs";

const root = resolve(import.meta.dirname, "..");
const projectRoot = resolve(root, "../..");
const output = resolve(root, "dist");
const staticDirectory = resolve(root, "static");
const manifestsDirectory = resolve(staticDirectory, "manifests");
const requestedTarget = process.argv.at(3);

if (
  process.argv[2] !== "--target" ||
  !requestedTarget ||
  !["all", ...targets].includes(requestedTarget)
) {
  throw new Error(
    "Usage: node scripts/build.mjs --target chrome|firefox|safari|all",
  );
}

const selectedTargets = requestedTarget === "all" ? targets : [requestedTarget];

const targetSettings = {
  // These are syntax transforms only, not minimum supported-browser claims.
  // L02 owns compatibility floors after installed-browser qualification.
  chrome: { esbuildTarget: "chrome120" },
  firefox: { esbuildTarget: "firefox121" },
  safari: { esbuildTarget: "safari16" },
};

async function buildTarget(target) {
  const destination = resolve(output, target);
  const manifestSource = resolve(manifestsDirectory, `${target}.json`);
  const manifest = JSON.parse(await readFile(manifestSource, "utf8"));
  validateManifest(target, manifest);

  await assertSafeDistributionDestination({ destination, projectRoot });
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const buildResult = await build({
    entryPoints: {
      app: resolve(root, "src/app.ts"),
      background: resolve(root, "src/background.ts"),
      popup: resolve(root, "src/popup.ts"),
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: targetSettings[target].esbuildTarget,
    outdir: destination,
    define: { __INVENTORY_SIGNAL_TARGET__: JSON.stringify(target) },
    legalComments: "none",
    metafile: true,
    minify: true,
  });
  await cp(staticDirectory, destination, {
    recursive: true,
    filter: (source) => !source.includes("/manifests"),
  });
  await cp(
    resolve(root, "../../catalog/portable-catalog.json"),
    resolve(destination, "portable-catalog.json"),
  );
  await writeFile(
    resolve(destination, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeDistributionNotices({
    destination,
    extensionRoot: root,
    metafile: buildResult.metafile,
    projectRoot,
  });

  const artifactNames = [
    "background.js",
    "popup.js",
    "icons/inventory-signal.png",
    "portable-catalog.json",
    "app.html",
    "ui.css",
    "app.js",
    "manifest.json",
    ...distributionNoticeFiles,
  ];
  for (const artifact of artifactNames) {
    try {
      await readFile(resolve(destination, artifact));
    } catch {
      throw new Error(`${target}: missing ${artifact}`);
    }
  }
  const executableArtifacts = ["background.js", "popup.js", "app.js"];
  const executableBytes = (
    await Promise.all(
      executableArtifacts.map(
        async (artifact) => (await stat(resolve(destination, artifact))).size,
      ),
    )
  ).reduce((total, size) => total + size, 0);
  if (executableBytes > 500 * 1024) {
    throw new Error(
      `${target}: executable budget exceeded (${executableBytes} bytes > 512000 bytes)`,
    );
  }
  process.stdout.write(`built ${target} Chrome resources in ${destination}\n`);
}

if (requestedTarget === "all") {
  await assertSafeDistributionDestination({ destination: output, projectRoot });
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
}
for (const target of selectedTargets) await buildTarget(target);
