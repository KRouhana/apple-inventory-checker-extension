# Security

Do not put bot tokens, chat IDs, personal postal codes, cookies, raw provider
responses or screenshots containing private settings in public issues.

Use GitHub's private vulnerability-reporting feature when enabled. If it is
unavailable, open an issue asking for a private contact without including the
vulnerability details or any secrets. Maintainers must enable private reporting
before public launch.

The extension sends fixed-purpose requests directly to Apple and optional
Telegram. It does not inject code into Apple or localhost pages. Only the
extension's own trusted pages can invoke privileged background commands.
The popup supplies public watch identifiers; the background reconstructs and
validates the Apple URL against current watch state and the bundled catalog.

Telegram credentials use AES-GCM encryption with a non-extractable WebCrypto
key in extension IndexedDB. This is application-level protection, not an OS
credential vault; malicious extension code or a compromised browser profile
can still access data. Local storage is restricted to trusted extension contexts.

Release changes must preserve unknown-state handling, least permissions,
catalog validation, secret-free packages and dependency/license notices.
