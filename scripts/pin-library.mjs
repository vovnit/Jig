// Pins a browser build for a script library, the same download `add_library`
// does at authoring time: `node scripts/pin-library.mjs <url>` prints the
// `{name, url, sha256, code}` JSON to paste into the spec.
import { createHash } from "node:crypto";

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/pin-library.mjs <url>");
  process.exit(1);
}
if (!url.startsWith("https://")) {
  console.error("refused: the URL must be https");
  process.exit(1);
}
const host = url.slice("https://".length).split("/")[0].toLowerCase();
const path = url.slice("https://".length + host.length);
if (host === "cdn.jsdelivr.net") {
  if (!path.startsWith("/npm/") || !/@\d+\.\d+\.\d+/.test(path)) {
    console.error("refused: pin an exact version, such as https://cdn.jsdelivr.net/npm/pkg@1.2.3/file.min.js");
    process.exit(1);
  }
} else if (host === "unpkg.com") {
  if (!/@\d+\.\d+\.\d+/.test(path)) {
    console.error("refused: pin an exact version, such as https://unpkg.com/pkg@1.2.3/file.min.js");
    process.exit(1);
  }
} else {
  console.error("refused: only cdn.jsdelivr.net/npm/ and unpkg.com");
  process.exit(1);
}
const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`refused: status ${res.status}`);
  process.exit(1);
}
const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
if (type && type !== "application/javascript" && type !== "text/javascript" && !type.endsWith("+javascript") && !/ecmascript/.test(type)) {
  console.error(`refused: not JavaScript (content type '${type}')`);
  process.exit(1);
}
const code = await res.text();
if (Buffer.byteLength(code, "utf8") > 512 * 1024) {
  console.error("refused: larger than 512 KB");
  process.exit(1);
}
const name = (path.split("/").filter(Boolean).pop() ?? "library").replace(/\.min\.js$/, "").replace(/\.js$/, "");
const sha256 = createHash("sha256").update(code, "utf8").digest("hex");
console.log(JSON.stringify({ name, url, sha256, code }));
