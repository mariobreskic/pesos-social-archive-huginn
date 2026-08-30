/*
 * Turn one source adapter Event into a bounded set of archive jobs.
 * ES5 is deliberate: Huginn installations often run an older MiniRacer.
 */

var PX_ROUTING_TAG = "__ROUTING_TAG__";
var PX_POST_STATUS = "__POST_STATUS__";
var PX_MAX_MEDIA = 10;

function pxString(value) {
  return value === null || typeof value === "undefined" ? "" : String(value);
}

function pxTrim(value) {
  return pxString(value).replace(/^\s+|\s+$/g, "");
}

function pxCharacters(value) {
  var text = pxString(value);
  var characters = [];
  var i;
  for (i = 0; i < text.length; i += 1) {
    var first = text.charCodeAt(i);
    if (first >= 0xD800 && first <= 0xDBFF && i + 1 < text.length) {
      var second = text.charCodeAt(i + 1);
      if (second >= 0xDC00 && second <= 0xDFFF) {
        characters.push(text.substring(i, i + 2));
        i += 1;
        continue;
      }
    }
    characters.push(text.charAt(i));
  }
  return characters;
}

function pxTruncate(value, limit) {
  var text = pxTrim(value);
  var characters = pxCharacters(text);
  if (characters.length <= limit) { return text; }
  var slice = characters.slice(0, limit + 1).join("")
    .replace(/\s+\S*$/, "")
    .replace(/[\s,;:\u2013\u2014-]+$/, "");
  if (!slice || pxCharacters(slice).length < 24) {
    slice = characters.slice(0, limit).join("").replace(/[\s,;:\u2013\u2014-]+$/, "");
  }
  return slice + "\u2026";
}

function pxParseJson(value, fallback) {
  if (typeof value !== "string") { return value; }
  try { return JSON.parse(value); } catch (ignoreJson) { return fallback; }
}

function pxFNV1a(value) {
  var hash = 2166136261;
  var text = pxString(value);
  var i;
  for (i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function pxSlug(value) {
  var slug = pxTrim(value).toLowerCase().replace(/&/g, "and");
  if (typeof slug.normalize === "function") {
    try { slug = slug.normalize("NFKD"); } catch (ignoreNormalize) {}
  }
  return slug
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pxTag(value) {
  var tag = pxTrim(value).replace(/^#+/, "");
  if (typeof tag.normalize === "function") {
    try { tag = tag.normalize("NFKC"); } catch (ignoreNormalize) {}
  }
  tag = tag.toLowerCase().replace(/&/g, "and");
  try {
    return tag.replace(new RegExp("[^\\p{L}\\p{N}]+", "gu"), "");
  } catch (ignoreUnicodeProperties) {
    return tag.replace(/[^0-9A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+/g, "");
  }
}

function pxTitleCaseSlug(value) {
  var parts = pxString(value).split("-");
  var result = [];
  var i;
  for (i = 0; i < parts.length; i += 1) {
    if (parts[i]) { result.push(parts[i].charAt(0).toUpperCase() + parts[i].substring(1)); }
  }
  return result.join(" ");
}

function pxBlockedHost(hostname) {
  var host = pxString(hostname).toLowerCase().replace(/\.$/, "");
  var ipv4;
  var first;
  var second;

  if (!host || host === "localhost" || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) {
    return true;
  }
  if (/^\[/.test(host)) {
    return /^\[(?:::1|fc|fd|fe[89ab])/i.test(host);
  }
  ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) { return false; }
  first = parseInt(ipv4[1], 10);
  second = parseInt(ipv4[2], 10);
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || first >= 224;
}

function pxSafeHttps(value) {
  var url = pxTrim(value);
  var match = /^https:\/\/([^\/?#]+)(?:[\/?#]|$)/i.exec(url);
  var authority;
  var host;
  if (!match) { return ""; }
  authority = match[1];
  if (authority.indexOf("@") !== -1) { return ""; }
  host = authority.replace(/:\d+$/, "");
  return pxBlockedHost(host) ? "" : url;
}

function pxSafeLink(value) {
  var link = pxSafeHttps(value);
  if (link) { return link; }
  return /^mailto:[^\s<>]+$/i.test(pxTrim(value)) ? pxTrim(value) : "";
}

function pxEscapeHtml(value) {
  return pxString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pxDecodeAttribute(value) {
  return pxString(value)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function pxAttribute(tag, name) {
  var expression = new RegExp("\\b" + name + "\\s*=\\s*([\\\"'])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1", "i");
  var match = expression.exec(tag);
  return match ? pxDecodeAttribute(match[2]) : "";
}

function pxRemoveRoutingTag(value) {
  return pxTrim(pxString(value)
    .replace(new RegExp("(^|\\s)#" + PX_ROUTING_TAG + "\\b", "gi"), "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n"));
}

function pxSanitizeInline(html) {
  var cleaned = pxString(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--([\s\S]*?)-->/g, "");

  return cleaned.replace(/<\/?[^>]+>/g, function(tag) {
    var closing = /^<\//.test(tag);
    var nameMatch = /^<\/?\s*([a-z0-9]+)/i.exec(tag);
    var name = nameMatch ? nameMatch[1].toLowerCase() : "";
    var href;

    if (name === "b") { name = "strong"; }
    if (name === "i") { name = "em"; }
    if (name === "strike") { name = "s"; }
    if (name === "br") { return closing ? "" : "<br>"; }
    if (/^(strong|em|code|s|del|u|sub|sup)$/.test(name)) {
      return closing ? "</" + name + ">" : "<" + name + ">";
    }
    if (name === "a") {
      if (closing) { return "</a>"; }
      href = pxSafeLink(pxAttribute(tag, "href"));
      return href ? "<a href=\"" + pxEscapeHtml(href) + "\">" : "";
    }
    return "";
  });
}

function pxPlainText(html) {
  return pxTrim(pxSanitizeInline(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, ""));
}

function pxLargestImageUrl(imgTag) {
  var srcset = pxAttribute(imgTag, "srcset");
  var fallback = pxSafeHttps(pxAttribute(imgTag, "src"));
  var bestUrl = fallback;
  var bestScore = 0;
  var candidates;
  var i;

  if (!srcset) { return fallback; }
  candidates = srcset.split(",");
  for (i = 0; i < candidates.length; i += 1) {
    var candidate = pxTrim(candidates[i]);
    var match = /^(\S+)\s+(\d+(?:\.\d+)?)(w|x)$/i.exec(candidate);
    if (match) {
      var url = pxSafeHttps(pxDecodeAttribute(match[1]));
      var score = parseFloat(match[2]) * (match[3].toLowerCase() === "x" ? 10000 : 1);
      if (url && score > bestScore) {
        bestUrl = url;
        bestScore = score;
      }
    }
  }
  return bestUrl;
}

function pxPushMedia(media, seen, spec) {
  var url = pxSafeHttps(spec.url);
  var kind = pxTrim(spec.kind || spec.type || "image").toLowerCase();
  var index;
  if (!url || seen[url]) { return -1; }
  if (kind === "photo") { kind = "image"; }
  if (kind === "animated_gif") { kind = "gifv"; }
  if (!/^(image|video|gifv|audio|file)$/.test(kind)) { kind = "file"; }
  index = media.length;
  seen[url] = true;
  media.push({
    index: index,
    url: url,
    kind: kind,
    alt: pxTruncate(spec.alt || spec.alt_text || "", 500),
    title: pxTruncate(spec.title || "", 160)
  });
  return index;
}

function pxAddImages(fragment, tokens, media, seen) {
  var imageExpression = /<img\b[^>]*>/gi;
  var match;
  while ((match = imageExpression.exec(fragment))) {
    var index = pxPushMedia(media, seen, {
      url: pxLargestImageUrl(match[0]),
      kind: "image",
      alt: pxAttribute(match[0], "alt")
    });
    if (index >= 0) { tokens.push({ type: "media", index: index }); }
  }
}

function pxAddParagraph(inner, tokens, media, seen) {
  var imageExpression = /<img\b[^>]*>/gi;
  var cursor = 0;
  var match;
  var found = false;
  var before;
  var after;
  var clean;

  while ((match = imageExpression.exec(inner))) {
    found = true;
    before = pxRemoveRoutingTag(pxSanitizeInline(inner.substring(cursor, match.index)));
    if (pxPlainText(before)) { tokens.push({ type: "paragraph", html: before }); }
    pxAddImages(match[0], tokens, media, seen);
    cursor = match.index + match[0].length;
  }
  if (found) {
    after = pxRemoveRoutingTag(pxSanitizeInline(inner.substring(cursor)));
    if (pxPlainText(after)) { tokens.push({ type: "paragraph", html: after }); }
  } else {
    clean = pxRemoveRoutingTag(pxSanitizeInline(inner));
    if (pxPlainText(clean)) { tokens.push({ type: "paragraph", html: clean }); }
  }
}

function pxParseHtml(html) {
  var input = pxString(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  var tokens = [];
  var media = [];
  var seen = {};
  var blockExpression = /<p\b[^>]*>[\s\S]*?<\/p>|<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>|<blockquote\b[^>]*>[\s\S]*?<\/blockquote>|<pre\b[^>]*>[\s\S]*?<\/pre>|<(?:ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>|<div\b[^>]*>[\s\S]*?<\/div>|<figure\b[^>]*>[\s\S]*?<\/figure>/gi;
  var cursor = 0;
  var match;

  function addGap(gap) {
    var clean = pxRemoveRoutingTag(pxSanitizeInline(gap));
    if (pxPlainText(clean)) { tokens.push({ type: "paragraph", html: clean }); }
  }

  while ((match = blockExpression.exec(input))) {
    addGap(input.substring(cursor, match.index));
    var block = match[0];
    var open = /^<\s*([a-z0-9]+)/i.exec(block);
    var tagName = open ? open[1].toLowerCase() : "";
    var body;

    if (/<img\b/i.test(block) && (tagName === "div" || tagName === "figure")) {
      pxAddImages(block, tokens, media, seen);
    } else if (tagName === "p") {
      pxAddParagraph(block.replace(/^<p\b[^>]*>/i, "").replace(/<\/p>$/i, ""), tokens, media, seen);
    } else if (/^h[1-6]$/.test(tagName)) {
      body = pxRemoveRoutingTag(pxSanitizeInline(block.replace(/^<h[1-6]\b[^>]*>/i, "").replace(/<\/h[1-6]>$/i, "")));
      if (pxPlainText(body)) { tokens.push({ type: "heading", level: parseInt(tagName.substring(1), 10), html: body }); }
    } else if (tagName === "blockquote") {
      body = pxRemoveRoutingTag(pxSanitizeInline(block.replace(/^<blockquote\b[^>]*>/i, "").replace(/<\/blockquote>$/i, "")));
      if (pxPlainText(body)) { tokens.push({ type: "quote", html: body }); }
    } else if (tagName === "pre") {
      body = pxRemoveRoutingTag(pxTrim(block.replace(/^<pre\b[^>]*>/i, "").replace(/<\/pre>$/i, "")));
      if (body) { tokens.push({ type: "preformatted", html: pxEscapeHtml(body) }); }
    } else if (tagName === "ul" || tagName === "ol") {
      var items = [];
      var itemExpression = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
      var itemMatch;
      while ((itemMatch = itemExpression.exec(block))) {
        body = pxRemoveRoutingTag(pxSanitizeInline(itemMatch[1]));
        if (pxPlainText(body)) { items.push(body); }
      }
      if (items.length) { tokens.push({ type: "list", ordered: tagName === "ol", items: items }); }
    } else {
      addGap(block);
    }
    cursor = match.index + block.length;
  }
  addGap(input.substring(cursor));
  return { tokens: tokens, media: media, seen: seen };
}

function pxLinkify(value) {
  var text = pxString(value);
  var result = "";
  var expression = /https:\/\/[^\s<>"']+/gi;
  var cursor = 0;
  var match;
  while ((match = expression.exec(text))) {
    result += pxEscapeHtml(text.substring(cursor, match.index));
    var full = match[0];
    var url = full;
    var trailing = "";
    while (/[.,!?;:]$/.test(url)) {
      trailing = url.substring(url.length - 1) + trailing;
      url = url.substring(0, url.length - 1);
    }
    var safe = pxSafeHttps(url);
    result += safe ? "<a href=\"" + pxEscapeHtml(safe) + "\">" + pxEscapeHtml(url) + "</a>" : pxEscapeHtml(full);
    result += pxEscapeHtml(trailing);
    cursor = match.index + full.length;
  }
  result += pxEscapeHtml(text.substring(cursor));
  return result.replace(/\n/g, "<br>");
}

function pxTextTokens(value) {
  var paragraphs = pxRemoveRoutingTag(value).replace(/\r\n?/g, "\n").split(/\n{2,}/);
  var tokens = [];
  var i;
  for (i = 0; i < paragraphs.length; i += 1) {
    var paragraph = pxTrim(paragraphs[i]);
    if (paragraph) { tokens.push({ type: "paragraph", html: pxLinkify(paragraph) }); }
  }
  return tokens;
}

function pxValues(value) {
  var parsed = pxParseJson(value, value);
  if (Object.prototype.toString.call(parsed) === "[object Array]") { return parsed; }
  if (parsed === null || typeof parsed === "undefined" || parsed === "") { return []; }
  return [parsed];
}

function pxCollectTags(value, result, seen) {
  var values = pxValues(value);
  var i;
  var parts;
  var j;
  for (i = 0; i < values.length; i += 1) {
    parts = typeof values[i] === "string" ? values[i].split(",") : [values[i]];
    for (j = 0; j < parts.length; j += 1) {
      var tag = pxTag(parts[j]);
      if (tag && tag !== pxTag(PX_ROUTING_TAG) && !seen[tag]) {
        seen[tag] = true;
        result.push(tag);
      }
    }
  }
}

function pxCollectHashtags(value, result, seen) {
  var text = pxString(value);
  var expression;
  var match;
  try {
    expression = new RegExp("#([\\p{L}\\p{N}_]+)", "gu");
  } catch (ignoreUnicodeProperties) {
    expression = /#([0-9A-Za-z_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]+)/g;
  }
  while ((match = expression.exec(text))) { pxCollectTags(match[1], result, seen); }
}

function pxDate(value) {
  var text = pxTrim(value);
  var result = { date: "", date_gmt: "", label: "" };
  var iso = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})?/.exec(text);
  var months;
  var human;
  var hour;

  if (iso) {
    result.label = iso[1];
    result.date = iso[1] + "T" + iso[2] + ":" + (iso[3] || "00");
    if (iso[4]) {
      var parsed = new Date(text);
      if (!isNaN(parsed.getTime())) { result.date_gmt = parsed.toISOString().substring(0, 19); }
    }
    return result;
  }

  months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12
  };
  human = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(text);
  if (human && months[human[1].toLowerCase()]) {
    function two(number) { return number < 10 ? "0" + number : String(number); }
    hour = parseInt(human[4], 10);
    if (human[7].toUpperCase() === "PM" && hour !== 12) { hour += 12; }
    if (human[7].toUpperCase() === "AM" && hour === 12) { hour = 0; }
    result.label = human[3] + "-" + two(months[human[1].toLowerCase()]) + "-" + two(parseInt(human[2], 10));
    result.date = result.label + "T" + two(hour) + ":" + human[5] + ":" + (human[6] || "00");
  }
  return result;
}

function pxCleanTitleText(value) {
  return pxTrim(pxRemoveRoutingTag(pxString(value))
    .replace(/https:\/\/\S+/gi, "")
    .replace(/(?:^|\s)#[^\s#]+/g, " ")
    .replace(/\s+/g, " "));
}

function pxTitle(supplied, text, sourceName, dateLabel) {
  var explicit = pxTrim(supplied).replace(/\s+/g, " ");
  var clean;
  var match;
  if (explicit && !/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(explicit)) {
    return pxTruncate(explicit, 96);
  }
  clean = pxCleanTitleText(text);
  if (clean) {
    match = /^(.+?[.!?\u2026](?:[\u201D\u2019"\)\]]+)?)(?:\s|$)/.exec(clean);
    if (match && pxCharacters(match[1]).length >= 12) { clean = match[1]; }
    return pxTruncate(clean, 96);
  }
  return pxTruncate(sourceName + " post from " + dateLabel, 96);
}

function pxIdentifier(payload, sourceUrl) {
  var supplied = pxTrim(payload.source_id || payload.id);
  var match;
  if (supplied) { return pxTruncate(supplied.replace(/\s+/g, "-"), 160); }
  match = /\/([^\/?#]+)\/?(?:[?#].*)?$/.exec(sourceUrl);
  return match && match[1] ? pxTruncate(match[1], 160) : "url-" + pxFNV1a(sourceUrl);
}

function pxExplicitMedia(payload, media, seen, title) {
  var specs = pxValues(payload.media || payload.attachments);
  var singular = payload.media_url || payload.image_url || payload.photo_url || payload.source_media_url;
  var tokens = [];
  var i;
  if (singular) {
    specs.push({
      url: singular,
      kind: payload.media_kind || payload.kind || "image",
      alt: payload.media_alt || payload.alt || "",
      title: payload.media_title || title
    });
  }
  for (i = 0; i < specs.length; i += 1) {
    var spec = typeof specs[i] === "string" ? { url: specs[i] } : (specs[i] || {});
    if (!spec.title) { spec.title = title; }
    var index = pxPushMedia(media, seen, spec);
    if (index >= 0) { tokens.push({ type: "media", index: index }); }
  }
  return tokens;
}

function pxFail(agent, reason, details) {
  var event = details || {};
  event.event_type = "job_failed";
  event.stage = "normalize";
  event.reason = reason;
  agent.error("PESOS ingress rejected: " + reason);
  agent.createEvent(event);
}

Agent.receive = function() {
  var events = this.incomingEvents();
  var recent = this.memory("recent_jobs") || {};
  var now = new Date().getTime();
  var cutoff = now - (14 * 24 * 60 * 60 * 1000);
  var oldKey;
  var e;

  for (oldKey in recent) {
    if (recent.hasOwnProperty(oldKey) && recent[oldKey] < cutoff) { delete recent[oldKey]; }
  }

  for (e = 0; e < events.length; e += 1) {
    var payload = pxParseJson(events[e].payload || {}, {});
    var source = pxSlug(payload.source);
    var sourceName = pxTruncate(payload.source_name || pxTitleCaseSlug(source), 64);
    var sourceUrl = pxSafeHttps(payload.source_url || payload.url);
    var route = pxTag(payload.trigger_tag);
    var sourceId;
    var jobId;
    var dateInfo;
    var rawText;
    var bodyHtml;
    var parsed;
    var explicitTokens;
    var tokens;
    var media;
    var tags = [];
    var seenTags = {};
    var title;
    var idSlug;
    var slug;
    var category;
    var language;
    var job;
    var i;

    if (!source || !sourceName) { pxFail(this, "missing_source", {}); continue; }
    if (route !== pxTag(PX_ROUTING_TAG)) { pxFail(this, "routing_tag_mismatch", { source: source }); continue; }
    if (!sourceUrl) { pxFail(this, "source_url_must_be_public_https", { source: source }); continue; }

    sourceId = pxIdentifier(payload, sourceUrl);
    jobId = source + ":" + sourceId;
    if (recent[jobId]) { continue; }

    dateInfo = pxDate(payload.created_at || payload.published_at);
    if (!dateInfo.date) { pxFail(this, "unparseable_created_at", { source: source, source_id: sourceId }); continue; }

    rawText = pxString(payload.text || payload.body_text || payload.caption || payload.content_text);
    bodyHtml = pxString(payload.body_html || payload.html);
    title = pxTitle(payload.title, rawText || pxPlainText(bodyHtml), sourceName, dateInfo.label);
    parsed = bodyHtml ? pxParseHtml(bodyHtml) : { tokens: pxTextTokens(rawText), media: [], seen: {} };
    media = parsed.media;
    explicitTokens = pxExplicitMedia(payload, media, parsed.seen, title);
    tokens = pxTrim(payload.media_position).toLowerCase() === "before" ?
      explicitTokens.concat(parsed.tokens) : parsed.tokens.concat(explicitTokens);

    if (media.length > PX_MAX_MEDIA) {
      pxFail(this, "too_many_media_items", { source: source, source_id: sourceId, media_count: media.length });
      continue;
    }

    pxCollectTags(payload.tags, tags, seenTags);
    pxCollectHashtags(rawText || pxPlainText(bodyHtml), tags, seenTags);
    idSlug = pxSlug(sourceId).substring(0, 24) || pxFNV1a(sourceId);
    slug = dateInfo.date.substring(0, 16).replace("T", "-").replace(":", "") + "-" + source + "-" + idSlug;
    category = pxTruncate(payload.category || sourceName, 64);
    language = pxTrim(payload.language || payload.lang);
    if (language && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) { language = ""; }

    job = {
      job_id: jobId,
      source: source,
      source_id: sourceId,
      source_name: sourceName,
      source_url: sourceUrl,
      author: pxTruncate(payload.author || payload.user_name || payload.username, 160),
      language: language,
      title: title,
      excerpt: pxTruncate(payload.excerpt || pxCleanTitleText(rawText || pxPlainText(bodyHtml)), 280),
      slug: slug,
      post_status: PX_POST_STATUS,
      wp_date: dateInfo.date,
      wp_date_gmt: dateInfo.date_gmt,
      tokens: tokens,
      media_count: media.length,
      term_count: tags.length + 1,
      received_at_ms: now
    };

    recent[jobId] = now;
    this.createEvent({ event_type: "job_start", job_id: jobId, job_data: job });

    for (i = 0; i < media.length; i += 1) {
      this.createEvent({
        event_type: "media_request",
        job_id: jobId,
        media_index: i,
        media_url: media[i].url,
        media_kind: media[i].kind,
        media_alt: media[i].alt,
        media_title: media[i].title || title,
        job_data: job
      });
    }

    this.createEvent({
      event_type: "term_request",
      job_id: jobId,
      term_role: "category",
      term_index: 0,
      term_endpoint: "categories",
      term_name: category,
      job_data: job
    });

    for (i = 0; i < tags.length; i += 1) {
      this.createEvent({
        event_type: "term_request",
        job_id: jobId,
        term_role: "tag",
        term_index: i,
        term_endpoint: "tags",
        term_name: tags[i],
        job_data: job
      });
    }
  }
  this.memory("recent_jobs", recent);
};
