import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(
  new URL("../../site/index.html", import.meta.url),
  "utf8",
);
const catalog = JSON.parse(
  await readFile(
    new URL("../../catalog/portable-catalog.json", import.meta.url),
    "utf8",
  ),
);
const duoSection = html.match(
  /<details\b[^>]*id="iphone-duo-support"[^>]*>([\s\S]*?)<\/details>/,
);
const duoText =
  duoSection?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") ?? "";

test("Duo support is linked from coverage and expanded by default", () => {
  assert.ok(duoSection, "Duo support section must exist");
  assert.match(duoSection[0], /^<details\b[^>]*\bopen(?:\s|>)/);
  assert.match(html, /<a href="#iphone-duo-support">iPhone Duo<\/a>/);
  assert.match(duoText, /Which iPhone Duo options are supported\?/);
});

test("Duo documentation covers the public catalog's regions, capacities and finishes", () => {
  const markets = catalog.markets.filter((market) =>
    market.variants.some((variant) => variant.familySlug === "iphone-duo"),
  );
  assert.equal(markets.length, 3);
  for (const market of markets) {
    assert.ok(duoText.includes(market.name), `Missing ${market.name}`);
    assert.ok(duoText.includes(`(${market.code.toUpperCase()})`));
    for (const variant of market.variants.filter(
      (variant) => variant.familySlug === "iphone-duo",
    )) {
      const option = variant.title.match(/^iPhone Duo (\d+(?:GB|TB)) (.+)$/);
      assert.ok(option, `Unexpected Duo title: ${variant.title}`);
      assert.ok(duoText.includes(option[1]), `Missing capacity ${option[1]}`);
      assert.ok(duoText.includes(option[2]), `Missing finish ${option[2]}`);
    }
  }
});

test("Duo catalog support is distinguished from live pickup availability", () => {
  assert.match(duoText, /Catalog support is not a stock guarantee/);
  assert.match(duoText, /Apple confirms pickup availability at checkout/);
  assert.match(html, /Example watch · Illustrative availability/);
});
