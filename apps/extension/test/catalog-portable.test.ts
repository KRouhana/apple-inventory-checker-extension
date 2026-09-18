import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLocalCatalogSnapshot } from "../../../packages/core/src/local-monitor-contracts";
import {
  compareCatalogFreshness,
  extractPersistableWatchStores,
  isAllowedCatalogUrl,
  parsePortableCatalogSnapshot,
  reconcileWatchWithCatalog,
  resolveWatchPollLocation,
  type PortableCatalogSnapshot,
} from "../src/catalog/portableCatalog";
import { modelLabel, selectorOptions } from "../src/ui/catalog-presentation";

const BUNDLED_FALLBACK_URL = new URL(
  "../../../catalog/portable-catalog.json",
  import.meta.url,
);

function loadBundledFallback(): unknown {
  return JSON.parse(readFileSync(BUNDLED_FALLBACK_URL, "utf8"));
}

function snapshotFixture(): PortableCatalogSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-01T00:00:00.000Z",
    markets: [
      {
        code: "us",
        name: "United States",
        storefrontPath: "",
        variants: [{ sku: "MG464LL/A", title: "iPhone 17 256GB Black" }],
        stores: [
          {
            storeNumber: "R123",
            name: "Fifth Avenue",
            city: "New York",
            region: "NY",
            pollLocation: "Apple Fifth Avenue",
          },
        ],
      },
    ],
  };
}

describe("portable catalog validation", () => {
  it("uses the authoritative core parser, including strict ISO timestamps", () => {
    const candidate = {
      ...snapshotFixture(),
      generatedAt: "September 1, 2026",
    };
    expect(parsePortableCatalogSnapshot(candidate)).toEqual(
      parseLocalCatalogSnapshot(candidate),
    );
    expect(parsePortableCatalogSnapshot(candidate).success).toBe(false);
  });

  it("accepts the generated bundled fallback with only approved active identities", () => {
    const parsed = parsePortableCatalogSnapshot(loadBundledFallback());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const variants = parsed.data.markets.flatMap((market) => market.variants);
    expect(variants).toHaveLength(120);
    expect(new Set(variants.map((variant) => variant.sku)).size).toBe(120);
    expect(
      [...new Set(variants.map((variant) => variant.familySlug))].sort(),
    ).toEqual(["iphone-18-pro", "iphone-18-pro-max", "iphone-duo"]);
    expect(
      variants.every(
        (variant) =>
          variant.title.startsWith("iPhone 18 ") ||
          variant.title.startsWith("iPhone Duo "),
      ),
    ).toBe(true);
    const expectedStores = {
      ca: {
        storeNumber: "R121",
        name: "Apple Eaton Centre",
        city: "Toronto",
        region: "Ontario",
        pollLocation: "M5B 2H1",
      },
      uk: {
        storeNumber: "R092",
        name: "Apple Regent Street",
        city: "London",
        region: "Central London",
        pollLocation: "W1B 2EL",
      },
      us: {
        storeNumber: "R095",
        name: "Apple Fifth Avenue",
        city: "New York",
        region: "New York",
        pollLocation: "10153",
      },
    } as const;
    for (const market of parsed.data.markets) {
      expect(market.variants).toHaveLength(40);
      expect(
        Object.fromEntries(
          [...new Set(market.variants.map((variant) => variant.familySlug))]
            .sort()
            .map((familySlug) => [
              familySlug,
              market.variants.filter(
                (variant) => variant.familySlug === familySlug,
              ).length,
            ]),
        ),
      ).toEqual({
        "iphone-18-pro": 16,
        "iphone-18-pro-max": 16,
        "iphone-duo": 8,
      });
      expect(market.stores).toEqual([expectedStores[market.code]]);
    }
  });

  it("projects the three active models with customer-facing labels", () => {
    const parsed = parsePortableCatalogSnapshot(loadBundledFallback());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const market = parsed.data.markets.find((entry) => entry.code === "us");
    expect(market).toBeDefined();
    if (!market) return;
    const options = selectorOptions(parsed.data, {
      market: market.code,
      model: "",
      storage: "",
      color: "",
      sku: "",
    });
    expect(options.models).toEqual([
      "iphone-18-pro",
      "iphone-18-pro-max",
      "iphone-duo",
    ]);
    expect(options.models.map((model) => modelLabel(market, model))).toEqual([
      "iPhone 18 Pro",
      "iPhone 18 Pro Max",
      "iPhone Duo",
    ]);
  });

  it("rejects wrong schema versions and duplicate market codes", () => {
    const fixture = snapshotFixture();
    expect(
      parsePortableCatalogSnapshot({ ...fixture, schemaVersion: 99 }).success,
    ).toBe(false);
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [fixture.markets[0], fixture.markets[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate SKUs, duplicate stores, and unqualified anchors", () => {
    const fixture = snapshotFixture();
    const market = fixture.markets[0]!;
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [
          {
            ...market,
            variants: [market.variants[0], market.variants[0]],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [{ ...market, stores: [market.stores[0], market.stores[0]] }],
      }).success,
    ).toBe(false);
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [
          {
            ...market,
            stores: [{ ...market.stores[0], pollLocation: "  " }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects executable fields and unexpected keys (data-only)", () => {
    const fixture = snapshotFixture();
    const withProto = JSON.parse(JSON.stringify(fixture));
    withProto["__proto__"] = { polluted: true };
    expect(parsePortableCatalogSnapshot(withProto).success).toBe(false);
    expect(
      parsePortableCatalogSnapshot({ ...fixture, script: "alert(1)" }).success,
    ).toBe(false);
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [
          { ...fixture.markets[0], codeUrl: "https://evil.example/x.js" },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects malformed SKUs", () => {
    const fixture = snapshotFixture();
    const market = fixture.markets[0]!;
    expect(
      parsePortableCatalogSnapshot({
        ...fixture,
        markets: [
          {
            ...market,
            variants: [{ sku: "not-a-sku", title: "Bogus Phone" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("catalog freshness and origin guards", () => {
  const current = {
    schemaVersion: 1 as const,
    generatedAt: "2026-09-01T00:00:00.000Z",
  };

  it("accepts newer catalogs, rejects rollbacks and versions", () => {
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-09-09T00:00:00.000Z",
      }),
    ).toEqual({ kind: "newer_available" });
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({ kind: "current" });
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 1,
        generatedAt: "2026-08-01T00:00:00.000Z",
      }).kind,
    ).toBe("rollback_rejected");
    expect(
      compareCatalogFreshness(current, {
        schemaVersion: 99,
        generatedAt: "2026-10-01T00:00:00.000Z",
      }).kind,
    ).toBe("unsupported_version");
  });

  it("restricts remote fetches to the fixed HTTPS origin", () => {
    const origin = "https://catalog.example.com";
    expect(
      isAllowedCatalogUrl("https://catalog.example.com/v1/iphone.json", origin),
    ).toBe(true);
    expect(
      isAllowedCatalogUrl("http://catalog.example.com/v1/iphone.json", origin),
    ).toBe(false);
    expect(
      isAllowedCatalogUrl("https://evil.example.com/v1.json", origin),
    ).toBe(false);
    expect(isAllowedCatalogUrl("not a url", origin)).toBe(false);
  });
});

describe("poll location resolution and reconciliation", () => {
  it("resolves qualified anchors and reports unknown stores explicitly", () => {
    const catalog = snapshotFixture();
    expect(
      resolveWatchPollLocation(
        { market: "us", pollAnchor: { storeNumber: "R123" } },
        catalog,
      ),
    ).toBe("Apple Fifth Avenue");
    expect(
      resolveWatchPollLocation(
        { market: "us", pollAnchor: { storeNumber: "R999" } },
        catalog,
      ),
    ).toBe(null);
    // The bundled fallback exposes only the historically qualified public
    // anchor; arbitrary store numbers remain unsupported rather than guessed.
    const parsed = parsePortableCatalogSnapshot(loadBundledFallback());
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(
      resolveWatchPollLocation(
        { market: "us", pollAnchor: { storeNumber: "R095" } },
        parsed.data,
      ),
    ).toBe("10153");
  });

  it("reports retired SKUs/stores without mutating the watch", () => {
    const watch = {
      market: "us" as const,
      skus: ["MG464LL/A", "ZZ999LL/A"],
      storeNumbers: ["R123", "R999"],
      pollAnchor: { storeNumber: "R123" },
    };
    const before = JSON.parse(JSON.stringify(watch));
    const issues = reconcileWatchWithCatalog(watch, snapshotFixture());
    expect(issues.map((issue) => issue.kind).sort()).toEqual([
      "unknown_sku",
      "unknown_store",
    ]);
    expect(watch).toEqual(before);
  });

  it("flags title drift and ambiguous rows for revalidation", () => {
    const watch = {
      market: "us" as const,
      skus: ["MG464LL/A"],
      storeNumbers: ["R123"],
      pollAnchor: { storeNumber: "R123" },
    };
    const drift = reconcileWatchWithCatalog(watch, snapshotFixture(), {
      "MG464LL/A": "Something Else Entirely",
    });
    expect(drift).toHaveLength(1);
    expect(drift[0]?.kind).toBe("title_mismatch");
    const ambiguous: PortableCatalogSnapshot = {
      ...snapshotFixture(),
      markets: [
        {
          ...snapshotFixture().markets[0]!,
          variants: [
            { sku: "MG464LL/A", title: "iPhone 17 256GB Black" },
            { sku: "MG464LL/A", title: "Conflicting Title" },
          ],
        },
      ],
    };
    const issues = reconcileWatchWithCatalog(watch, ambiguous);
    expect(issues.some((issue) => issue.kind === "ambiguous_catalog")).toBe(
      true,
    );
  });
});

describe("privacy boundary: postal input never persists", () => {
  it("extracts only public store numbers from a transient lookup", () => {
    const result = extractPersistableWatchStores(
      { market: "us", userPostalInput: "10001" },
      ["R123"],
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.storeNumbers).toEqual(["R123"]);
    expect(JSON.stringify(result)).not.toContain("10001");
  });

  it("refuses to persist when no public store was chosen", () => {
    expect(
      extractPersistableWatchStores(
        { market: "us", userPostalInput: "10001" },
        [],
      ).success,
    ).toBe(false);
    expect(
      extractPersistableWatchStores({ market: "us", userPostalInput: "   " }, [
        "R123",
      ]).success,
    ).toBe(false);
  });
});
