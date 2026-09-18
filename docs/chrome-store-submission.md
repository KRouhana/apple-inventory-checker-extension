# Chrome Web Store submission draft

Status: package preparation; not uploaded or submitted. The owner confirms an
existing developer account. Store approval and timing remain Google's decision.

## Listing copy

Name: Inventory Signal

Short description: Watch Apple pickup availability in Chrome. Get desktop or optional Telegram alerts, then open the matching product at Apple.

Single purpose: Monitor the user's selected Apple pickup products/stores locally
and notify them when a matching result becomes available.

Detailed description:

Choose an iPhone, find nearby Apple stores, and keep selected pickup options on
your watch list. Inventory Signal checks while Chrome is running and your
computer is awake and connected. See phone/store status in the toolbar popup,
receive desktop alerts or connect your own Telegram bot, then open the matching
product at Apple to continue manually. It does not reserve or buy products.

Inventory Signal covers iPhone 18 Pro, Pro Max and Duo for US, Canada and UK.
Apple requests can fail or be blocked; unknown results never mean out of stock.
Set a 2–60 minute interval and pause or delete watches whenever you choose.
No publisher account, analytics service or monitoring server is required.

Homepage: https://krouhana.github.io/apple-inventory-checker-extension/
Privacy: https://krouhana.github.io/apple-inventory-checker-extension/privacy.html
Support: https://github.com/KRouhana/apple-inventory-checker-extension/issues

## Permission explanations

- alarms: schedule local inventory checks while Chrome is available.
- storage: persist watches, results and encrypted personal Telegram configuration.
- notifications: display user-enabled desktop alerts and a user-triggered test.
- www.apple.com: direct, fixed-endpoint pickup/store requests. Chrome may attach
  browser-managed Apple session cookies; the extension does not read them.
- Optional api.telegram.org: authenticate the user's bot, confirm the selected
  private chat, and send requested Telegram test/availability notifications.

No cookies, tabs, scripting, webRequest or all-URLs permission is requested.
No remote executable code is loaded. Data responses are not evaluated as code.

## Data disclosures to reconcile in the dashboard

Accurately declare authentication information (optional bot token), chat identity,
transient pairing messages and location-related lookup input. Local-only storage
does not justify an unconditional 'no user data' assertion. No data is sold or
used for advertising; processing is limited to the stated user-facing purpose.
Use the live dashboard taxonomy and the published privacy policy as the source.

## Reviewer instructions

Install the package and use Settings to choose a supported phone and country.
Use a public Apple-store postal code to find stores, select a store and create
a watch. Desktop notification testing is available without Telegram. Telegram
is optional; reviewers may use their own dedicated bot and private Start pairing
flow. No publisher login or secret is required. Unknown pickup data is expected
when Apple rejects a request and must not be interpreted as successful stock.

Verify the popup, pause/resume, restart persistence and manual product link.
The first-install settings redirect is not repeated on updates.

## Before Submit for review

- Confirm account contact/2-step verification and any dashboard identity/trader requirements.
- Publish the website/privacy URL and verify them logged out.
- Upload the exact tested ZIP; retain its SHA-256 and version.
- Supply a 128px icon, 440×280 small promotional tile and at least one genuine,
  sanitized 1280×800 candidate screenshot. No screenshot may expose private input.
- Complete listing language/category/regions, privacy attestations and reviewer notes.
- Accept submission only after normal-Chrome acceptance of this extracted build.

Public/unlisted submissions both undergo review. Typical review is days; weeks
are possible. No date is promised. Registration fees/agreements and account
actions remain with the owner.
