# Tarara — Privacy Policy & permission justifications

Effective date: 2026-06-20. Add-on ID: `tarara@tararafox`.

## Privacy Policy

**Tarara — Privacy Policy**

**Last updated: 2026-06-20**

This Privacy Policy describes how the Tarara browser extension ("Tarara", "the
extension") handles data. Tarara is a developer/operator tool that opens web pages you
configure, watches the network traffic inside those specific tabs, and forwards the
matching responses (and WebSocket messages) to an HTTPS API endpoint **that you
configure and control**.

### What data is involved

When monitoring is running, for each network response (or WebSocket message) inside a
**tab you explicitly configured** that matches your URL-pattern and content-type
filters, Tarara reads the following and sends it, as a JSON `POST`, to the API endpoint
you entered in the settings:

- A UTC timestamp of the capture.
- The computer name you set in the settings (defaults to `Tarara-yyyyMMdd`, editable).
- The page URL of the watched tab and the request URL of the matched resource.
- The HTTP method, resource type, HTTP status code, and response Content-Type.
- The **response body** (the actual content of the matched response) — as text when
  textual, or base64-encoded when binary.
- The **outgoing request body** the page sent (e.g. a POST/PUT payload), when present.
- For WebSocket frames: the socket URL, the frame payload (incoming messages only), and
  the frame size. Outgoing WebSocket traffic is never read or modified.
- Size and truncation flags (bodies/frames are capped at 10 MiB).

This data describes both the **content** of the watched pages/services and the
**activity** on them (which URLs were requested, when, with which methods and results).
That is why Tarara declares the Firefox data-collection permissions `websiteContent`
and `websiteActivity`.

### Where the data goes

- **To your own API endpoint only.** Tarara transmits the captured data solely to the
  HTTPS endpoint you entered in the settings. The endpoint is yours; the Tarara
  developer does **not** receive, collect, store, or have any access to this data.
- **Not to Mozilla, not to the developer, not to any third party.** Tarara contains no
  telemetry, analytics, crash-reporting, advertising, or tracking SDKs, and does not
  sell or share data with anyone.

### What is stored locally

- Tarara stores only your **settings** (computer name, API endpoint, and the list of
  watched tabs) in the browser's local extension storage (`browser.storage.local`).
- Captured data is held **only in memory**, in a bounded queue (at most 500 pending
  reports, oldest dropped first). It is **never written to disk** and is lost when the
  browser closes.
- Tarara does not store your browsing history, and it captures nothing from tabs you did
  not explicitly configure to watch.

### What Tarara does NOT do

- It does **not** watch, read, or capture traffic from tabs you did not configure.
- It does **not** collect personal data beyond what flows through the watched pages you
  chose; what those pages contain is determined by the sites you visit, not by Tarara.
- It does **not** modify or block any request. The stream filter used to read response
  bodies always passes data through unchanged, so watched pages keep working normally.
- It does **not** require an account or login, and contains no third-party code that
  transmits data elsewhere.

### Your controls

- You choose exactly which tabs/URLs are watched, which content types are matched, and
  where the data is sent.
- You can start or stop monitoring at any time from the toolbar popup, and closing the
  watched tabs stops monitoring automatically.
- You can remove the extension (via the Firefox Add-ons manager) or clear its storage
  to erase the stored settings at any time.
- You can set an optional API key on the settings page that is sent to your endpoint as
  the `X-API-Key` header; clear it any time to stop sending it.
- Securing the destination API endpoint (access control) is your responsibility; Tarara
  enforces HTTPS and optionally forwards your API key, but does not impose any other
  authentication.

### Security

- The API endpoint is required to be HTTPS; plaintext HTTP endpoints are rejected, so
  captured data is encrypted in transit to your endpoint.
- Optionally, an API key you set on the settings page is sent as an `X-API-Key` HTTP
  header with every report, so your endpoint can authenticate requests. The key is stored
  locally with your other settings and is sent only to your configured endpoint.
- Reading of network traffic is strictly gated: only your explicitly configured tabs,
  and only requests matching your URL patterns and content-type selections, are read.

### Children

Tarara is a developer/operator tool and is not directed at children. No data is
knowingly collected from children.

### Changes

This policy may be updated; the current version is kept in the Tarara source repository.

### Contact

Developer: tarara.hr
Contact: https://github.com/knezovic/TararaFox/issues
Jurisdiction: Croatia (European Union)

## Permission justifications

### `<all_urls>` (host permission)
The user can configure any web URL to be watched, so the set of target origins cannot be
known in advance and cannot be listed as fixed host permissions. Actual reading is
strictly gated: Tarara only inspects a request when it belongs to a tab the user
explicitly added **and** the request URL matches the per-row URL patterns the user
entered **and** the response Content-Type matches the user's content-type selections.
Traffic from all other tabs (tabs the user did not configure) is never read. So while
the manifest requests `<all_urls>` to allow arbitrary user-configured targets, no data is
read indiscriminately from all sites.

### `webRequest`
Used to read response headers (specifically `Content-Type`) so each response can be
matched against the user's content-type filter before its body is captured, and to read
the outgoing request body (`requestBody`) the page sent. No request is blocked or
modified.

### `webRequestBlocking`
Required to use Firefox's `webRequest.filterResponseData` API, which is the only way to
read response **bodies** and is MV2-only. The "blocking" capability is used solely to
attach a stream filter; the filter always writes the data through to the page unchanged
(`filter.write(event.data)` on every chunk), so requests are never blocked, delayed, or
modified — watched pages keep working normally. This permission exists only to enable
response-body capture, not to alter traffic.

### `storage`
Stores the user's settings (computer name, API endpoint, list of watched tabs) locally
via `browser.storage.local`. No captured data is persisted to storage; captured data
lives only in memory and is lost on browser restart.

### `tabs`
Used to open, reload (refresh), and close the tabs the user explicitly configured, and
to attribute each network request to the tab it came from so capture can be gated to the
user's configured tabs. Tarara does not read page content of, or otherwise interact with,
tabs it did not open itself.

### `data_collection_permissions: websiteContent`
Tarara captures the **content** of responses and request bodies (and WebSocket frame
payloads) from the specific tabs/URLs the user configures, and forwards that content to
the user's own HTTPS endpoint. This is the extension's core purpose.

### `data_collection_permissions: websiteActivity`
Tarara captures **activity metadata** about the watched tabs: which URLs were requested,
HTTP methods, timestamps, and status codes. This metadata is forwarded, alongside the
content above, to the user's own HTTPS endpoint.