import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "omp-multi-auth-omp-auth-"));
const ompArgs = [
	"--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules",
	"--no-lsp", "--no-session", "--extension", join(root, "extensions", "multi-auth.ts"),
];

try {
	writeFileSync(
		join(agentDir, "multi-auth.json"),
		JSON.stringify({
			subscriptions: [
				{ provider: "kimi-code", index: 2 },
				{ provider: "kimi-code", index: 3 },
			],
			presets: [],
		}),
	);

	const bootstrap = spawnSync(
		"omp",
		["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-session"],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"bootstrap","type":"get_available_models"}\n',
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			timeout: 30_000,
		},
	);
	assert.equal(bootstrap.error, undefined, bootstrap.error?.message);
	assert.equal(bootstrap.status, 0, bootstrap.stderr);

	const db = new DatabaseSync(join(agentDir, "agent.db"));
	const insert = db.prepare(
		"INSERT INTO auth_credentials (provider, credential_type, data, identity_key) VALUES (?, ?, ?, ?)",
	);
	const expires = Date.now() + 60 * 60 * 1000;
	for (const provider of ["kimi-code-2", "kimi-code-3"]) {
		insert.run(
			provider,
			"oauth",
			JSON.stringify({ access: `test-access-${provider}`, refresh: `test-refresh-${provider}`, expires }),
			null,
		);
	}
	db.close();

	const stdout = [];
	const stderr = [];
	const child = spawn(
		"omp",
		ompArgs,
		{ cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, timeout: 30_000 },
	);
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
	const modelResponse = await send({ id: "models", type: "get_available_models" });
	const promptResponse = await send({ id: "auth-compat", type: "prompt", message: "/multi-auth status" });
	child.stdin.end();
	const exitCode = await new Promise((resolve) => child.once("close", resolve));
	const rawStdout = stdout.join("\n");
	const rawStderr = Buffer.concat(stderr).toString();

	assert.equal(exitCode, 0, rawStderr);
	assert.doesNotMatch(rawStdout, /"type":"extension_error"/, rawStdout);
	assert.equal(promptResponse.command, "prompt");
	assert.equal(promptResponse.success, true);
	assert.equal(modelResponse.command, "get_available_models");
	assert.equal(modelResponse.success, true);
	const commandUpdate = events.find((event) => event.type === "available_commands_update");
	assert.ok(commandUpdate?.commands?.some((command) => command.name === "multi-auth"), rawStdout);

	const models = modelResponse.data.models;
	const kimi2Models = models.filter((model) => model.provider === "kimi-code-2");
	const kimi3Models = models.filter((model) => model.provider === "kimi-code-3");
	assert.ok(kimi2Models.length > 0, "missing models for kimi-code-2");
	assert.ok(kimi3Models.length > 0, "missing models for kimi-code-3");
	assert.ok(kimi2Models.some((model) => model.id === "kimi-for-coding" || model.id === "k3"), "missing Kimi model for kimi-code-2");
	assert.ok(kimi3Models.some((model) => model.id === "kimi-for-coding" || model.id === "k3"), "missing Kimi model for kimi-code-3");
	console.log("prompt success: auth-compat");
	console.log(`kimi-code-2 models present: ${kimi2Models.map((model) => model.id).join(", ")}`);
	console.log(`kimi-code-3 models present: ${kimi3Models.map((model) => model.id).join(", ")}`);
	console.log("omp auth compatibility check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
