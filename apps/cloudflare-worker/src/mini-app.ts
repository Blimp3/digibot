/**
 * Static Telegram Mini App shell.
 *
 * The UI deliberately has no user identity input. Telegram's signed raw
 * `WebApp.initData` is copied into an Authorization header and the Worker
 * decides which private records the caller may see. All values returned by
 * the API are inserted with textContent in the browser script.
 */

import {
  DOWNLOADER_MINI_APP_CSS_PATH,
  DOWNLOADER_MINI_APP_JS_PATH,
} from "./mini-app-router";

export const MINI_APP_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'none'",
  "form-action 'none'",
  // Telegram Web may host a Mini App in an iframe; native clients use a
  // WebView. Keep framing limited to Telegram's canonical web origin.
  "frame-ancestors https://web.telegram.org",
  "img-src 'none'",
  "object-src 'none'",
  "script-src 'self' https://telegram.org",
  "script-src-attr 'none'",
  "style-src 'self'",
].join("; ");

const STATIC_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": MINI_APP_CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Static document for the future Telegram Mini App entry point. */
export const MINI_APP_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Private activity history</title>
    <link rel="stylesheet" href="/mini-app.css">
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src="/mini-app.js" defer></script>
  </head>
  <body>
    <main id="app" class="app-shell">
      <header class="app-header">
        <p class="eyebrow">DigiBot</p>
        <h1>Private activity history</h1>
        <p class="intro">Review your retained requests and their recorded outcomes.</p>
        <nav class="view-nav" aria-label="Activity views">
          <a id="integration-view-link" href="/apps/downloader?view=integration">Connected history and stats</a>
        </nav>
      </header>

      <p id="status" class="status" role="status" aria-live="polite"></p>
      <p id="auth-note" class="notice" role="note" hidden>Open this page from Telegram to view your private history.</p>

      <section id="legacy-history-panel" class="panel" aria-labelledby="history-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Your activity</p>
            <h2 id="history-heading">Activity history</h2>
          </div>
          <button id="refresh-history" class="secondary-button" type="button">Refresh</button>
        </div>
        <div class="activity-filters">
          <label>Period<select id="activity-period"><option value="24h">Last 24 hours</option><option value="7d" selected>Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All retained history</option></select></label>
          <label>Task<select id="activity-task"><option value="all">All tasks</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Image</option><option value="other">Other media</option><option value="whisper">Whisper</option><option value="captions">Source captions</option><option value="clips">Clip packs</option></select></label>
        </div>
        <p class="intro">Counts cover all matching retained requests, including pages not yet loaded. A clip pack is one request; delivered clips are counted separately. Deleting history removes it from these counts.</p>
        <dl id="activity-summary" class="history-fields" aria-live="polite" hidden></dl>
        <ol id="history-list" class="history-list" aria-live="polite"></ol>
        <p id="history-empty" class="empty-state" hidden>No activity matches these filters.</p>
        <div class="history-actions">
          <button id="load-more" class="secondary-button" type="button" hidden>Load more</button>
          <button id="clear-history" class="danger-button" type="button">Clear all finished activity</button>
        </div>
      </section>

      <section id="legacy-sources-panel" class="panel" aria-labelledby="sources-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Availability</p>
            <h2 id="sources-heading">Supported sources</h2>
          </div>
          <button id="refresh-sources" class="secondary-button" type="button">Refresh</button>
        </div>
        <div id="sources-list" class="sources-list"></div>
      </section>

      <section id="integration-panel" class="panel" aria-labelledby="integration-heading" hidden>
        <div class="section-heading">
          <div>
            <p class="eyebrow">Connected account</p>
            <h2 id="integration-heading">Shared history and stats</h2>
            <p class="intro"><a id="integration-back-link" href="/apps/downloader">Back to activity history</a></p>
          </div>
          <button id="integration-refresh" class="secondary-button" type="button">Refresh</button>
        </div>
        <div class="activity-filters">
          <label>Period<select id="integration-period"><option value="24h">Last 24 hours</option><option value="7d" selected>Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All retained history</option></select></label>
        </div>
        <dl id="integration-stats" class="history-fields" aria-live="polite" hidden></dl>
        <ol id="integration-history-list" class="history-list" aria-live="polite"></ol>
        <p id="integration-history-empty" class="empty-state" hidden>No connected activity matches this period.</p>
        <div class="history-actions">
          <button id="integration-load-more" class="secondary-button" type="button" hidden>Load more</button>
          <button id="integration-clear-cache" class="danger-button" type="button">Clear connected cache</button>
        </div>
      </section>
    </main>
  </body>
</html>`;

/** Canonical shell for the namespaced downloader app. */
export const MINI_APP_CANONICAL_HTML = MINI_APP_HTML
  .replace('href="/mini-app.css"', `href="${DOWNLOADER_MINI_APP_CSS_PATH}"`)
  .replace('src="/mini-app.js"', `src="${DOWNLOADER_MINI_APP_JS_PATH}"`);

/** Static stylesheet; no inline style is needed by the document. */
export const MINI_APP_CSS = `
:root {
  color-scheme: light dark;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: var(--tg-theme-bg-color, #f4f6f8);
  color: var(--tg-theme-text-color, #1d2733);
  --muted: var(--tg-theme-hint-color, #66717f);
  --panel: var(--tg-theme-secondary-bg-color, #ffffff);
  --accent: var(--tg-theme-button-color, #2aabee);
  --accent-text: var(--tg-theme-button-text-color, #ffffff);
  --danger: var(--tg-theme-destructive-text-color, color-mix(in srgb, var(--tg-theme-text-color, #1d2733) 60%, #ff443a));
  --border: color-mix(in srgb, currentColor 14%, transparent);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-width: 280px;
  background: var(--tg-theme-bg-color, #f4f6f8);
}

button {
  border: 0;
  border-radius: 0.65rem;
  cursor: pointer;
  font: inherit;
  min-height: 2.5rem;
  padding: 0.6rem 0.9rem;
}

button:disabled { cursor: default; opacity: 0.55; }
select:focus-visible, button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

.app-shell { margin: 0 auto; max-width: 56rem; padding: 1.25rem; }
.app-header { margin-bottom: 1rem; }
.view-nav { margin-top: 0.75rem; }
.view-nav a { color: var(--accent); font-weight: 600; }
.eyebrow { color: var(--muted); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.08em; margin: 0 0 0.35rem; text-transform: uppercase; }
h1, h2, h3 { line-height: 1.2; margin: 0; }
h1 { font-size: clamp(1.55rem, 5vw, 2.2rem); }
h2 { font-size: 1.2rem; }
h3 { font-size: 1rem; }
.intro { color: var(--muted); line-height: 1.5; margin: 0.55rem 0 0; max-width: 42rem; }
.status, .notice { border-radius: 0.65rem; margin: 0 0 1rem; padding: 0.7rem 0.85rem; }
.status:empty { display: none; }
.status { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.notice { background: color-mix(in srgb, #d97706 16%, transparent); }
.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 1rem; margin: 1rem 0; padding: 1rem; }
.section-heading { align-items: center; display: flex; gap: 1rem; justify-content: space-between; margin-bottom: 1rem; }
.secondary-button { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--tg-theme-text-color, #1d2733); }
.secondary-button:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 24%, transparent); }
.danger-button { background: color-mix(in srgb, var(--danger) 13%, transparent); color: var(--danger); }
.activity-filters { display: flex; flex-wrap: wrap; gap: 1rem; }
.activity-filters label { display: grid; gap: 0.4rem; flex: 1 1 12rem; }
.activity-filters select { width: 100%; min-height: 2.5rem; font: inherit; padding: 0.5rem; color: inherit; background: var(--panel); border: 1px solid var(--border); border-radius: 0.65rem; }
#activity-summary { margin-bottom: 1rem; }
.history-list { display: grid; gap: 0.75rem; list-style: none; margin: 0; padding: 0; }
.history-item { border: 1px solid var(--border); border-radius: 0.8rem; padding: 0.85rem; }
.history-item-header { align-items: start; display: flex; gap: 0.75rem; justify-content: space-between; }
.history-item-label { overflow-wrap: anywhere; }
.history-item-delete { background: transparent; color: var(--danger); flex: 0 0 auto; min-height: 2rem; padding: 0.35rem 0.5rem; }
.history-item-delete:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 10%, transparent); }
.integration-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.75rem; }
.integration-actions button { flex: 1 1 10rem; }
.history-fields { column-gap: 1rem; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0.75rem 0 0; row-gap: 0.6rem; }
.history-field dt { color: var(--muted); font-size: 0.75rem; margin-bottom: 0.15rem; }
.history-field dd { margin: 0; overflow-wrap: anywhere; }
.empty-state { color: var(--muted); margin: 0; }
.history-actions { display: flex; flex-wrap: wrap; gap: 0.65rem; justify-content: space-between; margin-top: 1rem; }
.sources-list { display: grid; gap: 0.8rem; }
.source-group { border-top: 1px solid var(--border); padding-top: 0.8rem; }
.source-group:first-child { border-top: 0; padding-top: 0; }
.source-group h3 { font-size: 0.95rem; }
.source-group ul { margin: 0.55rem 0 0; padding-left: 1.2rem; }
.source-group li + li { margin-top: 0.65rem; }
.source-note { color: var(--muted); display: block; font-size: 0.9rem; line-height: 1.4; margin-top: 0.15rem; }

@media (max-width: 560px) {
  .app-shell { padding: 1rem 0.75rem; }
  .panel { border-radius: 0.8rem; padding: 0.8rem; }
  .section-heading { align-items: start; }
  .history-fields { grid-template-columns: 1fr; }
  .history-actions { justify-content: stretch; }
  .history-actions button { flex: 1 1 10rem; }
}
`;

/**
 * Browser code for the static shell. It intentionally uses relative API
 * paths so the browser cannot be redirected to a caller-selected origin.
 */
export const MINI_APP_JS = String.raw`
(function () {
  "use strict";

  var SAFE_ERROR = "Something went wrong. Please try again.";
  var PAGE_SIZE = 20;
  var state = { cursor: null, items: [], loading: false, loaded: false, summary: null, period: "7d", task: "all" };
  var integrationState = { cursor: null, items: [], loading: false, loaded: false, stats: null, period: "7d" };
  var taskLabels = { video: "Video", audio: "Audio", image: "Image", other: "Other media", whisper: "Whisper transcript", captions: "Source captions", clips: "Clip pack" };
  var outcomeLabels = { confirmed: "Confirmed delivery", failed: "Failed", unfinished: "In progress", needs_review: "Needs review" };
  var stageLabels = { received: "Received", queued: "Queued", probing: "Checking source", downloading: "Downloading", processing: "Processing", uploading: "Uploading", completed: "Completed", failed: "Failed" };
  var integrationActionLabels = { check: "Check", download: "Download" };
  var integrationStateLabels = { awaiting_upload: "Awaiting upload", queued: "Queued", processing: "Processing", completed: "Completed", failed: "Failed" };
  var integrationInputLabels = { original: "Original media", telegram_photo_copy: "Telegram photo copy", screenshot_copy: "Screenshot copy", derived_audio_segment: "Derived audio segment" };
  var integrationVerdictLabels = { openai_signal_detected: "Supported signal detected", no_supported_openai_signal: "No supported signal detected", indeterminate: "Evidence is indeterminate" };
  var sourceStateLabels = {
    verified: "Verified end to end in DigiBot",
    recognized_unverified: "Recognized/available through the engine but not yet verified",
    intentionally_unsupported: "Intentionally unsupported"
  };

  function byId(id) { return document.getElementById(id); }

  function setStatus(message) {
    var status = byId("status");
    if (status) status.textContent = message || "";
  }

  function getInitData() {
    var telegram = window.Telegram;
    var webApp = telegram && telegram.WebApp;
    return webApp && typeof webApp.initData === "string" ? webApp.initData : "";
  }

  function authHeaders() {
    var initData = getInitData();
    if (!initData) return null;
    return { "accept": "application/json", "authorization": "tma " + initData };
  }

  function request(path, options) {
    var headers = authHeaders();
    if (!headers) return Promise.reject(new Error("AUTH_REQUIRED"));
    var requestOptions = options || {};
    var mergedHeaders = Object.assign({}, headers, requestOptions.headers || {});
    return fetch(path, Object.assign({}, requestOptions, {
      credentials: "same-origin",
      headers: mergedHeaders
    })).then(function (response) {
      if (!response.ok) throw new Error("REQUEST_FAILED");
      return response.json();
    }).then(function (payload) {
      if (!payload || typeof payload !== "object") throw new Error("INVALID_RESPONSE");
      return payload;
    });
  }

  function isIntegrationView() {
    if (typeof window === "undefined" || !window.location || typeof window.location.search !== "string") return false;
    return /(?:^|&)view=integration(?:&|$)/u.test(window.location.search.replace(/^\?/, ""));
  }

  function integrationOperations(payload) {
    return payload && Array.isArray(payload.operations) ? payload.operations : [];
  }

  function integrationNextCursor(payload) {
    return payload && typeof payload.nextCursor === "string" ? payload.nextCursor : null;
  }

  function integrationInputLabel(value) {
    return integrationInputLabels[value] || "Media copy";
  }

  function integrationActionLabel(value) {
    return integrationActionLabels[value] || "Connected action";
  }

  function integrationStateLabel(value) {
    return integrationStateLabels[value] || "In progress";
  }

  function integrationVerdictLabel(value) {
    return integrationVerdictLabels[value] || "Evidence is indeterminate";
  }

  function integrationErrorMessage(error) {
    return error && typeof error.message === "string" ? text(error.message, "The connected action failed.") : "The connected action failed.";
  }

  function setIntegrationVisibility() {
    var legacyHistory = byId("legacy-history-panel");
    var legacySources = byId("legacy-sources-panel");
    var connected = byId("integration-panel");
    if (legacyHistory) legacyHistory.hidden = true;
    if (legacySources) legacySources.hidden = true;
    if (connected) connected.hidden = false;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function text(value, fallback) {
    if (typeof value === "string" && value.trim()) return value.slice(0, 240);
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
  }

  function formatDate(value) {
    if (typeof value !== "string") return "—";
    var date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("en-GB", { timeZone: "UTC" }) + " UTC";
  }

  function formatSize(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return String(Math.round(value)) + " B";
    var units = ["KB", "MB", "GB"];
    var size = value;
    var index = -1;
    do { size /= 1024; index += 1; } while (size >= 1024 && index < units.length - 1);
    return size.toFixed(size >= 10 ? 0 : 1) + " " + units[index];
  }

  function itemId(item) {
    if (!item || typeof item !== "object") return "";
    var value = item.historyId || item.history_id || item.id;
    return typeof value === "string" && value.length > 0 && value.length <= 160 ? value : "";
  }

  function historyItems(payload) {
    if (Array.isArray(payload.items)) return payload.items;
    if (Array.isArray(payload.history)) return payload.history;
    return [];
  }

  function nextCursor(payload) {
    return typeof payload.nextCursor === "string" ? payload.nextCursor :
      typeof payload.next_cursor === "string" ? payload.next_cursor : null;
  }

  function addField(dl, label, value) {
    var wrapper = document.createElement("div");
    wrapper.className = "history-field";
    var term = document.createElement("dt");
    term.textContent = label;
    var description = document.createElement("dd");
    description.textContent = value;
    wrapper.appendChild(term);
    wrapper.appendChild(description);
    dl.appendChild(wrapper);
  }

  function historyItemElement(item) {
    var listItem = document.createElement("li");
    listItem.className = "history-item";
    var articleHeader = document.createElement("div");
    articleHeader.className = "history-item-header";
    var heading = document.createElement("h3");
    heading.className = "history-item-label";
    heading.textContent = text(item && item.safeLabel, taskLabels[item && item.task] || "Media request");
    articleHeader.appendChild(heading);

    var id = itemId(item);
    var terminal = item && (item.status === "completed" || item.status === "failed");
    if (id && terminal) {
      var deleteButton = document.createElement("button");
      deleteButton.className = "history-item-delete";
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.setAttribute("aria-label", "Delete this history item");
      deleteButton.addEventListener("click", function () { deleteItem(id); });
      articleHeader.appendChild(deleteButton);
    }
    listItem.appendChild(articleHeader);

    var fields = document.createElement("dl");
    fields.className = "history-fields";
    addField(fields, "Provider", text(item && item.provider, "Unknown"));
    addField(fields, "Task", taskLabels[item && item.task] || "Other media");
    addField(fields, "Outcome", outcomeLabels[item && item.outcome] || "Needs review");
    if (item && item.outcome === "unfinished") addField(fields, "Stage", stageLabels[item.status] || "In progress");
    addField(fields, "Created", formatDate(item && item.createdAt));
    addField(fields, "Completed", formatDate(item && item.completedAt));
    addField(fields, "Size", formatSize(item && item.sizeBytes));
    var availability = item && item.fileAvailability;
    var availabilityLabel = availability === "available" ? "Available" :
      availability === "expired" ? "Expired" :
        availability === "pending" ? "Pending" :
          availability === "not_available" ? "Not available" :
            availability === "not_stored" ? "Not stored" : "Unavailable";
    addField(fields, "File", availabilityLabel);
    listItem.appendChild(fields);
    return listItem;
  }

  function renderHistory() {
    var list = byId("history-list");
    var empty = byId("history-empty");
    var loadMore = byId("load-more");
    var summary = byId("activity-summary");
    if (!list || !empty || !loadMore || !summary) return;
    clearNode(list);
    state.items.forEach(function (item) { list.appendChild(historyItemElement(item)); });
    empty.hidden = !state.loaded || state.loading || state.items.length !== 0;
    loadMore.hidden = !state.cursor;
    clearNode(summary);
    summary.hidden = !state.summary;
    if (state.summary) {
      [["Accepted requests", "accepted"], ["Confirmed deliveries", "confirmed"], ["Failed", "failed"], ["Unfinished", "unfinished"], ["Needs review", "needsReview"], ["Delivered clips", "deliveredClips"]].forEach(function (field) {
        addField(summary, field[0], text(state.summary[field[1]], "0"));
      });
      addField(summary, "Snapshot", formatDate(state.summary.asOf));
    }
    list.setAttribute("aria-busy", String(state.loading));
    ["refresh-history", "load-more", "clear-history", "activity-period", "activity-task"].forEach(function (id) {
      var control = byId(id);
      if (control) control.disabled = state.loading;
    });
    list.querySelectorAll("button").forEach(function (button) { button.disabled = state.loading; });
  }

  function addIntegrationEvidence(fields, result) {
    var evidence = result && result.evidence;
    if (!evidence) {
      addField(fields, "Evidence", "Not part of a download");
      return;
    }
    addField(fields, "Evidence", integrationVerdictLabel(evidence.verdict));
    addField(fields, "Evidence summary", text(evidence.summary, "No evidence summary available."));
    addField(fields, "Evidence source", text(result.cacheSource, "Unknown"));
    var credentials = evidence.contentCredentials;
    if (!credentials) return;
    addField(fields, "C2PA status", text(credentials.status, "Unknown"));
    addField(fields, "C2PA signature", credentials.signatureValid ? "Verified" : "Not verified");
    addField(fields, "C2PA file binding", credentials.contentBindingValid ? "Verified" : "Not verified");
    addField(fields, "C2PA signer trust", credentials.signerTrusted ? "Trusted by the pinned list" : "Not established by the pinned list");
    addField(fields, "AI declaration", credentials.aiDeclaration === "generated" ? "AI generation declared" : credentials.aiDeclaration === "edited" ? "AI editing declared" : "No supported AI declaration found");
  }

  function addIntegrationArchive(fields, archive) {
    if (!archive || typeof archive !== "object") return;
    addField(fields, "Telegram copy", text(archive.deliveryState, "Unknown"));
    addField(fields, "Archive integrity", text(archive.integrityState, "Unknown"));
    if (archive.roundTripSha256) addField(fields, "Round-trip SHA-256", text(archive.roundTripSha256, "—"));
    if (archive.documentReceipt) {
      var receipt = archive.documentReceipt;
      var receiptText = [receipt.botId, receipt.chatId, receipt.messageId, receipt.fileId].filter(function (value) { return typeof value === "string" && value.length > 0; }).join(" · ");
      addField(fields, "Telegram receipt", receiptText || "Recorded");
    }
    if (archive.error) addField(fields, "Archive error", integrationErrorMessage(archive.error));
  }

  function operationMediaHash(item) {
    if (item && typeof item.mediaSha256 === "string") return item.mediaSha256;
    var media = item && item.envelope && item.envelope.media;
    return media && typeof media.mediaSha256 === "string" ? media.mediaSha256 : "";
  }

  function integrationOperationElement(item) {
    var listItem = document.createElement("li");
    listItem.className = "history-item";
    var articleHeader = document.createElement("div");
    articleHeader.className = "history-item-header";
    var heading = document.createElement("h3");
    heading.className = "history-item-label";
    heading.textContent = integrationActionLabel(item && item.action) + " · " + integrationStateLabel(item && item.state);
    articleHeader.appendChild(heading);
    var operationId = item && typeof item.operationId === "string" ? item.operationId : "";
    if (operationId) {
      var deleteHistoryButton = document.createElement("button");
      deleteHistoryButton.className = "history-item-delete";
      deleteHistoryButton.type = "button";
      deleteHistoryButton.textContent = "Delete history";
      deleteHistoryButton.addEventListener("click", function () { deleteIntegrationHistory(operationId); });
      articleHeader.appendChild(deleteHistoryButton);
    }
    listItem.appendChild(articleHeader);

    var fields = document.createElement("dl");
    fields.className = "history-fields";
    addField(fields, "Action", integrationActionLabel(item && item.action));
    addField(fields, "State", integrationStateLabel(item && item.state));
    addField(fields, "Requested", formatDate(item && item.requestedAt));
    addField(fields, "Expires", formatDate(item && item.expiresAt));
    var mediaHash = operationMediaHash(item);
    if (mediaHash) addField(fields, "Media SHA-256", mediaHash);
    var envelope = item && item.envelope;
    var media = envelope && envelope.media;
    if (media) {
      addField(fields, "Media input", integrationInputLabel(media.inputKind));
      if (media.mimeType) addField(fields, "MIME type", text(media.mimeType, "Unknown"));
      if (media.byteLength !== undefined) addField(fields, "Media size", formatSize(media.byteLength));
      if (media.audioDurationSeconds !== null && media.audioDurationSeconds !== undefined) addField(fields, "Audio duration", text(media.audioDurationSeconds, "—") + " seconds");
    }
    var segment = item && item.segment || media && media.segment;
    if (segment) addField(fields, "Segment", text(segment.startSeconds, "—") + "–" + text(segment.endSeconds, "—") + " seconds");
    addIntegrationEvidence(fields, envelope && envelope.result);
    addIntegrationArchive(fields, item && item.archive);
    var historySync = envelope && envelope.historySync;
    if (historySync) {
      addField(fields, "History sync", text(historySync.state, "Unknown"));
      if (historySync.error) addField(fields, "History sync error", integrationErrorMessage(historySync.error));
    }
    listItem.appendChild(fields);

    if (item && item.error) {
      var error = document.createElement("p");
      error.className = "notice";
      error.textContent = integrationErrorMessage(item.error);
      listItem.appendChild(error);
    }
    var actions = document.createElement("div");
    actions.className = "integration-actions";
    if (item && item.state === "failed" && item.error && item.error.retryable || item && item.archive && item.archive.retryReady) {
      var retryButton = document.createElement("button");
      retryButton.className = "secondary-button";
      retryButton.type = "button";
      retryButton.textContent = "Retry";
      retryButton.addEventListener("click", function () { retryIntegration(operationId); });
      actions.appendChild(retryButton);
    }
    if (mediaHash) {
      var deleteMediaButton = document.createElement("button");
      deleteMediaButton.className = "danger-button";
      deleteMediaButton.type = "button";
      deleteMediaButton.textContent = "Delete media + history";
      deleteMediaButton.addEventListener("click", function () { deleteIntegrationMedia(mediaHash); });
      actions.appendChild(deleteMediaButton);
      var archiveState = item && item.archive && item.archive.deliveryState;
      if (archiveState && archiveState !== "not_required") {
        var deleteArchiveButton = document.createElement("button");
        deleteArchiveButton.className = "danger-button";
        deleteArchiveButton.type = "button";
        deleteArchiveButton.textContent = "Delete Telegram copy";
        deleteArchiveButton.addEventListener("click", function () { deleteIntegrationArchive(mediaHash); });
        actions.appendChild(deleteArchiveButton);
      }
    }
    if (actions.firstChild) listItem.appendChild(actions);
    return listItem;
  }

  function renderIntegrationStats() {
    var stats = byId("integration-stats");
    if (!stats) return;
    clearNode(stats);
    stats.hidden = !integrationState.stats;
    if (!integrationState.stats) return;
    var values = integrationState.stats;
    [["Checks requested", "checksRequested"], ["Checks completed", "checksCompleted"], ["Checks failed", "checksFailed"], ["Fresh checks", "freshChecks"], ["Cached checks", "cachedChecks"], ["Downloads requested", "downloadsRequested"], ["Downloads confirmed", "downloadsConfirmed"], ["Downloads failed", "downloadsFailed"], ["Unique media", "uniqueMedia"], ["Saved originals", "savedOriginals"], ["Unresolved Telegram copies", "unresolvedArchives"], ["Legacy downloads", "legacyDownloads"]].forEach(function (field) {
      addField(stats, field[0], text(values[field[1]], "0"));
    });
    addField(stats, "Stats as of", formatDate(values.asOf));
  }

  function renderIntegrationHistory() {
    var list = byId("integration-history-list");
    var empty = byId("integration-history-empty");
    var loadMore = byId("integration-load-more");
    if (!list || !empty || !loadMore) return;
    clearNode(list);
    integrationState.items.forEach(function (item) { list.appendChild(integrationOperationElement(item)); });
    empty.hidden = !integrationState.loaded || integrationState.loading || integrationState.items.length !== 0;
    loadMore.hidden = !integrationState.cursor;
    list.setAttribute("aria-busy", String(integrationState.loading));
    ["integration-refresh", "integration-load-more", "integration-clear-cache", "integration-period"].forEach(function (id) {
      var control = byId(id);
      if (control) control.disabled = integrationState.loading;
    });
    list.querySelectorAll("button").forEach(function (button) { button.disabled = integrationState.loading; });
    renderIntegrationStats();
  }

  function setIntegrationLoading(value) {
    integrationState.loading = value;
    renderIntegrationHistory();
  }

  function loadIntegrationHistory(append, notice) {
    if (integrationState.loading) return;
    if (!append) {
      integrationState.cursor = null;
      integrationState.items = [];
      integrationState.stats = null;
      integrationState.loaded = false;
    }
    setIntegrationLoading(true);
    setStatus(append ? "Loading more connected activity…" : "Loading connected activity…");
    var historyPath = "/api/integration/history?period=" + encodeURIComponent(integrationState.period);
    if (append && integrationState.cursor) historyPath += "&cursor=" + encodeURIComponent(integrationState.cursor);
    var statsPath = "/api/integration/stats?period=" + encodeURIComponent(integrationState.period);
    return Promise.all([request(historyPath), request(statsPath)]).then(function (payloads) {
      var historyPayload = payloads[0];
      integrationState.items = append ? integrationState.items.concat(integrationOperations(historyPayload)) : integrationOperations(historyPayload);
      integrationState.cursor = integrationNextCursor(historyPayload);
      integrationState.stats = payloads[1];
      integrationState.loaded = true;
      setStatus(notice || "");
    }).catch(function () {
      setStatus(notice ? notice + " Could not refresh connected activity. Please try again." : SAFE_ERROR);
    }).finally(function () {
      setIntegrationLoading(false);
    });
  }

  function mutateIntegration(path, method, message, failureMessage) {
    if (integrationState.loading) return;
    setIntegrationLoading(true);
    setStatus(message);
    request(path, { method: method }).then(function () {
      integrationState.loading = false;
      loadIntegrationHistory(false);
    }).catch(function () {
      integrationState.loading = false;
      renderIntegrationHistory();
      setStatus(failureMessage || SAFE_ERROR);
    });
  }

  function deleteIntegrationHistory(operationId) {
    if (!operationId || integrationState.loading) return;
    mutateIntegration("/api/integration/history/" + encodeURIComponent(operationId), "DELETE", "Deleting connected history…", "Connected history could not be deleted.");
  }

  function deleteIntegrationMedia(mediaSha256) {
    if (!mediaSha256 || integrationState.loading || !window.confirm("Delete this media and all connected history for it?")) return;
    mutateIntegration("/api/integration/media/" + encodeURIComponent(mediaSha256), "DELETE", "Deleting connected media…", "Connected media could not be deleted.");
  }

  function deleteIntegrationArchive(mediaSha256) {
    if (!mediaSha256 || integrationState.loading || !window.confirm("Delete the saved Telegram copy?")) return;
    mutateIntegration("/api/integration/media/" + encodeURIComponent(mediaSha256) + "/archive", "DELETE", "Deleting the Telegram copy…", "The Telegram copy could not be deleted.");
  }

  function retryIntegration(operationId) {
    if (!operationId || integrationState.loading) return;
    mutateIntegration("/api/integration/operations/" + encodeURIComponent(operationId) + "/retry", "POST", "Retrying connected action…", "The connected action could not be retried.");
  }

  function clearIntegrationCache() {
    if (integrationState.loading || !window.confirm("Clear the connected verification cache?")) return;
    mutateIntegration("/api/integration/cache", "DELETE", "Clearing connected cache…", "The connected cache could not be cleared.");
  }

  function setHistoryLoading(value) {
    state.loading = value;
    renderHistory();
  }

  function loadHistory(append, notice) {
    if (state.loading) return;
    if (!append) {
      state.cursor = null;
      state.items = [];
      state.summary = null;
      state.loaded = false;
    }
    setHistoryLoading(true);
    setStatus(append ? "Loading more activity…" : "Loading activity…");
    var path = "/api/apps/downloader/history?limit=" + PAGE_SIZE;
    path += "&period=" + encodeURIComponent(state.period) + "&task=" + encodeURIComponent(state.task);
    if (append && state.cursor) path += "&cursor=" + encodeURIComponent(state.cursor);
    return request(path).then(function (payload) {
      var incoming = historyItems(payload);
      state.items = append ? state.items.concat(incoming) : incoming;
      state.cursor = nextCursor(payload);
      if (!append) state.summary = payload.summary || null;
      state.loaded = true;
      setStatus(notice || "");
    }).catch(function () {
      setStatus(notice ? notice + " Could not refresh activity. Please try again." : SAFE_ERROR);
    }).finally(function () {
      setHistoryLoading(false);
    });
  }

  function mutateHistory(path, message) {
    if (state.loading) return;
    setHistoryLoading(true);
    setStatus(message);
    request(path, { method: "DELETE" }).then(function () {
      state.loading = false;
      loadHistory(false);
    }).catch(function () {
      state.loading = false;
      loadHistory(false, "The deletion could not be completed. Some finished activity may already have been removed.");
    });
  }

  function deleteItem(id) {
    mutateHistory("/api/apps/downloader/history/" + encodeURIComponent(id), "Deleting activity…");
  }

  function clearHistory() {
    if (state.loading || !window.confirm("Clear ALL your finished activity, regardless of these filters? Temporary stored files are also removed. Telegram messages and replay-protection records are not removed.")) return;
    mutateHistory("/api/apps/downloader/history", "Clearing finished activity…");
  }

  function sourceEntries(payload) {
    return Array.isArray(payload.sources) ? payload.sources : [];
  }

  function renderSources(payload) {
    var root = byId("sources-list");
    if (!root) return;
    clearNode(root);
    ["verified", "recognized_unverified", "intentionally_unsupported"].forEach(function (stateName) {
      var group = document.createElement("section");
      group.className = "source-group";
      var heading = document.createElement("h3");
      heading.textContent = sourceStateLabels[stateName];
      group.appendChild(heading);
      var list = document.createElement("ul");
      sourceEntries(payload).filter(function (source) {
        return source && typeof source === "object" && source.state === stateName;
      }).forEach(function (source) {
        var item = document.createElement("li");
        var name = document.createElement("strong");
        name.textContent = text(source.displayName || source.name, "Source");
        item.appendChild(name);
        var note = document.createElement("span");
        note.className = "source-note";
        note.textContent = text(source.note || source.coverage, "Availability depends on the source and access permissions.");
        item.appendChild(note);
        list.appendChild(item);
      });
      if (!list.firstChild) {
        var empty = document.createElement("li");
        empty.textContent = "None listed";
        list.appendChild(empty);
      }
      group.appendChild(list);
      root.appendChild(group);
    });
  }

  function loadSources() {
    request("/api/apps/downloader/sources").then(function (payload) {
      renderSources(payload);
    }).catch(function () {
      var sources = byId("sources-list");
      if (sources) sources.textContent = "Sources are temporarily unavailable. Please refresh sources.";
    });
  }

  function init() {
    var telegram = window.Telegram;
    var webApp = telegram && telegram.WebApp;
    if (webApp && typeof webApp.ready === "function") webApp.ready();
    if (webApp && typeof webApp.expand === "function") webApp.expand();

    var authNote = byId("auth-note");
    if (!getInitData()) {
      if (authNote) authNote.hidden = false;
      return;
    }
    if (authNote) authNote.hidden = true;
    if (isIntegrationView()) {
      setIntegrationVisibility();
      loadIntegrationHistory(false);
      return;
    }
    loadHistory(false);
    loadSources();
  }

  ["activity-period", "activity-task"].forEach(function (id) {
    var control = byId(id);
    if (control) control.addEventListener("change", function () {
      state.period = byId("activity-period").value;
      state.task = byId("activity-task").value;
      loadHistory(false);
    });
  });
  var refreshHistory = byId("refresh-history");
  if (refreshHistory) refreshHistory.addEventListener("click", function () { loadHistory(false); });
  var loadMore = byId("load-more");
  if (loadMore) loadMore.addEventListener("click", function () { loadHistory(true); });
  var clear = byId("clear-history");
  if (clear) clear.addEventListener("click", clearHistory);
  var refreshSources = byId("refresh-sources");
  if (refreshSources) refreshSources.addEventListener("click", loadSources);
  var integrationPeriod = byId("integration-period");
  if (integrationPeriod) integrationPeriod.addEventListener("change", function () {
    integrationState.period = integrationPeriod.value;
    loadIntegrationHistory(false);
  });
  var integrationRefresh = byId("integration-refresh");
  if (integrationRefresh) integrationRefresh.addEventListener("click", function () { loadIntegrationHistory(false); });
  var integrationLoadMore = byId("integration-load-more");
  if (integrationLoadMore) integrationLoadMore.addEventListener("click", function () { loadIntegrationHistory(true); });
  var integrationClearCache = byId("integration-clear-cache");
  if (integrationClearCache) integrationClearCache.addEventListener("click", clearIntegrationCache);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;

/** Keep canonical and legacy assets byte-equivalent while both API namespaces remain supported. */
export const MINI_APP_CANONICAL_JS = MINI_APP_JS;

function assetResponse(body: string, contentType: string, cacheControl = "no-store", head = false): Response {
  return new Response(head ? null : body, {
    status: 200,
    headers: { ...STATIC_HEADERS, "cache-control": cacheControl, "content-type": contentType },
  });
}

export function miniAppHtmlResponse(canonical = false, head = false): Response {
  return assetResponse(canonical ? MINI_APP_CANONICAL_HTML : MINI_APP_HTML, "text/html; charset=utf-8", "no-store", head);
}

export function miniAppCssResponse(canonical = false, head = false): Response {
  return assetResponse(
    MINI_APP_CSS,
    "text/css; charset=utf-8",
    canonical ? "public, max-age=31536000, immutable" : "no-store",
    head,
  );
}

export function miniAppJsResponse(canonical = false, head = false): Response {
  return assetResponse(
    canonical ? MINI_APP_CANONICAL_JS : MINI_APP_JS,
    "application/javascript; charset=utf-8",
    canonical ? "public, max-age=31536000, immutable" : "no-store",
    head,
  );
}
