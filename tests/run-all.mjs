import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const includeHost = process.argv.includes("--host") || process.argv.includes("--all");

const testFiles = readdirSync(__dirname)
  .filter((file) => (file.endsWith("-check.mjs") || file.endsWith(".test.mjs")) && file !== "run-all.mjs")
  .sort();

if (testFiles.length === 0) {
  console.error("No test files found in tests/");
  process.exit(1);
}

let passed = 0;
let failed = 0;
let skipped = 0;

console.log(`Discovered ${testFiles.length} test suites...\n`);

for (const file of testFiles) {
  const fullPath = join(__dirname, file);
  const content = readFileSync(fullPath, "utf8");
  const requiresOmp = content.includes('"omp"');

  if (requiresOmp && !includeHost) {
    console.log(`⏭  ${file} (skipped: host test, pass --host to run)`);
    skipped++;
    continue;
  }

  console.log(`▶  ${file}`);
  const result = spawnSync(process.execPath, [fullPath], {
    stdio: "inherit",
    env: process.env,
  });

  if (result.status === 0) {
    passed++;
  } else {
    failed++;
    console.error(`✖  ${file} failed (exit code ${result.status})\n`);
  }
}

console.log(`\nTest summary: ${passed} passed, ${failed} failed, ${skipped} skipped (${testFiles.length} total)`);

if (failed > 0) {
  process.exit(1);
}
