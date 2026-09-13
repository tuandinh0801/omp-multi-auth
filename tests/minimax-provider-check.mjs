import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-minimax-"));

try {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		"minimax-2": { type: "api_key", key: "test-global" },
		"minimax-cn-2": { type: "api_key", key: "test-china" },
	}));

	const child = spawn(
		"omp",
		[
			"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules",
			"--no-lsp", "--no-session", "--extension", join(root, "extensions", "multi-auth.ts"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				MULTI_SUB: "minimax:1,minimax-cn:1",
			},
			timeout: 30_000,
		},
	);
	const stdout = [];
	const stderr = [];
	child.stderr.on("data", (chunk) => stderr.push(chunk));
	const events = [];
	const waiters = [];
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		stdout.push(line);
		try {
			const event = JSON.parse(line);
			events.push(event);
			for (let i = waiters.length - 1; i >= 0; i--) {
				if (!waiters[i].matches(event)) continue;
				waiters.splice(i, 1)[0].resolve(event);
			}
		} catch {
			// Ignore non-JSON protocol noise or incomplete lines.
		}
	});
	const waitFor = (matches) => new Promise((resolve, reject) => waiters.push({ matches, resolve, reject }));
	const send = async (request) => {
		const response = waitFor((event) => event.id === request.id);
		child.stdin.write(`${JSON.stringify(request)}\n`);
		return response;
	};
	await send({ id: "select-minimax", type: "set_model", provider: "minimax-2", modelId: "MiniMax-M3" });
	const response = await send({ id: "models", type: "get_available_models" });
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("close", resolve));
	const rawStdout = stdout.join("\n");
	const rawStderr = Buffer.concat(stderr).toString();
	assert.equal(exitCode, 0, rawStderr);
	assert.doesNotMatch(rawStdout, /"type":"extension_error"/, rawStdout);
	assert.equal(response.command, "get_available_models");
	assert.equal(response.success, true);

	const models = response.data.models;
	for (const [provider, baseUrl] of [
		["minimax-2", "https://api.minimax.io/anthropic"],
		["minimax-cn-2", "https://api.minimaxi.com/anthropic"],
	]) {
		const providerModels = models.filter((model) => model.provider === provider);
		assert.ok(providerModels.length > 0, `missing models for ${provider}`);
		assert.ok(providerModels.every((model) => model.baseUrl === baseUrl));
		console.log(`${provider} models: ${providerModels.length}`);
	}
	console.log("MiniMax provider check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
