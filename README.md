# Tarara

Firefox extension that opens configured URLs in tabs, watches the network traffic inside
those tabs, and forwards matching responses (including the response body) as JSON via
POST to a configurable API endpoint.

## How it works

1. **Each configuration entry is one tab.** When monitoring starts, Tarara opens every
   enabled entry's URL in its own tab.
2. Inside each tab, every network response is inspected.
3. Responses are matched **per entry** by:
   - **URL patterns** — `*` wildcards, one per line or comma-separated
     (e.g. `https://example.com/api/*`). An empty field matches every request in the tab.
   - **Content type** — JSON / XML / HTML / Text / JavaScript / CSS / WebSocket / All (multi-select).
4. Matches are POSTed as JSON to the configured API endpoint, together with a timestamp,
   the computer name, and the response body.
   - Selecting **WebSocket** additionally captures **incoming** WebSocket messages
     inside the tab — see [WebSocket capture](#websocket-capture).
5. If an entry has a **refresh interval** greater than 0, its tab is reloaded
   (cache bypassed) every N seconds; `0` disables automatic reloading.
6. If an entry has **scroll to end** enabled, Tarara gently scrolls that tab towards the bottom
   after each load and keeps going whenever the page grows, so content that only loads on scroll
   (lazy loading / infinite scroll) gets a chance to load and be captured.

Stopping the monitor closes the tabs Tarara opened. Closing all watched tabs by hand also
stops the monitor.

## Installation

### For users (signed build)

1. Download the latest `tarara-<version>.xpi` from the
   [GitHub Pages](https://knezovic.github.io/TararaFox/) host, e.g.
   `https://knezovic.github.io/TararaFox/tarara-<version>.xpi`.
2. In Firefox open `about:addons` → gear icon → *Install Add-on From File…* and pick the
   `.xpi` (or drag the `.xpi` onto the Firefox window).
3. The build is signed by Mozilla (unlisted channel), so it installs and stays enabled on
   normal Firefox and ESR.

Once installed, Firefox auto-updates the add-on from this repo (see
[Releasing & automatic updates](#releasing--automatic-updates)) — no reinstall needed for new
versions.

### For development

- **Temporary:** open `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
  pick `manifest.json` in this folder.
- **With web-ext:** `npm install`, then `npm start` (launches Firefox with the extension
  loaded), `npm run lint`, or `npm run build` to produce a zip in `web-ext-artifacts/`.

## Releasing & automatic updates

Distribution is **unlisted**: signed by Mozilla but not listed on addons.mozilla.org. The
signed `.xpi` and `updates.json` are both hosted on **GitHub Pages**, and Firefox
auto-updates from `browser_specific_settings.gecko.update_url` →
`https://knezovic.github.io/TararaFox/updates.json`.

> GitHub Releases reject `.xpi` files (not on their asset allowlist), so the signed build
> is served from the Pages `docs/` directory instead of a Release asset.

**One-time setup**

1. Create AMO API credentials (JWT issuer + secret) at
   [addons.mozilla.org API keys](https://addons.mozilla.org/developers/addon/api/key/).
2. Add them as repo secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`
   (Settings → Secrets and variables → Actions).
3. Enable GitHub Pages with source **Deploy from a branch** → branch `main` → folder
   `/docs` (Settings → Pages → Build and deployment → Source: Deploy from a branch).

**Each release**

1. Bump `version` in `manifest.json`.
2. Commit, then tag and push: `git tag v<version> && git push origin main --tags`.
3. The `Release` workflow signs the build (unlisted), copies `tarara-<version>.xpi` and a
   regenerated `updates.json` into `docs/`, commits and pushes that to `main`. Pages then
   serves both. (A GitHub Release with notes is created too, but the `.xpi` itself is not
   attached — it lives on Pages.)
4. Installed copies auto-update within roughly a day.

The gecko id `tarara@tararafox` must stay fixed — changing it makes AMO treat the add-on as a
new extension and breaks update continuity.

## Configuration

Open the extension's **Settings** page (from the toolbar popup or the add-ons manager).

| Field | Meaning |
| --- | --- |
| Computer name | Sent with every report. Defaults to `TARARA-XXXXXX` (6 random letters, set once at install); editable. |
| API endpoint | **https** URL that receives the POST requests. HTTP is rejected, since captured bodies may be sensitive. |
| API key | Optional. Sent as the `X-API-Key` header with every report so your endpoint can authenticate requests. |
| Watched tabs | One row per tab: enabled flag, tab URL, URL patterns, content types, refresh interval in seconds, a *scroll to end* toggle, and an *active* toggle (bring the tab to the foreground when it loads/refreshes so lazy content keeps loading). |

Settings changes apply the next time monitoring starts.

## Payload

Each matched response produces one POST with `Content-Type: application/json`:

```json
{
  "timestamp": "2026-06-11T12:34:56.789Z",
  "computerName": "TARARA-KQXZPA",
  "pageUrl": "https://example.com/dashboard",
  "requestUrl": "https://example.com/api/data",
  "domain": "example.com",
  "method": "POST",
  "resourceType": "xmlhttprequest",
  "statusCode": 200,
  "contentType": "application/json; charset=utf-8",
  "requestBody": "{\"page\":1}",
  "requestBodyEncoding": "text",
  "requestBodyTruncated": false,
  "bodyEncoding": "text",
  "bodyTruncated": false,
  "byteLength": 1234,
  "body": "{\"items\":[...]}"
}
```

- `bodyEncoding` is `"text"` for textual responses and `"base64"` for binary ones
  (only possible when the *All* content type is selected).
- `bodyTruncated` is `true` when the captured response body exceeded the 10 MiB cap.
- `byteLength` is the size in bytes of the **complete** body as received (the full response body, or the
  full WebSocket frame), before any truncation to the cap. For a binary WebSocket frame that could not be
  decoded across the page boundary, `byteLength` still reports the frame's size even though `body` is empty.
- `requestBody` is the **outgoing request payload** that the page sent (e.g. a POST/PUT
  body); it is `""` for bodyless requests such as a `GET`. `requestBodyEncoding` is `"text"`
  for a UTF-8 body or JSON-serialized form data, `"base64"` for a binary upload body, and
  `null` when there is no body. `requestBodyTruncated` is the request-side counterpart of
  `bodyTruncated` (same 10 MiB cap).
- The request body is captured **only for requests that pass every filter** — i.e. the same
  matches that are forwarded to the endpoint, never for filtered-out requests.

### WebSocket capture

When a row has the **WebSocket** content type selected (or **All**), Tarara captures the
**incoming** messages of any WebSocket the page opens whose URL matches the row's URL patterns.
Patterns are tested against the socket's `wss://`/`ws://` URL *and* its `https://`/`http://`
equivalent, so a pattern written in either scheme works (and an empty patterns field captures
every message). Each message is POSTed using the same payload shape, with:

| Field | WebSocket value |
| --- | --- |
| `requestUrl` | the socket URL (e.g. `wss://example.com/socket`) |
| `domain` | the socket's hostname (e.g. `example.com`) |
| `method` | `WS_RECV` (only incoming messages are captured) |
| `resourceType` | `websocket` |
| `statusCode` | `null` |
| `contentType` | `text/plain` (text frame) or `application/octet-stream` (binary frame) |
| `requestBody` / `requestBodyEncoding` / `requestBodyTruncated` | `""` / `null` / `false` (frames carry no request body) |
| `bodyEncoding` | `text` for text frames, `base64` for binary frames |
| `byteLength` | full byte size of the frame (reported even when a binary frame could not be decoded) |
| `body` | the frame payload (text, or base64 for binary) |

No new top-level fields are added, so an endpoint that already accepts the HTTP payload accepts
WebSocket messages unchanged.

How it works: `webRequest` can only see the WebSocket HTTP handshake, not the frames, so the
frames are read in-page by a content script (`content/ws-hook.js`) that wraps the page's
`WebSocket`. On Firefox this is done across the Xray membrane (`window.wrappedJSObject` +
`exportFunction`) at `document_start`, so it neither injects a `<script>` (page CSP does not
apply) nor races the page's own scripts. The hook only **adds** a `message` listener to each
socket and never overrides `send()`, so the page's outgoing traffic is left completely untouched
(wrapping send across the membrane could break a live feed such as Socket.IO ping/pong). The hook
is registered dynamically (`contentScripts.register`) only for the origins of rows that opted into
WebSocket capture, and unregistered when monitoring stops.

## Content type mapping

| Filter | Matching MIME types |
| --- | --- |
| JSON | `application/json`, `text/json`, `*+json` |
| XML | `application/xml`, `text/xml`, `*+xml` |
| HTML | `text/html`, `application/xhtml+xml` |
| Text | any other `text/*` |
| JavaScript | `application/javascript`, `text/javascript`, `application/x-javascript`, `application/ecmascript` |
| CSS | `text/css` |
| WebSocket | WebSocket frames (no MIME type; see [WebSocket capture](#websocket-capture)) |
| All | everything, including responses without a Content-Type header, plus WebSocket frames |

## Notes & limits

- **Manifest V2 on purpose.** Reading response bodies requires Firefox's
  `webRequest.filterResponseData`, which together with second-granularity refresh timers
  is only reliable with a persistent background page. Firefox fully supports MV2 with no
  announced end-of-life.
- Failed deliveries are retried twice with backoff; at most 500 reports are queued in
  memory, after which the oldest are dropped (counted as *Failed* in the popup).
- The toolbar badge shows the number of delivered reports while running; it turns red if
  any delivery failed.
- Captured data passes through unchanged — the watched pages keep working normally. The
  WebSocket hook is fully fail-safe: if wrapping ever throws, the page keeps its native
  `WebSocket` and only capture is lost.
- Requests made by service workers are not attributable to a tab and are not captured.
- **Scroll to end** is injected only into Tarara's own watched tabs (never other tabs open on the
  same site) and re-runs after every reload. It drives its own in-page loop and behaves the same
  whether the tab is visible or hidden, so the page is scrolled all the way through and all its
  lazy-loaded content loads in both cases; a hard step cap keeps it from scrolling an endless feed
  forever. Each step it scrolls whichever container holds the scrollable content — the main document,
  or the largest inner scrollable panel when the page keeps the document itself fixed (common in
  single-page apps and sportsbook event lists) — re-detecting the scroller every step, so a panel that
  mounts late is still handled. In a background tab Firefox throttles the loop's timer, so the steps
  (and the page's resulting lazy-load requests) bunch up — the timing is poor but the content still
  loads. For steady timing, keep the watched tab in a visible window.
- **Active** toggle: Firefox throttles background (hidden) tabs, so lazy-loaded content often
  does not arrive in a hidden tab. A row with **Active** on is brought to the foreground on
  every load (the initial open and each refresh), keeping lazy content loading. This **steals
  focus** — if several rows have it on, their tabs fight for the foreground on every reload. Use
  it on a dedicated monitoring machine, not while you are working in the same Firefox window.
- **WebSocket limitations:** frames opened inside **Web Workers** run in a separate realm and
  cannot be captured by a main-document hook. Only frames in the main document and same-origin
  frames are seen. Binary frames are captured best-effort; an undecodable binary frame is still
  reported (empty `body`, `bodyEncoding: "base64"`, `bodyTruncated: true`) so its occurrence is not
  lost and it is distinguishable from a genuinely empty frame.
- The `<all_urls>` host permission is needed both to read responses in arbitrary watched
  pages and to POST to the API endpoint without CORS restrictions.
