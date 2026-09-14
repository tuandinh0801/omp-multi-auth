import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadGlobalConfig, parseEnvConfig, mergeConfigs, normalizeEntries, loadEffectiveConfig, formatAllowedProviderSummary, getProjectScopedProviderNames, findSelectableModelForProvider, getProviderDisplayName } from "./lib/config.ts";
import { registerSub, rewriteAntigravitySystemInstruction } from "./lib/providers.ts";
import { handleSubsMenu, handleSubsList, handleSubsAdd, handleSubsRemove, handleSubsLogin, handleSubsLogout, handleSubsSwitch, handleSubsStatus } from "./lib/commands-subs.ts";
import { handleSubsLimits, refreshQuotaStatusLine, invalidateStatusQuota } from "./lib/quota.ts";
import { handlePresetActivate, handlePresetCreate, handlePresetList, handlePresetToggle, handlePresetRemove, handlePresetMenu } from "./lib/commands-preset.ts";

// ========================================================================
// Extension entry point
// ========================================================================

export default function multiSub(pi: ExtensionAPI) {

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	// Register all subscriptions (always global)
	for (const entry of all) {
		registerSub(pi, entry);
	}

	// Apply same tag-only fingerprint workaround at OMP payload seam.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider === "google-antigravity") {
			return rewriteAntigravitySystemInstruction(event.payload);
		}
	});

	let projectRestrictionSwitchInFlight = false;
	const enforceProjectRestriction = async (
		ctx: ExtensionContext | ExtensionCommandContext,
		reason: "session" | "model" | "input",
	): Promise<boolean> => {
		if (projectRestrictionSwitchInFlight) return true;
		const effective = loadEffectiveConfig(ctx.cwd);
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (!allowedSummary) {
			return true;
		}
		if (ctx.model && effective.allowedProviderNames?.includes(ctx.model.provider)) {
			return true;
		}

		for (const providerName of getProjectScopedProviderNames(ctx, effective)) {
			const model = findSelectableModelForProvider(ctx, providerName, ctx.model?.id);
			if (!model) continue;

			projectRestrictionSwitchInFlight = true;
			try {
				const success = await pi.setModel(model);
				if (!success) continue;
				const displayName = getProviderDisplayName(providerName, effective.subscriptions);
				ctx.ui.notify(
					`multi-auth: project restricted to ${allowedSummary}; switched to ${displayName} (${model.id}).`,
					"info",
				);
				return true;
			} finally {
				projectRestrictionSwitchInFlight = false;
			}
		}

		const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the current model";
		ctx.ui.notify(
			`multi-auth: project restricted to ${allowedSummary}, but no authenticated allowed provider can serve ${currentModel}.`,
			"warning",
		);
		return false;
	};

	// On session start, apply project restriction and show allowed providers.
	pi.on("session_start", async (_event, ctx) => {
		const effective = loadEffectiveConfig(ctx.cwd);
		const allowedSummary = formatAllowedProviderSummary(effective);
		if (allowedSummary) {
			ctx.ui.setStatus("multi-auth", `allowed ${allowedSummary}`);
		}

		refreshQuotaStatusLine(ctx);
		if ("setInterval" in ctx && typeof ctx.setInterval === "function") {
			ctx.setInterval(() => refreshQuotaStatusLine(ctx), 60_000);
		}

		await enforceProjectRestriction(ctx, "session");
	});

	pi.on("model_select", async (_event, ctx) => {
		await enforceProjectRestriction(ctx, "model");
	});

	pi.on("input", async (event, ctx) => {
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" as const };
		}
		const ok = await enforceProjectRestriction(ctx, "input");
		if (ok) {
			refreshQuotaStatusLine(ctx);
		}
		return ok ? { action: "continue" as const } : { action: "handled" as const };
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.model) {
			invalidateStatusQuota(ctx.model.provider);
		}
		refreshQuotaStatusLine(ctx);
	});
	// Register /multi-auth command
	pi.registerCommand("multi-auth", {
		description: "Manage multi-account OAuth subscriptions and accounts",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["list", "add", "remove", "login", "logout", "switch", "status", "limits"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((s) => ({ value: s, label: s }))
				: null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const config = loadGlobalConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "list":
				case "ls":
					return handleSubsList(pi, ctx, config);
				case "add":
				case "new":
					return handleSubsAdd(pi, ctx);
				case "remove":
				case "rm":
				case "delete":
					return handleSubsRemove(pi, ctx);
				case "login":
					return handleSubsLogin(ctx);
				case "logout":
					return handleSubsLogout(ctx);
				case "switch":
					return handleSubsSwitch(pi, ctx, rest || undefined);
				case "status":
				case "info":
					return handleSubsStatus(ctx);
				case "limits":
				case "quota":
				case "usage":
					return handleSubsLimits(ctx);
				default:
					return handleSubsMenu(pi, ctx);
			}
		},
	});

	// Register /multi-auth-preset command
	pi.registerCommand("multi-auth-preset", {
		description: "Manage model presets across providers",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = ["activate", "create", "list", "toggle", "remove"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			if (filtered.length > 0) {
				return filtered.map((s) => ({ value: s, label: s }));
			}
			const config = loadGlobalConfig();
			const presetNames = config.presets
				.filter((p) => p.enabled && p.name.startsWith(prefix))
				.map((p) => ({ value: p.name, label: p.name }));
			return presetNames.length > 0 ? presetNames : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] || "").toLowerCase();
			const rest = parts.slice(1).join(" ");
			switch (subcommand) {
				case "activate":
				case "use":
					return handlePresetActivate(pi, ctx, rest || undefined);
				case "create":
				case "new":
					return handlePresetCreate(ctx);
				case "list":
				case "ls":
					return handlePresetList(ctx);
				case "toggle":
					return handlePresetToggle(ctx);
				case "remove":
				case "rm":
				case "delete":
					return handlePresetRemove(ctx);
				default:
					if (subcommand) {
						const config = loadGlobalConfig();
						const preset = config.presets.find(
							(p) => p.name.toLowerCase() === subcommand && p.enabled,
						);
						if (preset) {
							return handlePresetActivate(pi, ctx, preset.name);
						}
					}
					return handlePresetMenu(pi, ctx);
			}
		},
	});
}
