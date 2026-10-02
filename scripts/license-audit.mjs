// Offline licence check over every installed package, at every depth. Fails when a licence is missing
// or not on the allow list. Reads node_modules, so run it after `npm ci`.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ALLOWED = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "Unlicense",
]);

// Exceptions checked by hand, by package name, each with the reason it is acceptable.
const LIGHTNINGCSS =
  "MPL-2.0, reached only through vite, the test runner's bundler. File-level copyleft that binds changes " +
  "to lightningcss itself; it never ships in a Weathervane artefact.";
const REVIEWED = new Map([["lightningcss", LIGHTNINGCSS]]);

function allowed(expression) {
  const text = expression.replace(/[()]/g, "").trim();
  return text
    .split(/\s+OR\s+/)
    .some((option) => option.split(/\s+AND\s+/).every((id) => ALLOWED.has(id.trim())));
}

function licenceOf(manifest) {
  if (typeof manifest.license === "string") return manifest.license;
  if (manifest.license && typeof manifest.license.type === "string") return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => l.type ?? l).join(" OR ");
  return null;
}

function* packages(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      yield* packages(path);
      continue;
    }
    const manifestPath = join(path, "package.json");
    if (existsSync(manifestPath)) yield manifestPath;
    yield* packages(join(path, "node_modules"));
  }
}

const failures = [];
const seen = new Set();
for (const manifestPath of packages("node_modules")) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.name || manifest.name.startsWith("@weathervane/")) continue;
  const id = `${manifest.name}@${manifest.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const licence = licenceOf(manifest);
  const reviewed = REVIEWED.get(manifest.name.replace(/-(darwin|linux|win32|freebsd|android).*$/, ""));
  if (reviewed !== undefined) {
    console.log(`reviewed by hand: ${id}: ${reviewed}`);
  } else if (licence === null || !allowed(licence)) {
    failures.push(`${id}: ${licence ?? "no licence field"}`);
  }
}

console.log(`${seen.size} packages checked`);
if (failures.length > 0) {
  console.error(`Licences not on the allow list:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
