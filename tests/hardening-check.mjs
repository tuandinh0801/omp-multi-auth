import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-hardening-"));
const configPath = join(agentDir, "multi-auth.json");

writeFileSync(configPath, "{ malformed", "utf8");

try {
	const result = spawnSync(
		"omp",
		[
			"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session",
			"--extension", join(root, "extensions", "multi-auth.ts"),
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: `${JSON.stringify({ id: "status", type: "prompt", message: "/multi-auth status" })}\n`,
			encoding: "utf8",
			timeout: 15_000,
		},
	);
	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);

	const backup = readdirSync(agentDir).find((name) => name.endsWith(".bak"));
	assert.ok(backup, "malformed config backup missing");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		subscriptions: [],
		presets: [],
	});
	console.log("hardening checks passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
