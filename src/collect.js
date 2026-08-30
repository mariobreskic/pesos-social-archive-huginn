/* Join asynchronous WordPress responses and emit exactly one post payload. */

function pcString(value) {
  return value === null || typeof value === "undefined" ? "" : String(value);
}

function pcEscapeHtml(value) {
  return pcString(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pcBody(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch (ignoreJson) { return {}; }
  }
  return value || {};
}

function pcCount(object) {
  var count = 0;
  var key;
  for (key in object) {
    if (object.hasOwnProperty(key)) { count += 1; }
  }
  return count;
}

function pcLanguageAttribute(job) {
  return job.language ? " lang=\"" + pcEscapeHtml(job.language) + "\"" : "";
}

function pcMediaBlock(item) {
  if (!item) { return ""; }
  if (item.kind === "video" || item.kind === "gifv") {
    var attributes = item.kind === "gifv" ? ",\"autoplay\":true,\"loop\":true,\"muted\":true" : "";
    var flags = item.kind === "gifv" ? " autoplay loop muted playsinline" : " controls";
    return "<!-- wp:video {\"id\":" + item.id + attributes + "} -->\n" +
      "<figure class=\"wp-block-video\"><video" + flags + " src=\"" + pcEscapeHtml(item.url) +
      "\"></video></figure>\n<!-- /wp:video -->";
  }
  if (item.kind === "audio") {
    return "<!-- wp:audio {\"id\":" + item.id + "} -->\n" +
      "<figure class=\"wp-block-audio\"><audio controls src=\"" + pcEscapeHtml(item.url) +
      "\"></audio></figure>\n<!-- /wp:audio -->";
  }
  if (item.kind === "file") {
    return "<!-- wp:paragraph -->\n<p><a href=\"" + pcEscapeHtml(item.url) +
      "\">Social media attachment</a></p>\n<!-- /wp:paragraph -->";
  }
  return "<!-- wp:image {\"id\":" + item.id + ",\"sizeSlug\":\"full\",\"linkDestination\":\"none\"} -->\n" +
    "<figure class=\"wp-block-image size-full\"><img src=\"" + pcEscapeHtml(item.url) + "\" alt=\"" +
    pcEscapeHtml(item.alt || "") + "\" class=\"wp-image-" + item.id + "\"/></figure>\n<!-- /wp:image -->";
}

function pcTokenBlock(token, media, job) {
  var language = pcLanguageAttribute(job);
  var level;
  var attributes;
  var tag;
  var listAttributes;
  var listHtml;
  var i;

  if (token.type === "paragraph") {
    return "<!-- wp:paragraph -->\n<p" + language + ">" + token.html + "</p>\n<!-- /wp:paragraph -->";
  }
  if (token.type === "heading") {
    level = parseInt(token.level, 10) || 2;
    if (level < 1 || level > 6) { level = 2; }
    attributes = level === 2 ? "" : " {\"level\":" + level + "}";
    return "<!-- wp:heading" + attributes + " -->\n<h" + level + " class=\"wp-block-heading\"" + language + ">" +
      token.html + "</h" + level + ">\n<!-- /wp:heading -->";
  }
  if (token.type === "quote") {
    return "<!-- wp:quote -->\n<blockquote class=\"wp-block-quote\"><p" + language + ">" + token.html +
      "</p></blockquote>\n<!-- /wp:quote -->";
  }
  if (token.type === "preformatted") {
    return "<!-- wp:preformatted -->\n<pre class=\"wp-block-preformatted\"" + language + ">" + token.html +
      "</pre>\n<!-- /wp:preformatted -->";
  }
  if (token.type === "list") {
    tag = token.ordered ? "ol" : "ul";
    listAttributes = token.ordered ? " {\"ordered\":true}" : "";
    listHtml = "";
    for (i = 0; i < token.items.length; i += 1) { listHtml += "<li>" + token.items[i] + "</li>"; }
    return "<!-- wp:list" + listAttributes + " -->\n<" + tag + " class=\"wp-block-list\"" + language + ">" +
      listHtml + "</" + tag + ">\n<!-- /wp:list -->";
  }
  if (token.type === "media" || token.type === "image") {
    return pcMediaBlock(media[String(token.index)]);
  }
  return "";
}

function pcBuildContent(job, media) {
  var blocks = [];
  var i;
  for (i = 0; i < job.tokens.length; i += 1) {
    var block = pcTokenBlock(job.tokens[i], media, job);
    if (block) { blocks.push(block); }
  }
  if (job.source_url) {
    blocks.push("<!-- wp:paragraph {\"className\":\"pesos-source\"} -->\n" +
      "<p class=\"pesos-source\">Source: <a href=\"" + pcEscapeHtml(job.source_url) + "\">Original on " +
      pcEscapeHtml(job.source_name || "social media") + "</a></p>\n<!-- /wp:paragraph -->");
  }
  return blocks.join("\n\n");
}

function pcFail(agent, state, message) {
  if (!state.failed) { agent.error(message); }
  state.failed = true;
}

function pcMaybeFinish(agent, jobs, jobId) {
  var state = jobs[jobId];
  var categoryIds = [];
  var tagIds = [];
  var featuredMedia = 0;
  var termKey;
  var mediaKey;
  var post;

  if (!state || state.emitted || state.failed || !state.job) { return; }
  if (pcCount(state.media) < state.job.media_count) { return; }
  if (pcCount(state.terms) < state.job.term_count) { return; }

  for (termKey in state.terms) {
    if (state.terms.hasOwnProperty(termKey)) {
      if (state.terms[termKey].role === "category") { categoryIds.push(state.terms[termKey].id); }
      if (state.terms[termKey].role === "tag") { tagIds[state.terms[termKey].index] = state.terms[termKey].id; }
    }
  }
  for (mediaKey = 0; mediaKey < state.job.tokens.length; mediaKey += 1) {
    var token = state.job.tokens[mediaKey];
    var candidate = token && (token.type === "media" || token.type === "image") ?
      state.media[String(token.index)] : null;
    if (candidate && candidate.kind === "image") { featuredMedia = candidate.id; break; }
  }
  tagIds = tagIds.filter(function(value) { return typeof value !== "undefined"; });

  post = {
    title: state.job.title,
    slug: state.job.slug,
    status: state.job.post_status || "draft",
    content: pcBuildContent(state.job, state.media),
    excerpt: state.job.excerpt || "",
    categories: categoryIds,
    tags: tagIds,
    featured_media: featuredMedia,
    comment_status: "closed",
    ping_status: "closed"
  };
  if (state.job.wp_date_gmt) { post.date_gmt = state.job.wp_date_gmt; }
  else if (state.job.wp_date) { post.date = state.job.wp_date; }

  state.emitted = true;
  agent.createEvent(post);
  delete jobs[jobId];
}

Agent.receive = function() {
  var events = this.incomingEvents();
  var jobs = this.memory("jobs") || {};
  var now = new Date().getTime();
  var cutoff = now - (2 * 24 * 60 * 60 * 1000);
  var stale;
  var i;

  for (stale in jobs) {
    if (jobs.hasOwnProperty(stale) && jobs[stale].updated_at_ms < cutoff) { delete jobs[stale]; }
  }

  for (i = 0; i < events.length; i += 1) {
    var event = events[i].payload || {};
    var job = event.job_data;
    var jobId = event.job_id || (job && job.job_id);
    var body;
    var termId;
    var termKey;
    if (!jobId || !job) { continue; }
    if (!jobs[jobId]) {
      jobs[jobId] = { job: job, media: {}, terms: {}, emitted: false, failed: false, updated_at_ms: now };
    }
    jobs[jobId].updated_at_ms = now;

    if (event.event_type === "media_request" && typeof event.status !== "undefined") {
      body = pcBody(event.body);
      if (parseInt(event.status, 10) === 201 && body.id && body.source_url) {
        jobs[jobId].media[String(event.media_index)] = {
          id: parseInt(body.id, 10),
          url: body.source_url,
          alt: body.alt_text || event.media_alt || "",
          kind: event.media_kind || body.media_type || "image"
        };
      } else {
        pcFail(this, jobs[jobId], "WordPress media upload failed for " + jobId + " item " + event.media_index +
          " (HTTP " + event.status + "): " + pcString(event.body));
      }
    }

    if (event.event_type === "term_request" && typeof event.status !== "undefined") {
      body = pcBody(event.body);
      termId = body.id || (body.data && body.data.term_id);
      if (termId) {
        termKey = event.term_role + ":" + event.term_index;
        jobs[jobId].terms[termKey] = {
          id: parseInt(termId, 10),
          role: event.term_role,
          index: parseInt(event.term_index, 10)
        };
      } else {
        pcFail(this, jobs[jobId], "WordPress taxonomy request failed for " + jobId + " term " + event.term_name +
          " (HTTP " + event.status + "): " + pcString(event.body));
      }
    }

    pcMaybeFinish(this, jobs, jobId);
  }
  this.memory("jobs", jobs);
};
