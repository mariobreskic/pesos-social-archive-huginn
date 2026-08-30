# Security notes

## Secrets

Never commit a rendered Scenario, `config.json`, a raw Huginn export, a webhook URL, a WordPress application password, or an API bearer token. The committed Scenario is a placeholder template. Huginn credential names are rendered into Liquid credential tags; their values remain in Huginn.

If a raw export was ever public, rotate every secret it contained. Removing it from the latest commit does not remove it from Git history.

## WordPress account

Use a dedicated WordPress user with the least role that can upload media, create the required terms, and create drafts. Give it a dedicated application password so this integration can be revoked without changing an interactive login.

The template defaults to drafts and requires an explicit renderer flag for publishing. Keep that review gate until the whole route—including media failure behavior—has been tested.

## Webhook

The Webhook Agent secret is an unguessable path component, not a signature. Use at least 32 random URL-safe characters, TLS, reverse-proxy rate limits, and restricted ingress where practical. A routing hashtag is editorial metadata, not authentication.

## Remote media and SSRF

Remote media is the largest trust boundary. The normalizer accepts HTTPS only and rejects credentials in URLs, localhost names, common internal suffixes, private IPv4 literals, loopback, link-local ranges, and obvious private IPv6 literals. DNS can still resolve or redirect a public-looking name to an internal address.

Enforce destination checks again in the component that downloads media. Prefer a host allowlist, block private address ranges after DNS resolution and every redirect, limit response size and time, require an expected media content type, and disable unnecessary protocols.

## Content

Incoming HTML is reduced to a small inline vocabulary before Gutenberg generation. Keep WordPress KSES enabled. The parser is not a browser sanitizer and should not be expanded casually.

Huginn Events contain post bodies, source URLs, and diagnostic response bodies. The template retains Events for seven days and join state for two days; adjust those periods to your operational needs.

## Reporting

Do not open a public issue containing a webhook URL, credential, production hostname, private post, or unredacted Event. Reproduce with one of the example fixtures.
