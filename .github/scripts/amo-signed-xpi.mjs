// Ask AMO whether a submitted version is signed, and download it if so.
//
//   node .github/scripts/amo-signed-xpi.mjs <addon-guid> <version> <out.xpi>
//
// Exit codes: 0 = approved and saved to <out.xpi> (hash verified),
//             2 = not approved yet (still under review, or not uploaded),
//             1 = anything else (auth failure, network error, hash mismatch).
// Credentials come from WEB_EXT_API_KEY / WEB_EXT_API_SECRET (AMO JWT issuer
// and secret), the same ones `web-ext sign` uses.

import crypto from "node:crypto";
import fs from "node:fs";

const [guid, version, outPath] = process.argv.slice(2);
const issuer = process.env.WEB_EXT_API_KEY;
const secret = process.env.WEB_EXT_API_SECRET;
if (!guid || !version || !outPath || !issuer || !secret) {
  console.error("usage: amo-signed-xpi.mjs <guid> <version> <out.xpi> (with WEB_EXT_API_KEY/SECRET set)");
  process.exit(1);
}

// AMO API auth: an HS256 JWT with iss/jti/iat/exp, valid at most 5 minutes.
function authHeader() {
  const b64url = (value) => Buffer.from(value).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: issuer, jti: crypto.randomUUID(), iat: now, exp: now + 60 }));
  const signature = crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return { Authorization: `JWT ${head}.${body}.${signature}` };
}

const detailUrl =
  `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(guid)}` +
  `/versions/${encodeURIComponent(version)}/`;
const detail = await fetch(detailUrl, { headers: authHeader() });
if (detail.status === 404) {
  console.log(`v${version} is not on AMO (yet).`);
  process.exit(2);
}
if (!detail.ok) {
  console.error(`AMO version lookup failed: HTTP ${detail.status} ${await detail.text()}`);
  process.exit(1);
}
const { file } = await detail.json();
const status = file && file.status;
console.log(`AMO file status for v${version}: ${status}`);
if (status !== "public") process.exit(2);

const download = await fetch(file.url, { headers: authHeader() });
if (!download.ok) {
  console.error(`Download of the signed file failed: HTTP ${download.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await download.arrayBuffer());
const [algorithm, expected] = String(file.hash || "").split(":");
if (algorithm && expected) {
  const actual = crypto.createHash(algorithm).update(bytes).digest("hex");
  if (actual !== expected) {
    console.error(`Hash mismatch for the signed file: expected ${expected}, got ${actual}`);
    process.exit(1);
  }
}
fs.writeFileSync(outPath, bytes);
console.log(`Saved the signed v${version} (${bytes.length} bytes) to ${outPath}`);
