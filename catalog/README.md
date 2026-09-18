# Public catalog snapshot

`portable-catalog.json` contains 120 product identities across US/CA/UK for
iPhone 18 Pro, Pro Max and Duo, selected-device Apple routes, and three initial
public store anchors. Chrome's public store lookup can add validated store
metadata locally; these anchors are not a claim of nationwide coverage.

This is product/routing metadata, not current stock. `generatedAt` identifies
the source snapshot, not a successful inventory check. The snapshot is retained
from the reviewed current Chrome implementation. The old private generation
pipeline and its operational evidence are deliberately not published here.

Run `pnpm catalog:check` to validate the committed snapshot against the shared
runtime schema. Updating identities/routes requires fresh official Apple
evidence and review; never infer or invent SKUs. Regular iPhone 17 is not active.
