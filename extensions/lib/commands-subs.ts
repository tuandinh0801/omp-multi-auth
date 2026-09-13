// ========================================================================
// /multi-auth command handlers
// ========================================================================
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getAuthStorage, getModels, subProviderName, type MultiAuthConfig, type SubEntry } from "./core.ts";
import { loadGlobalConfig, loadProjectConfig, saveGlobalConfig, parseEnvConfig, mergeConfigs, normalizeEntries, getSubscriptionSource, formatSubscriptionMeta, formatSubscriptionListLine, formatSubscriptionStatus } from "./config.ts";
import { PROVIDER_TEMPLATES, SUPPORTED_PROVIDERS, getBaseProvider, subDisplayName, registerSub } from "./providers.ts";
import { handleSubsLimits } from "./quota.ts";
import { showWrappedSelect } from "./ui.ts";
import type { SelectItem } from "@oh-my-pi/pi-tui";

export function normalizeSwitchAllowedProviderNames(cwd: string): string[] | undefined {
	const project = loadProjectConfig(cwd);
	if (!project?.allowedSubs || project.allowedSubs.length === 0) return undefined;
	const normalized = [...new Set(project.allowedSubs.map((value) => value.trim()).filter(Boolean))];
	return normalized.length > 0 ? normalized : undefined;
}

export function getSwitchableProviderOptions(
	ctx: ExtensionContext | ExtensionCommandContext,
): Array<{ providerName: string; label: string; description: string }> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allSubs = normalizeEntries(mergeConfigs(config, envEntries));
	const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
	const allowed = allowedProviderNames ? new Set(allowedProviderNames) : undefined;
	const options: Array<{ providerName: string; label: string; description: string }> = [];
	const seen = new Set<string>();
	const push = (providerName: string, label: string, description: string) => {
		if (allowed && !allowed.has(providerName)) return;
		if (!getAuthStorage(ctx).hasAuth(providerName)) return;
		if (seen.has(providerName)) return;
		seen.add(providerName);
		options.push({ providerName, label, description });
	};

	for (const providerName of SUPPORTED_PROVIDERS) {
		push(
			providerName,
			PROVIDER_TEMPLATES[providerName]?.displayName || providerName,
			"base provider",
		);
	}
	for (const entry of allSubs) {
		push(subProviderName(entry), subDisplayName(entry), "extra subscription");
	}
	return options;
}

export function resolveSwitchTargetModel(
	ctx: ExtensionContext | ExtensionCommandContext,
	providerName: string,
	preferredModelId?: string,
): Model<Api> | undefined {
	if (!getAuthStorage(ctx).hasAuth(providerName)) {
		return undefined;
	}
	if (preferredModelId) {
		const preferred = ctx.modelRegistry.find(providerName, preferredModelId);
		if (preferred) {
			return preferred as Model<Api>;
		}
	}
	const baseProvider = getBaseProvider(providerName);
	if (!baseProvider) {
		return undefined;
	}
	for (const baseModel of getModels(baseProvider as any) as Model<Api>[]) {
		const candidate = ctx.modelRegistry.find(providerName, baseModel.id);
		if (candidate) {
			return candidate as Model<Api>;
		}
	}
	return undefined;
}

export async function handleSubsSwitch(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	requestedProviderName?: string,
): Promise<void> {
	const options = getSwitchableProviderOptions(ctx);
	if (options.length === 0) {
		const allowedProviderNames = normalizeSwitchAllowedProviderNames(ctx.cwd);
		const suffix = allowedProviderNames && allowedProviderNames.length > 0
			? ` for this project restriction (${allowedProviderNames.join(", ")})`
			: "";
		ctx.ui.notify(`No authenticated subscriptions are available to switch${suffix}.`, "info");
		return;
	}

	let providerName = requestedProviderName?.trim();
	if (!providerName) {
		providerName = await showWrappedSelect(ctx, {
			title: "Switch Subscription",
			subtitle: "Select the subscription/provider to use now.",
			items: options.map((option) => ({
				value: option.providerName,
				label: option.label,
				description: option.description,
			})),
			initialValue: ctx.model?.provider,
			confirmHint: "switch",
			cancelHint: "back",
		});
		if (!providerName) return;
	}

	const selected = options.find((option) => option.providerName === providerName);
	if (!selected) {
		ctx.ui.notify(`Subscription not available for switching: ${providerName}`, "error");
		return;
	}

	const nextModel = resolveSwitchTargetModel(ctx, selected.providerName, ctx.model?.id);
	if (!nextModel) {
		ctx.ui.notify(`No selectable models found for ${selected.label}.`, "error");
		return;
	}
	if (ctx.model?.provider === nextModel.provider && ctx.model?.id === nextModel.id) {
		ctx.ui.notify(`Already using ${selected.label} (${nextModel.id}).`, "info");
		return;
	}

	const success = await pi.setModel(nextModel);
	if (!success) {
		ctx.ui.notify(`Failed to switch to ${selected.label}.`, "error");
		return;
	}
	ctx.ui.notify(`Switched to ${selected.label} (${nextModel.id}).`, "info");
}

export async function renameSubscriptionLabel(
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
): Promise<void> {
	const previousName = subDisplayName(entry);
	const nextLabel = await ctx.ui.input(
		"Friendly label (optional)",
		entry.label || "e.g. work, personal, team, outlook",
	);
	if (nextLabel === undefined) return;

	entry.label = nextLabel.trim() || undefined;
	saveGlobalConfig(config);

	const nextName = subDisplayName(entry);
	if (nextName === previousName) {
		ctx.ui.notify(`No changes for ${nextName}.`, "info");
		return;
	}

	ctx.ui.notify(`Updated ${previousName} -> ${nextName}`, "info");
}

export async function removeSubscriptionEntry(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
): Promise<void> {
	const confirmed = await ctx.ui.confirm(
		"Confirm removal",
		`Remove ${subDisplayName(entry)}?\nThis will also logout if authenticated.`,
	);
	if (!confirmed) return;

	const name = subProviderName(entry);
	if (getAuthStorage(ctx).hasAuth(name)) {
		await getAuthStorage(ctx).logout(name);
	}
	pi.unregisterProvider(name);

	config.subscriptions = config.subscriptions.filter(
		(candidate) => !(candidate.provider === entry.provider && candidate.index === entry.index),
	);

	saveGlobalConfig(config);
	ctx.modelRegistry.refresh();
	ctx.ui.notify(`Removed ${subDisplayName(entry)}`, "info");
}
export function loginSubscription(ctx: ExtensionCommandContext, entry: SubEntry): void {
	const providerName = subProviderName(entry);
	ctx.ui.setEditorText(`/login ${providerName}`);
	ctx.ui.notify(`Press Enter to authenticate ${subDisplayName(entry)} with /login ${providerName}.`, "info");
}
export async function showSubscriptionActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
	entry: SubEntry,
): Promise<void> {
	const source = getSubscriptionSource(config, entry);
	if (source === "env") {
		await showWrappedSelect(ctx, {
			title: `Subscription: ${subDisplayName(entry)}`,
			subtitle: "This entry comes from MULTI_SUB and is read-only here.",
			items: [
				{
					value: subProviderName(entry),
					label: formatSubscriptionListLine(entry, config, getAuthStorage(ctx)),
				},
			],
			confirmHint: "back",
			cancelHint: "back",
		});
		return;
	}

	const name = subProviderName(entry);
	const hasAuth = getAuthStorage(ctx).hasAuth(name);
	const actionItems: SelectItem[] = [
		{ value: "rename", label: "rename", description: "Change friendly label" },
		hasAuth
			? { value: "logout", label: "logout", description: "Log out this subscription" }
			: { value: "login", label: "login", description: "Show login instructions" },
		{ value: "remove", label: "remove", description: "Remove this subscription" },
	];

	const action = await showWrappedSelect(ctx, {
		title: subDisplayName(entry),
		subtitle: "Escape returns to the subscriptions list.",
		items: actionItems,
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!action) return;

	if (action === "rename") {
		return renameSubscriptionLabel(ctx, config, entry);
	}
	if (action === "login") {
		return loginSubscription(ctx, entry);
	}
	if (action === "logout") {
		await getAuthStorage(ctx).logout(name);
		ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
		return;
	}
	if (action === "remove") {
		return removeSubscriptionEntry(pi, ctx, config, entry);
	}
}

export async function handleSubsList(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: MultiAuthConfig,
): Promise<void> {
	let preferredProviderName: string | undefined = ctx.model?.provider;

	while (true) {
		const envEntries = parseEnvConfig();
		const all = normalizeEntries(mergeConfigs(config, envEntries));

		if (all.length === 0) {
			ctx.ui.notify("No extra subscriptions configured. Use /multi-auth add to create one.", "info");
			return;
		}

		const selectedProviderName = await showWrappedSelect(ctx, {
			title: "Extra Subscriptions",
			subtitle: "Select a subscription for quick actions.",
			items: all.map((entry) => ({
				value: subProviderName(entry),
				label: subDisplayName(entry),
				description: formatSubscriptionMeta(entry, config, getAuthStorage(ctx)),
			})),
			initialValue: preferredProviderName,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!selectedProviderName) return;

		preferredProviderName = selectedProviderName;
		const entry = all.find((candidate) => subProviderName(candidate) === selectedProviderName);
		if (!entry) continue;
		await showSubscriptionActions(pi, ctx, config, entry);
	}
}

export async function handleSubsAdd(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const providerItems: SelectItem[] = SUPPORTED_PROVIDERS.map((provider) => ({
		value: provider,
		label: provider,
		description: PROVIDER_TEMPLATES[provider]?.displayName,
	}));

	const provider = await showWrappedSelect(ctx, {
		title: "Select provider to add",
		items: providerItems,
		confirmHint: "select",
		cancelHint: "close",
	});
	if (!provider) return;

	if (!PROVIDER_TEMPLATES[provider]) {
		ctx.ui.notify(`Unknown provider: ${provider}`, "error");
		return;
	}

	const label = await ctx.ui.input("Label (optional)", "e.g. work, personal");

	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const allEntries = normalizeEntries(mergeConfigs(config, envEntries));
	const usedIndices = new Set(
		allEntries.filter((e) => e.provider === provider).map((e) => e.index),
	);
	let nextIndex = 2;
	while (usedIndices.has(nextIndex)) nextIndex++;

	const entry: SubEntry = {
		provider,
		index: nextIndex,
		label: label?.trim() || undefined,
	};

	config.subscriptions.push(entry);
	saveGlobalConfig(config);

	registerSub(pi, entry);
	ctx.modelRegistry.refresh();

	const loginNow = await ctx.ui.confirm(
		subDisplayName(entry),
		`Created ${subDisplayName(entry)}.\n\nLogin now?`,
	);

	if (loginNow) {
		await loginSubscription(ctx, entry);
	} else {
		ctx.ui.notify(`Added ${subDisplayName(entry)}. Use /multi-auth login to authenticate.`, "info");
	}
}

export async function handleSubsRemove(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const config = loadGlobalConfig();
	if (config.subscriptions.length === 0) {
		ctx.ui.notify("No saved subscriptions to remove.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Remove subscription",
		subtitle: "Select a saved subscription to remove.",
		initialValue: ctx.model?.provider,
		items: config.subscriptions.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: formatSubscriptionStatus(entry, getAuthStorage(ctx)),
		})),
		confirmHint: "remove",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = config.subscriptions.find(
		(candidate) => subProviderName(candidate) === selectedProviderName,
	);
	if (!entry) return;

	return removeSubscriptionEntry(pi, ctx, config, entry);
}

export async function handleSubsLogin(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const notLoggedIn = all.filter(
		(entry) => !getAuthStorage(ctx).hasAuth(subProviderName(entry)),
	);

	if (notLoggedIn.length === 0) {
		ctx.ui.notify(
			all.length === 0
				? "No subscriptions configured. Use /multi-auth add first."
				: "All subscriptions are already logged in.",
			"info",
		);
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Login to subscription",
		subtitle: "Select a subscription to authenticate.",
		initialValue: ctx.model?.provider,
		items: notLoggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: "not logged in",
		})),
		confirmHint: "open",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = notLoggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	return loginSubscription(ctx, entry);
}

export async function handleSubsLogout(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	const loggedIn = all.filter((entry) =>
		getAuthStorage(ctx).hasAuth(subProviderName(entry)),
	);

	if (loggedIn.length === 0) {
		ctx.ui.notify("No subscriptions are currently logged in.", "info");
		return;
	}

	const selectedProviderName = await showWrappedSelect(ctx, {
		title: "Logout from subscription",
		subtitle: "Select a subscription to log out.",
		initialValue: ctx.model?.provider,
		items: loggedIn.map((entry) => ({
			value: subProviderName(entry),
			label: subDisplayName(entry),
			description: formatSubscriptionStatus(entry, getAuthStorage(ctx)),
		})),
		confirmHint: "logout",
		cancelHint: "back",
	});
	if (!selectedProviderName) return;

	const entry = loggedIn.find((candidate) => subProviderName(candidate) === selectedProviderName);
	if (!entry) return;

	await getAuthStorage(ctx).logout(subProviderName(entry));
	ctx.ui.notify(`Logged out of ${subDisplayName(entry)}`, "info");
}

export async function handleSubsStatus(ctx: ExtensionCommandContext): Promise<void> {
	const config = loadGlobalConfig();
	const envEntries = parseEnvConfig();
	const all = normalizeEntries(mergeConfigs(config, envEntries));

	if (all.length === 0) {
		ctx.ui.notify("No extra subscriptions configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const entry of all) {
		const name = subProviderName(entry);
		const cred = getAuthStorage(ctx).get(name);
		const hasAuth = getAuthStorage(ctx).hasAuth(name);

		let status: string;
		if (!hasAuth) {
			status = "not logged in";
		} else if (cred?.type === "oauth") {
			const expiresIn = typeof cred.expires === "number" ? cred.expires - Date.now() : 0;
			if (expiresIn > 0) {
				const mins = Math.round(expiresIn / 60000);
				status = `logged in (expires ${mins}m)`;
			} else {
				status = "logged in (token expired, will refresh)";
			}
		} else {
			status = "logged in (api key)";
		}

		const modelCount = (getModels(entry.provider as any) as Model<Api>[]).length;
		const source = config.subscriptions.find(
			(s) => s.provider === entry.provider && s.index === entry.index,
		)
			? "saved"
			: "env";

		lines.push(
			`${subDisplayName(entry)} | ${status} | ${modelCount} models | ${source}`,
		);
	}

	await showWrappedSelect(ctx, {
		title: "Subscription Status",
		subtitle: "Press Enter or Escape to go back.",
		items: lines.map((line, index) => ({ value: `${index}:${line}`, label: line })),
		confirmHint: "back",
		cancelHint: "back",
	});
}
export async function handleSubsMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const actions: SelectItem[] = [
		{ value: "list", label: "list", description: "Show all extra subscriptions" },
		{ value: "add", label: "add", description: "Add a new subscription" },
		{ value: "remove", label: "remove", description: "Remove a subscription" },
		{ value: "login", label: "login", description: "Login to a subscription" },
		{ value: "logout", label: "logout", description: "Logout from a subscription" },
		{ value: "switch", label: "switch", description: "Switch to a different subscription/provider now" },
		{ value: "status", label: "status", description: "Show auth status and token info" },
		{ value: "limits", label: "limits", description: "Check built-in quota support (Codex + Google)" },
	];
	let preferredAction = "list";

	while (true) {
		const action = await showWrappedSelect(ctx, {
			title: "Subscription Manager",
			items: actions,
			initialValue: preferredAction,
			confirmHint: "open",
			cancelHint: "close",
		});
		if (!action) return;

		preferredAction = action;
		const config = loadGlobalConfig();
		switch (action) {
			case "list":
				await handleSubsList(pi, ctx, config);
				break;
			case "add":
				await handleSubsAdd(pi, ctx);
				break;
			case "remove":
				await handleSubsRemove(pi, ctx);
				break;
			case "login":
				await handleSubsLogin(ctx);
				break;
			case "logout":
				await handleSubsLogout(ctx);
				break;
			case "switch":
				await handleSubsSwitch(pi, ctx);
				break;
			case "status":
				await handleSubsStatus(ctx);
				break;
			case "limits":
				await handleSubsLimits(ctx);
				break;
		}
	}
}
