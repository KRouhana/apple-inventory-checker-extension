export interface CatalogSkuMapping {
  marketCode: string;
  sku: string;
  variantId: string;
  expectedTitle: string;
}

export type CatalogMappingIssueCode =
  | "missing_field"
  | "duplicate_mapping"
  | "conflicting_mapping";

export interface CatalogMappingIssue {
  code: CatalogMappingIssueCode;
  index: number;
  key: string;
  message: string;
  conflictsWithIndex?: number;
}

export type CatalogValidationResult =
  | {
      valid: true;
      mappings: readonly CatalogSkuMapping[];
      issues: readonly [];
    }
  | {
      valid: false;
      /** Valid rows are returned for diagnostics only; callers must not import them. */
      mappings: readonly CatalogSkuMapping[];
      issues: readonly CatalogMappingIssue[];
    };

function mappingKey(mapping: CatalogSkuMapping): string {
  return `${mapping.marketCode}\u0000${mapping.sku}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

/**
 * Enforces one exact market SKU -> one variant/title mapping.
 *
 * Exact duplicate rows are errors too: silently accepting them makes imports
 * non-deterministic and tends to hide accidental CSV duplication.
 */
export function validateCatalogMappings(
  input: unknown,
): CatalogValidationResult {
  const issues: CatalogMappingIssue[] = [];
  const mappings: CatalogSkuMapping[] = [];
  const seen = new Map<string, { mapping: CatalogSkuMapping; index: number }>();

  if (!Array.isArray(input)) {
    return {
      valid: false,
      mappings: [],
      issues: [
        {
          code: "missing_field",
          index: -1,
          key: "catalog",
          message: "Catalog mappings must be an array",
        },
      ],
    };
  }

  input.forEach((rawMapping: unknown, index) => {
    if (!isRecord(rawMapping)) {
      issues.push({
        code: "missing_field",
        index,
        key: `row:${index}`,
        message: "Catalog mapping must be an object",
      });
      return;
    }

    const fields = ["marketCode", "sku", "variantId", "expectedTitle"] as const;

    for (const field of fields) {
      if (!isText(rawMapping[field])) {
        issues.push({
          code: "missing_field",
          index,
          key: `row:${index}`,
          message: `${field} must be a non-empty string with no surrounding whitespace`,
        });
      }
    }
    if (!fields.every((field) => isText(rawMapping[field]))) return;

    const mapping: CatalogSkuMapping = {
      marketCode: rawMapping.marketCode as string,
      sku: rawMapping.sku as string,
      variantId: rawMapping.variantId as string,
      expectedTitle: rawMapping.expectedTitle as string,
    };
    mappings.push(mapping);
    const key = mappingKey(mapping);

    const previous = seen.get(key);
    if (previous) {
      const identical =
        previous.mapping.variantId === mapping.variantId &&
        previous.mapping.expectedTitle === mapping.expectedTitle;
      issues.push({
        code: identical ? "duplicate_mapping" : "conflicting_mapping",
        index,
        conflictsWithIndex: previous.index,
        key,
        message: identical
          ? `Duplicate catalog mapping for ${mapping.marketCode}/${mapping.sku}`
          : `Conflicting catalog mapping for ${mapping.marketCode}/${mapping.sku}`,
      });
    } else {
      seen.set(key, { mapping, index });
    }
  });

  return issues.length === 0
    ? { valid: true, mappings, issues: [] }
    : { valid: false, mappings, issues };
}

export interface ProductIdentity {
  requestedSku: string;
  responseSku: string;
  title: string;
  storeNumber: string;
}

export type ProductIdentityValidation =
  | { valid: true }
  | { valid: false; reason: string };

export type ProductIdentityValidator = (
  identity: Readonly<ProductIdentity>,
) => ProductIdentityValidation;

/** Creates a literal SKU/title validator for one market's validated catalog. */
export function createExactProductIdentityValidator(
  mappings: readonly Pick<CatalogSkuMapping, "sku" | "expectedTitle">[],
): ProductIdentityValidator {
  const expectedTitles = new Map<string, string>();
  for (const mapping of mappings) {
    if (expectedTitles.has(mapping.sku)) {
      throw new Error(
        `Duplicate SKU passed to identity validator: ${mapping.sku}`,
      );
    }
    expectedTitles.set(mapping.sku, mapping.expectedTitle);
  }

  return ({ requestedSku, responseSku, title }) => {
    if (responseSku !== requestedSku) {
      return {
        valid: false,
        reason: `Response SKU ${responseSku} does not match requested SKU ${requestedSku}`,
      };
    }

    const expectedTitle = expectedTitles.get(requestedSku);
    if (expectedTitle === undefined) {
      return {
        valid: false,
        reason: `SKU ${requestedSku} is not in the catalog`,
      };
    }
    if (title !== expectedTitle) {
      return {
        valid: false,
        reason: `Title mismatch for ${requestedSku}: expected ${JSON.stringify(expectedTitle)}, received ${JSON.stringify(title)}`,
      };
    }
    return { valid: true };
  };
}
