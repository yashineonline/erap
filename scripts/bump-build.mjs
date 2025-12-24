import fs from "node:fs";
import path from "node:path";

const pkgPath = path.resolve("package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

const key = "appVersion";                 // <- stored in package.json
const cur = String(pkg[key] ?? "0.00").trim();

// store as integer “hundredths” to avoid float drift
let n = 0;
const m = cur.match(/^(\d+)\.(\d{2})$/);
if (m) n = parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
n += 1;

const next = `${Math.floor(n / 100)}.${String(n % 100).padStart(2, "0")}`;
const builtAt = new Date().toISOString();

pkg[key] = next;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

// write a TS module your app can import
const outDir = path.resolve("src/generated");
fs.mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, "buildInfo.ts");
fs.writeFileSync(
  outFile,
  `// AUTO-GENERATED on build. Do not edit.
export const APP_VERSION = ${JSON.stringify(next)} as const;
export const BUILD_DATE_ISO = ${JSON.stringify(builtAt)} as const;
`,
  "utf8"
);

console.log(`[build] ${key} -> ${next} @ ${builtAt}`);
