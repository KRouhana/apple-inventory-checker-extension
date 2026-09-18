import { describe, expect, it } from "vitest";

import {
  createExactProductIdentityValidator,
  parseApplePickupMessage,
} from "../src/index.js";

interface PartFixtureOptions {
  eligible?: boolean;
  display?: string;
  buyable?: boolean | null;
  title?: string;
}

function part(sku: string, options: PartFixtureOptions = {}) {
  const eligible = options.eligible ?? true;
  const display = options.display ?? "unavailable";
  const buyable =
    options.buyable === undefined ? display === "available" : options.buyable;
  return {
    storePickEligible: eligible,
    pickupSearchQuote:
      display === "available" ? "Available Today" : "Currently unavailable",
    partNumber: sku,
    pickupDisplay: display,
    messageTypes: {
      regular: {
        storePickupProductTitle: options.title ?? `Phone ${sku}`,
      },
    },
    ...(buyable === null
      ? {}
      : {
          buyability: {
            isBuyable: buyable,
            inventory: buyable ? 1 : 0,
          },
        }),
  };
}

function payload(partsAvailability: Record<string, unknown>) {
  return {
    head: { status: "200" },
    body: {
      content: {
        pickupMessage: {
          stores: [
            {
              storeNumber: "R001",
              storeName: "Example Store",
              city: "Toronto",
              state: "ON",
              country: "CA",
              storedistance: 1.25,
              storeDistanceWithUnit: "1.25 km",
              partsAvailability,
            },
          ],
        },
      },
    },
  };
}

function flatPayload(partsAvailability: Record<string, unknown>) {
  return {
    head: { status: "200" },
    body: {
      stores: [
        {
          storeNumber: "R121",
          storeName: "Eaton Centre",
          city: "Toronto",
          state: "ON",
          country: "CA",
          storedistance: 1.16,
          storeDistanceWithUnit: "1.16 km",
          partsAvailability,
        },
      ],
    },
  };
}

function aliasedFlatPayload(partsAvailability: Record<string, unknown>) {
  return {
    head: { status: "200" },
    body: {
      stores: [
        {
          storeUniqueId: "R122",
          name: "Yorkdale",
          address: {
            city: "Toronto",
            state: "ON",
            countryCode: "CA",
          },
          partsAvailability,
        },
      ],
    },
  };
}

describe("parseApplePickupMessage", () => {
  it("parses flat body.stores payload format returned in Canadian and regional endpoints", () => {
    const result = parseApplePickupMessage({
      body: flatPayload({ SKU1: part("SKU1", { display: "available" }) }),
      expectedSkus: ["SKU1"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.status).toBe("available");
      expect(result.observations[0]?.store.storeName).toBe("Eaton Centre");
      expect(result.observations[0]?.store.city).toBe("Toronto");
      expect(result.observations[0]?.store.state).toBe("ON");
    }
  });

  it("normalizes regional store aliases and nested addresses", () => {
    const result = parseApplePickupMessage({
      body: aliasedFlatPayload({
        SKU1: part("SKU1", { display: "available" }),
      }),
      expectedSkus: ["SKU1"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observations[0]?.store).toMatchObject({
        storeNumber: "R122",
        storeName: "Yorkdale",
        city: "Toronto",
        state: "ON",
        country: "CA",
      });
    }
  });

  it("rejects a 541-like HTML response as an upstream error, never unavailable", () => {
    const result = parseApplePickupMessage({
      body: "<html><title>Service unavailable</title></html>",
      httpStatus: 541,
      expectedSkus: ["SKU1"],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "upstream_http_error",
        message: "Apple pickup endpoint returned HTTP 541",
        httpStatus: 541,
      },
    });
  });

  it("rejects an HTML body even when an intermediary reports HTTP 200", () => {
    const result = parseApplePickupMessage({
      body: "<!doctype html>blocked",
      expectedSkus: ["SKU1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_json");
  });

  it("rejects missing required fields", () => {
    const missingStoreName = payload({ SKU1: part("SKU1") });
    delete (
      missingStoreName.body.content.pickupMessage.stores[0] as {
        storeName?: string;
      }
    ).storeName;

    const result = parseApplePickupMessage({
      body: missingStoreName,
      expectedSkus: ["SKU1"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_shape");
      expect(result.error.path).toContain("storeName");
    }
  });

  it("parses mixed availability without guessing unknown states", () => {
    const result = parseApplePickupMessage({
      body: payload({
        AVAILABLE: part("AVAILABLE", { display: "available", buyable: true }),
        UNAVAILABLE: part("UNAVAILABLE", {
          display: "unavailable",
          buyable: false,
        }),
        INELIGIBLE: part("INELIGIBLE", {
          eligible: false,
          display: "unavailable",
          buyable: false,
        }),
        CONTRADICTORY: part("CONTRADICTORY", {
          display: "available",
          buyable: false,
        }),
        NEW_VALUE: part("NEW_VALUE", {
          display: "coming-soon",
          buyable: false,
        }),
        CONTRADICTORY_INELIGIBLE: part("CONTRADICTORY_INELIGIBLE", {
          eligible: false,
          display: "available",
          buyable: true,
        }),
      }),
      expectedSkus: [
        "AVAILABLE",
        "UNAVAILABLE",
        "INELIGIBLE",
        "CONTRADICTORY",
        "NEW_VALUE",
        "CONTRADICTORY_INELIGIBLE",
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      Object.fromEntries(
        result.observations.map(({ sku, status }) => [sku, status]),
      ),
    ).toEqual({
      AVAILABLE: "available",
      UNAVAILABLE: "unavailable",
      INELIGIBLE: "ineligible",
      CONTRADICTORY: "unknown",
      NEW_VALUE: "unknown",
      CONTRADICTORY_INELIGIBLE: "unknown",
    });
  });

  it.each([
    [true, null, "ineligible"],
    [true, false, "ineligible"],
    [false, null, "ineligible"],
    [false, false, "ineligible"],
    [true, true, "unknown"],
    [false, true, "unknown"],
  ] as const)(
    "classifies explicit ineligible pickupDisplay with eligible=%s and buyable=%s as %s",
    (eligible, buyable, status) => {
      const result = parseApplePickupMessage({
        body: payload({
          SKU1: part("SKU1", {
            eligible,
            display: "ineligible",
            buyable,
          }),
        }),
        expectedSkus: ["SKU1"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.observations[0]?.status).toBe(status);
    },
  );

  it.each(["Ineligible", "ineligible ", "ineligible-now"])(
    "keeps unrecognized pickupDisplay %j unknown when the normal eligible flags do not classify it",
    (display) => {
      const result = parseApplePickupMessage({
        body: payload({ SKU1: part("SKU1", { display, buyable: false }) }),
        expectedSkus: ["SKU1"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.observations[0]?.status).toBe("unknown");
    },
  );

  it("requires every store to return exactly the requested SKU set", () => {
    const result = parseApplePickupMessage({
      body: payload({ SKU1: part("SKU1") }),
      expectedSkus: ["SKU1", "SKU2"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("sku_set_mismatch");
      expect(result.error.message).toContain("SKU2");
    }
  });

  it("rejects a part whose object key and returned SKU differ", () => {
    const result = parseApplePickupMessage({
      body: payload({ SKU1: part("OTHER-SKU") }),
      expectedSkus: ["SKU1"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sku_set_mismatch");
  });

  it("requires a nonempty exact requested SKU list", () => {
    const result = parseApplePickupMessage({
      body: payload({ SKU1: part("SKU1") }),
      expectedSkus: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("sku_set_mismatch");
  });

  it("supports exact catalog title validation hooks", () => {
    const validateProductIdentity = createExactProductIdentityValidator([
      { sku: "SKU1", expectedTitle: "Exact Product Title" },
    ]);

    const valid = parseApplePickupMessage({
      body: payload({ SKU1: part("SKU1", { title: "Exact Product Title" }) }),
      expectedSkus: ["SKU1"],
      validateProductIdentity,
    });
    expect(valid.ok).toBe(true);

    const renamed = parseApplePickupMessage({
      body: payload({ SKU1: part("SKU1", { title: "Unexpected Product" }) }),
      expectedSkus: ["SKU1"],
      validateProductIdentity,
    });
    expect(renamed.ok).toBe(false);
    if (!renamed.ok)
      expect(renamed.error.code).toBe("identity_validation_failed");
  });

  it("normalizes only Apple product-title non-breaking spaces before literal identity validation", () => {
    const sku = "MJQ34LL/A";
    const title = "iPhone 18 Pro 256GB Black";
    const validateProductIdentity = createExactProductIdentityValidator([
      { sku, expectedTitle: title },
    ]);

    for (const observedTitle of [
      "iPhone\u00a018 Pro 256GB Black",
      "iPhone\u202f18\u202fPro 256GB Black",
    ]) {
      const result = parseApplePickupMessage({
        body: payload({ [sku]: part(sku, { title: observedTitle }) }),
        expectedSkus: [sku],
        validateProductIdentity,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.observations[0]?.title).toBe(title);
    }

    for (const observedTitle of [
      "iPhone 18 256GB Black",
      "iPhone 18 Pro 512GB Black",
      "iPhone 18 Pro 256GB Blue",
      "iphone 18 Pro 256GB Black",
    ]) {
      const result = parseApplePickupMessage({
        body: payload({ [sku]: part(sku, { title: observedTitle }) }),
        expectedSkus: [sku],
        validateProductIdentity,
      });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.code).toBe("identity_validation_failed");
    }

    const wrongSku = parseApplePickupMessage({
      body: payload({ [sku]: part("MJQ35LL/A", { title }) }),
      expectedSkus: [sku],
      validateProductIdentity,
    });
    expect(wrongSku.ok).toBe(false);
    if (!wrongSku.ok) expect(wrongSku.error.code).toBe("sku_set_mismatch");
  });
});
