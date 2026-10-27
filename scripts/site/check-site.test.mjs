import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const html = await readFile(
  new URL("../../site/index.html", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../../site/styles.css", import.meta.url),
  "utf8",
);
const hero = html.match(
  /<section\b[^>]*aria-labelledby="hero-title"[^>]*>([\s\S]*?)<\/section>/,
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

test("homepage hero features iPhone Duo rather than iPhone 18 Pro", () => {
  assert.ok(hero, "Homepage hero must exist");
  assert.match(hero[1], /<h3>iPhone Duo<\/h3>/);
  assert.doesNotMatch(hero[1], /iPhone 18 Pro/);
  assert.match(hero[1], /Example watch · Illustrative availability/);
});

test("hero uses the bundled product image with descriptive accessible text", async () => {
  assert.ok(hero, "Homepage hero must exist");
  const productImage = hero[1].match(
    /<img\b[^>]*class="watch-product-image"[^>]*>/,
  )?.[0];
  assert.ok(productImage, "The hero must render a real product image");
  const src = productImage.match(/\bsrc="([^"]+)"/)?.[1];
  assert.equal(src, "assets/iphone-duo-star-white.png");
  assert.match(
    productImage,
    /alt="iPhone Duo in Star White, showing the open display and folded back"/,
  );
  assert.doesNotMatch(productImage, /aria-hidden="true"|loading="lazy"/);

  const image = await readFile(new URL(`../../site/${src}`, import.meta.url));
  assert.ok(
    image.length > 100_000,
    "The bundled image must contain product pixels",
  );
  assert.equal(
    image.subarray(-8, -4).toString(),
    "IEND",
    "PNG must be complete",
  );
  assert.deepEqual(
    image.subarray(0, 8),
    Buffer.from("89504e470d0a1a0a", "hex"),
  );
  assert.equal(image.subarray(12, 16).toString(), "IHDR");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assert.equal(width, 940, "Preserve the official image's source resolution");
  assert.equal(height, 1112);
  assert.match(productImage, new RegExp(`width="${width}"`));
  assert.match(productImage, new RegExp(`height="${height}"`));
  assert.equal(image[25], 6, "Preserve the PNG's transparent background");
});

test("hero image gets a responsive full-width box, not the old CSS phone drawing", () => {
  assert.doesNotMatch(html, /phone-swatch/);
  assert.doesNotMatch(styles, /phone-swatch/);
  const imageStyle = styles.match(/\.watch-product-image\s*\{([^}]+)\}/)?.[1];
  assert.ok(imageStyle, "Product image styling must exist");
  assert.match(imageStyle, /width:\s*100%/);
  assert.match(imageStyle, /height:\s*auto/);
  assert.match(imageStyle, /aspect-ratio:\s*3\s*\/\s*2/);
  assert.match(imageStyle, /object-fit:\s*cover/);
  assert.match(imageStyle, /object-position:\s*center/);
  const cardStyle = styles.match(/\.watch-card\s*\{([^}]+)\}/)?.[1];
  assert.match(cardStyle, /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});

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
