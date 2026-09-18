# Chrome release verification — 0.1.0

Prepared 2026-09-18 from a clean source allowlist with new Git history. The
earlier private project, operational evidence, runtime state and Git history
are excluded. Only Chrome is packaged; the static site is GitHub Pages-ready.

## Verified

- Standalone frozen dependency installation and fresh lockfile.
- Catalog schema, formatting and TypeScript checks.
- 90 core tests and 337 extension tests.
- Independent crypto/UI recovery review and 73 focused reviewer tests.
- Independent source and exact ZIP credential-signature scan: no findings.
- Exact 17-entry archive allowlist, source/manifest match, correct icon sizes
  and license notices; no content scripts, runtime data or source maps.
- Production dependency audit: no known vulnerabilities at preparation.
- Desktop/mobile website review and original illustrative store images.

Archive: `inventory-signal-local-monitor-0.1.0-chrome.zip`

SHA-256: `17bdd9405a393db332052cebb5b74fb32826b3065163972b7bff8b73b8e187cb`

## Still separate from automated evidence

- Normal Chrome acceptance of the extracted package, particularly encrypted
  Telegram restart/migration/disconnect and first-install settings. Earlier
  owner-confirmed notification receipt predates this security change.
- Public source visibility and GitHub Pages publication approved by the owner on 2026-09-18.
- Chrome Web Store account/contact/security attestations, actual upload and
  submission, review and approval. No live listing or review deadline claimed.

The existing unpacked Chrome folder was left untouched. A different load path
or Store installation can have a different extension identity and local data.
