#!/usr/bin/env node
/**
 * Validate the committed generated catalog through the authoritative L01 core
 * parser. This runs after `packages/core` has been built by catalog:check, so
 * generator output cannot bypass the runtime schema through a parallel regex
 * implementation.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseLocalCatalogSnapshot } from "../../packages/core/dist/local-monitor-contracts.js";

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return (
    process.argv
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length) ?? fallback
  );
}

const catalogPath = resolve(
  argument("catalog", "catalog/portable-catalog.json"),
);
const parsedJson = JSON.parse(await readFile(catalogPath, "utf8"));
const result = parseLocalCatalogSnapshot(parsedJson);
if (!result.success) {
  const first = result.issues[0];
  throw new Error(
    `portable catalog failed canonical core validation: ${first?.path ?? ""} ${first?.message ?? "invalid"}`,
  );
}
process.stdout.write(
  `portable catalog accepted by canonical core parser: ${result.data.markets.length} markets\n`,
);
