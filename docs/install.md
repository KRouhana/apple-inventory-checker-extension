# Install Inventory Signal from GitHub

**Chrome Web Store — coming soon.** Until the store listing is available, you
can install the Chrome extension from the versioned GitHub release.

## Download and install

1. Open [Releases](https://github.com/KRouhana/apple-inventory-checker-extension/releases/latest).
2. Download `inventory-signal-local-monitor-0.1.4-chrome.zip` and optionally its
   `.sha256` checksum. Choose the attached Chrome ZIP, not GitHub's automatic
   **Source code** archive.
3. Extract the ZIP into a permanent folder, such as `Documents/Inventory Signal`.
   Keep this folder in place; Chrome loads the extension from it.
4. Open `chrome://extensions` in desktop Chrome and enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted folder containing
   `manifest.json` directly.
6. Review Chrome's permission prompt. Settings opens on the first installation.
   Pin Inventory Signal using Chrome's extensions menu for easy access.

## Create a watch

1. Choose a country, phone, storage size and colour in Settings.
2. Enter a postal/ZIP code, select **Find stores**, and choose your stores.
3. Choose a check interval from 2 to 60 minutes and enable desktop and/or
   personal Telegram notifications.
4. Create the watch. Its first check runs immediately, then repeats at your
   selected interval (two minutes by default). Existing retry delays still apply.
   Open the extension popup to see phone/store stock status.
   An **Open at Apple** button appears for a current available result. Use
   **Refresh** in the popup to check enabled watches and update their results.
   Paused watches stay paused; retry delays are respected.

Chrome must remain running and your computer awake and connected for checks.
Unknown means stock could not be verified; it does not mean out of stock.
Apple confirms availability and you complete any purchase yourself.

## Optional Telegram setup

Need a token? Follow [Telegram’s official guide to obtaining a bot token](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
Use a dedicated personal bot, paste its token in Settings, and select **Pair**.
Approve Telegram access if requested. Once paired, the button becomes **Test**;
use it whenever you want to check delivery. Enable Personal Telegram for your watch.

Pairing reuses your saved chat or finds a single private chat in the bot’s recent
messages. If no chat is found, open your bot, send any message once, then select
**Pair** again. Multiple private chats are not guessed. Pairing does not send a
test notification automatically, and setup has no expiring code or link.

Your token and connected chat stay saved across browser sessions with no expiry.
Never post a token, chat ID, postal code or browser data in GitHub issues.

## Update an existing manual installation

Close extension pages, replace the files in the **same permanent folder** with
the new version, then select **Reload** at `chrome://extensions`. Reopen Settings
or the popup. Avoid removing the extension merely to update it.

A different folder or a future Chrome Web Store installation may create a
separate extension identity; watches and Telegram settings do not automatically
transfer. Keep the old installation until you have verified the replacement.

If a saved Telegram connection cannot be read, Settings offers **Disconnect
saved Telegram connection** so you can save your token again without deleting watches.
Disconnect Telegram separately from clearing monitor data.

## Verify the download

On macOS/Linux, place the ZIP and its checksum file in the same folder, then run:

```sh
shasum -a 256 -c inventory-signal-local-monitor-0.1.4-chrome.zip.sha256
```

## Help

Use [GitHub issues](https://github.com/KRouhana/apple-inventory-checker-extension/issues)
for support. Share the displayed error and Chrome version, without private
credentials or location input. See [Privacy](../site/privacy.html).
