# Source adapters

The core consumes meaning, not platform response objects. Map each source to the stable Event contract before the Webhook Agent.

| Source | Map into the core | Keep outside the core |
| --- | --- | --- |
| Bluesky | post record text, post URI/RKey, public post URL, author handle, indexed/created time | AT Protocol authentication and URI resolution |
| Instagram | caption, shortcode, permalink, photo URL, alt text, publication time; set `media_position` to `before` | expiring CDN acquisition and carousel policy |
| Mastodon | status ID/URL, account display name, `created_at`, plain text derived from content HTML, tags, media attachments | fixed-instance polling, bearer token, account ID, boost/reply policy |
| Threads | post text, post ID, permalink, username, publication time | IFTTT ingredient names and platform authentication |
| Tumblr | post ID/URL, title, body HTML/text, tags, publication time | blog identity, API/IFTTT authentication, reblog policy |
| Twitter/X | tweet text, status ID/URL, username, publication time | t.co expansion, API/IFTTT authentication, reply/retweet policy |

## IFTTT

Use filter code to construct one JSON body, then send it with the Webhooks action as `application/json`. The ingredient names vary by trigger and can change; the contract does not.

```javascript
MakerWebhooks.makeWebRequest.setBody(JSON.stringify({
  source: "threads",
  source_name: "Threads",
  source_id: /* platform post ID ingredient */,
  source_url: /* public permalink ingredient */,
  author: /* username ingredient */,
  created_at: /* publication time ingredient */,
  text: /* post text ingredient */,
  trigger_tag: "socialposts",
  language: "en"
}));
```

The platform trigger may already guarantee the routing hashtag. Still send `trigger_tag` explicitly: it records the adapter’s decision and gives the core one uniform gate. The normalizer removes that hashtag from content and taxonomy.

## Tumblr HTML

Send both `body_html` and `body_text` when available. The HTML supplies block order and inline images; the plain text improves title and excerpt generation. Send Tumblr tags as either an array or a comma-separated string. Do not pre-render Gutenberg markup in the adapter.

## Instagram media

For a single image, `media_url`, `media_alt`, and `media_position: "before"` are sufficient. For multiple allowed items, use the common `media` array. Decide carousel and video policy in the adapter; the core accepts at most ten declared media items and rejects a larger job rather than silently truncating it.

## Mastodon polling

Keep the instance origin and account identifier in a fixed, authenticated polling agent. Map each returned status separately. Preserve attachment `type`, `url`, and `description` as `kind`, `url`, and `alt`. Remove boosts or replies before mapping if they do not belong in the archive.

Do not accept a Mastodon instance URL from the public webhook and then fetch it. A fixed poller is easier to audit and does not create a general-purpose request primitive.

## Twitter/X links

Prefer expanded text or an explicit, trusted mapping from t.co URLs to destination URLs. The generalized core does not follow short links. If a resolver is unavoidable, restrict it to known shortener hosts and keep it in the Twitter adapter so a caller cannot make Huginn probe arbitrary URLs.

## Dates and identities

Use ISO 8601 when the source provides it. The normalizer also accepts the common IFTTT English form `August 30, 2026 at 9:15 AM`, but that form has no timezone and is therefore less precise.

`source_id` should be the platform’s immutable post identifier, not the mutable title or body. A source-specific identifier plus the normalized `source` becomes the duplicate key.
