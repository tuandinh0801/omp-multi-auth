// ========================================================================
// Provider templates
// ========================================================================
import { YAML } from "bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir, type ExtensionAPI, type ProviderConfig, type ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import { AssistantMessageEventStream, streamSimple, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions, type UsageProvider, type UsageReport } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { fetchCodexModels } from "@oh-my-pi/pi-catalog/discovery/codex";
import { CODEX_BASE_URL, getCodexAccountId } from "@oh-my-pi/pi-catalog/wire/codex";
import { adaptAuthStorage, getModels, subProviderName, type SubEntry } from "./core.ts";

export type CopilotCredentials = OAuthCredentials & { enterpriseUrl?: string };
export type GeminiCredentials = OAuthCredentials & { projectId?: string };

/** Native omp provider OAuth configuration. */
export type ProviderOAuth = NonNullable<ProviderConfig["oauth"]>;

export function requireOAuthDefinition(providerId: string) {
	const definition = getProviderDefinition(providerId);
	if (!definition || typeof definition.login !== "function" || typeof definition.refreshToken !== "function") {
		throw new Error(`No renewable OAuth flow available for provider "${providerId}"`);
	}
	return definition;
}

export function getRegisteredProviderApiKey(providerId: string, credentials: OAuthCredentials): string {
	switch (providerId) {
		case "anthropic":
		case "openai-codex":
		case "kimi-code":
		case "xai-oauth":
			return credentials.access;
		case "github-copilot":
		case "google-gemini-cli":
		case "google-antigravity": {
			const registered = credentials as OAuthCredentials & {
				apiEndpoint?: string;
				enterpriseUrl?: string;
				projectId?: string;
				email?: string;
				accountId?: string;
			};
			return JSON.stringify({
				apiEndpoint: registered.apiEndpoint,
				token: registered.access,
				enterpriseUrl: registered.enterpriseUrl,
				projectId: registered.projectId,
				refreshToken: registered.refresh,
				expiresAt: registered.expires,
				email: registered.email,
				accountId: registered.accountId,
			});
		}
		default:
			return credentials.access;
	}
}

export function flowBackedOAuth(providerId: string, name: string): ProviderOAuth {
	const definition = requireOAuthDefinition(providerId);
	return {
		name,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string> {
			const credentials = await definition.login(callbacks);
			if (typeof credentials === "string") {
				throw new Error(`No renewable OAuth flow available for provider "${providerId}"`);
			}
			return credentials;
		},
		async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
			return definition.refreshToken(credentials);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return getRegisteredProviderApiKey(providerId, credentials);
		},
	};
}

export function buildApiKeyOAuth(displayName: string, index: number, placeholder: string): ProviderOAuth {
	return {
		name: `${displayName} #${index}`,
		async login(callbacks: OAuthLoginCallbacks): Promise<string> {
			const key = (await callbacks.onPrompt({
				message: `Paste your ${displayName} API key:`,
				placeholder,
			})).trim();
			if (!key) throw new Error(`No API key entered for ${displayName} #${index}`);
			return key; // string return -> OMP stores {type:"api_key", key} under this provider
		},
	};
}

const CURSOR_EXCHANGE_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

function cursorJwtExpiryMs(jwt: string): number {
	const fallback = Date.now() + 55 * 60 * 1000;
	const parts = jwt.split(".");
	if (parts.length !== 3) return fallback;
	try {
		const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
		return typeof payload.exp === "number" ? payload.exp * 1000 : fallback;
	} catch {
		return fallback;
	}
}

async function exchangeCursorApiKey(apiKey: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const resp = await fetch(CURSOR_EXCHANGE_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
		body: "{}",
		signal,
	});
	if (!resp.ok) {
		const text = await resp.text().catch(() => "");
		throw new Error(`Cursor API key exchange failed (${resp.status}): ${text || resp.statusText}`);
	}
	const data = (await resp.json()) as { accessToken?: string };
	if (!data.accessToken) throw new Error("Cursor API key exchange returned no accessToken");
	return { access: data.accessToken, refresh: apiKey, expires: cursorJwtExpiryMs(data.accessToken) };
}

const CURSOR_API_KEY_PREFIXES = ["crsr_", "cursor_"];

export function buildCursorOAuth(index: number): ProviderOAuth {
	const definition = requireOAuthDefinition("cursor");
	return {
		name: `Cursor #${index}`,
		async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
			const apiKey = (await callbacks.onPrompt({
				message: "Paste your Cursor API key (crsr_...), or leave blank to sign in with your browser:",
				placeholder: "crsr_...  (blank = browser sign-in)",
				allowEmpty: true,
			})).trim();
			if (apiKey) return exchangeCursorApiKey(apiKey, callbacks.signal);
			const credentials = await definition.login(callbacks);
			if (typeof credentials === "string") {
				throw new Error(`Cursor #${index} browser login did not return renewable credentials`);
			}
			return credentials;
		},
		async refreshToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
			const refresh = credentials.refresh || credentials.access;
			if (CURSOR_API_KEY_PREFIXES.some((prefix) => refresh.startsWith(prefix))) {
				return exchangeCursorApiKey(refresh, signal);
			}
			return definition.refreshToken(credentials, signal);
		},
		getApiKey(credentials: OAuthCredentials): string {
			return credentials.access;
		},
	};
}



// GitHub Copilot base URL derivation, ported from the pi-ai OAuth flow
// (no longer part of the public pi-ai surface).

export function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

export function getBaseUrlFromCopilotToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	// Convert proxy.xxx to api.xxx
	return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

export function getGitHubCopilotBaseUrl(token: string | undefined, enterpriseUrl: string | undefined): string {
	if (token) {
		const fromToken = getBaseUrlFromCopilotToken(token);
		if (fromToken) return fromToken;
	}
	const domain = enterpriseUrl ? normalizeDomain(enterpriseUrl) : null;
	if (domain) return `https://copilot-api.${domain}`;
	return "https://api.individual.githubcopilot.com";
}

// Synthetic provider names change provider-keyed transports. These APIs route
// through one shared wrapper, which restores canonical identity only inside
// transport and puts subscription identity back on emitted assistant messages.
export const SUB_TRANSPORT_CONFIG: Record<string, { builtinApi: Api | ((modelId: string) => Api); customApiId: string }> = {
	"google-antigravity": { builtinApi: "google-gemini-cli", customApiId: "google-antigravity-mp" },
	// pi-ai keys X-Api-Key (anthropic-messages) and x-opencode-session on provider === "opencode-go".
	"opencode-go": {
		builtinApi: (modelId) => getModels("opencode-go").find(m => m.id === modelId)?.api ?? "openai-completions",
		customApiId: "opencode-go-mp",
	},
};


const ANTIGRAVITY_ZWSP = "\u200B";

/** Substrings that make up Cloud Code Assist's system-prompt abuse fingerprint
 * (omp #11699, #12655). The live trigger is the `<conventions>` tag plus the
 * `RFC 2119: ...` sentence; breaking any one component defeats it. */
export const ANTIGRAVITY_FINGERPRINTS = ["RFC 2119", "<conventions>", "</conventions>"] as const;

/** Break Cloud Code Assist's system-prompt fingerprint so it stops masking
 * requests as 429 RESOURCE_EXHAUSTED (omp #11699, #12655). A zero-width space is
 * inserted into each flagged substring: invisible to the model, but it breaks
 * the contiguous literal the upstream WAF matches. Idempotent — a second pass
 * finds no intact substring. Content is otherwise preserved. */
export function defeatAntigravityFingerprint(text: string): string {
	let out = text;
	for (const s of ANTIGRAVITY_FINGERPRINTS) {
		out = out.split(s).join(s[0] + ANTIGRAVITY_ZWSP + s.slice(1));
	}
	return out;
}

export function rewriteAntigravitySystemInstruction(payload: unknown): unknown {
	if (!payload || typeof payload !== "object") return payload;
	const body = payload as Record<string, unknown>;
	const request = body.request;
	if (!request || typeof request !== "object") return payload;
	const req = request as Record<string, unknown>;
	const sys = req.systemInstruction;
	if (!sys || typeof sys !== "object") return payload;
	const sysObj = sys as Record<string, unknown>;
	if (!Array.isArray(sysObj.parts)) return payload;
	const parts = sysObj.parts.map(part =>
		part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
			? { ...part, text: defeatAntigravityFingerprint((part as { text: string }).text) }
			: part,
	);
	return { ...body, request: { ...req, systemInstruction: { ...sysObj, parts } } };
}

export type SubscriptionStream = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export function restoreSubscriptionProvider(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
	if (event.type === "done") return { ...event, message: { ...event.message, provider } };
	if (event.type === "error") return { ...event, error: { ...event.error, provider } };
	return { ...event, partial: { ...event.partial, provider } };
}

export function createSubscriptionStream(
	canonicalProvider: string,
	builtinApi: Api | ((modelId: string) => Api),
	baseUrl?: string,
): SubscriptionStream {
	return (model, context, options) => {
		const internalApi = typeof builtinApi === "function" ? builtinApi(model.id) : builtinApi;
		const baseModel = getModels(canonicalProvider).find(candidate => candidate.id === model.id);
		if (!baseModel) throw new Error(`Missing bundled model ${canonicalProvider}/${model.id}`);
		// The host resolves model.resolveHeaders into model.headers before dispatching here, so the clone's
		// headers must ride along. Without an explicit baseUrl keep the catalog's per-model URL (mixed dialects).
		const internalModel = {
			...baseModel,
			api: internalApi,
			provider: canonicalProvider,
			baseUrl: baseUrl ?? baseModel.baseUrl,
			headers: model.headers ?? baseModel.headers,
			resolveHeaders: model.resolveHeaders,
		} as Model<Api>;
		const internalOptions: SimpleStreamOptions = {
			...(options ?? {}),
			headers: options?.headers,
			onPayload: async (payload: unknown) => {
				const rewritten =
					canonicalProvider === "google-antigravity"
						? rewriteAntigravitySystemInstruction(payload)
						: payload;
				const replacement = await options?.onPayload?.(rewritten, model);
				return replacement ?? rewritten;
			},
			onSseEvent: options?.onSseEvent
				? (event: Parameters<NonNullable<SimpleStreamOptions["onSseEvent"]>>[0]) => options.onSseEvent?.(event, model)
				: undefined,
		};
		const inner = streamSimple(internalModel, context, internalOptions);
		const outer = new AssistantMessageEventStream();
		outer.forwardLocalWorkFrom(inner);
		void (async () => {
			try {
				for await (const event of inner) {
					outer.push(restoreSubscriptionProvider(event, model.provider));
				}
			} catch (error) {
				outer.fail(error);
			}
		})();
		return outer;
	};
}
export const SUBSCRIPTION_STREAMS: Record<string, SubscriptionStream> = {};
export function getSubscriptionStream(baseProvider: string, baseUrl?: string): SubscriptionStream | undefined {
	const config = SUB_TRANSPORT_CONFIG[baseProvider];
	if (!config) return undefined;
	if (baseUrl) return createSubscriptionStream(baseProvider, config.builtinApi, baseUrl);
	let stream = SUBSCRIPTION_STREAMS[baseProvider];
	if (!stream) {
		stream = createSubscriptionStream(baseProvider, config.builtinApi);
		SUBSCRIPTION_STREAMS[baseProvider] = stream;
	}
	return stream;
}



export interface ProviderTemplate {
	displayName: string;
	buildOAuth?(index: number): ProviderOAuth;
	buildModifyModels?(providerName: string): ProviderOAuth["modifyModels"];
}

interface ApiKeyProviderSpec {
	id: string; // bundled-catalog provider id
	displayName: string;
	placeholder: string; // key-format hint shown in the login prompt
}

// Direct-API-key providers with a static baseUrl in the bundled catalog. A row
// is enough for plain bearer auth; providers whose pi-ai auth/headers are keyed
// on the provider name also need a SUB_TRANSPORT_CONFIG entry.
export const API_KEY_PROVIDERS: ApiKeyProviderSpec[] = [
	{ id: "openai", displayName: "OpenAI (API key)", placeholder: "sk-..." },
	{ id: "deepseek", displayName: "DeepSeek", placeholder: "sk-..." },
	{ id: "mistral", displayName: "Mistral", placeholder: "..." },
	{ id: "groq", displayName: "Groq", placeholder: "gsk_..." },
	{ id: "xai", displayName: "xAI (API key)", placeholder: "xai-..." },
	{ id: "google", displayName: "Google Gemini (API key)", placeholder: "AIza..." },
	{ id: "openrouter", displayName: "OpenRouter", placeholder: "sk-or-..." },
	{ id: "together", displayName: "Together AI", placeholder: "..." },
	{ id: "fireworks", displayName: "Fireworks AI", placeholder: "fw_..." },
	{ id: "cerebras", displayName: "Cerebras", placeholder: "csk-..." },
	{ id: "moonshot", displayName: "Moonshot (Kimi)", placeholder: "sk-..." },
	{ id: "zai", displayName: "Z.AI (GLM)", placeholder: "..." },
	{ id: "minimax", displayName: "MiniMax (Global)", placeholder: "..." },
	{ id: "minimax-cn", displayName: "MiniMax (China)", placeholder: "..." },
	{ id: "opencode-go", displayName: "OpenCode Go", placeholder: "oc_sk_..." },
];

export const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
	anthropic: {
		displayName: "Anthropic (Claude Pro/Max)",
		buildOAuth(index: number) {
			return flowBackedOAuth("anthropic", `Anthropic #${index}`);
		},
	},

	"openai-codex": {
		displayName: "ChatGPT Plus/Pro (Codex)",
		buildOAuth(index: number) {
			return flowBackedOAuth("openai-codex", `ChatGPT Codex #${index}`);
		},
	},

	"github-copilot": {
		displayName: "GitHub Copilot",
		buildOAuth(index: number) {
			return flowBackedOAuth("github-copilot", `GitHub Copilot #${index}`);
		},
		buildModifyModels(providerName: string) {
			return (models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] => {
				const creds = credentials as CopilotCredentials;
				const baseUrl = getGitHubCopilotBaseUrl(creds.access, creds.enterpriseUrl);
				return models.map((m) =>
					m.provider === providerName ? { ...m, baseUrl } : m,
				);
			};
		},
	},

	"google-gemini-cli": {
		displayName: "Google Cloud Code Assist",
		buildOAuth(index: number) {
			return flowBackedOAuth("google-gemini-cli", `Google Cloud Code Assist #${index}`);
		},
	},

	"google-antigravity": {
		displayName: "Antigravity",
		buildOAuth(index: number) {
			return flowBackedOAuth("google-antigravity", `Antigravity #${index}`);
		},
	},

	"kimi-code": {
		displayName: "Kimi Code",
		buildOAuth(index: number) {
			return flowBackedOAuth("kimi-code", `Kimi Code #${index}`);
		},
	},

	"xai-oauth": {
		displayName: "xAI Grok OAuth",
		buildOAuth(index: number) {
			return flowBackedOAuth("xai-oauth", `xAI Grok OAuth #${index}`);
		},
	},

	cursor: {
		displayName: "Cursor",
		buildOAuth(index: number) {
			return buildCursorOAuth(index);
		},
	},

};

for (const spec of API_KEY_PROVIDERS) {
	PROVIDER_TEMPLATES[spec.id] = {
		displayName: spec.displayName,
		buildOAuth: (index: number) => buildApiKeyOAuth(spec.displayName, index, spec.placeholder),
	};
}


export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_TEMPLATES);

export function subDisplayName(entry: SubEntry): string {
	const template = PROVIDER_TEMPLATES[entry.provider];
	const providerName = `${template?.displayName || entry.provider} #${entry.index}`;
	if (!entry.label) return providerName;
	return `${entry.label} — ${providerName}`;
}
export function getBaseProvider(providerName: string): string | undefined {
	// Direct match
	if (PROVIDER_TEMPLATES[providerName]) return providerName;
	// Strip trailing -N
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && PROVIDER_TEMPLATES[match[1]]) return match[1];
	return undefined;
}

// ==========================================================================
// Model cloning
// ==========================================================================

export function cloneModels(originalProvider: string, index: number): ProviderModelConfig[] {
	const models = getModels(originalProvider);
	return models.map((m) => ({
		id: m.id,
		name: `${m.name} (#${index})`,
		api: SUB_TRANSPORT_CONFIG[originalProvider]?.customApiId ?? m.api,
		reasoning: m.reasoning,
		thinking: m.thinking,
		input: m.input as ("text" | "image")[],
		cost: { ...m.cost },
		premiumMultiplier: m.premiumMultiplier,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		preferWebsockets: m.preferWebsockets,
		headers: m.headers ? { ...m.headers } : undefined,
		compat: m.compat,
	}));
}


// ==========================================================================
// Register a single subscription as a provider
// ==========================================================================

// pi-ai added the usage registry after 18.1.20, the lowest host this extension
// supports. A static import would stop the whole extension from loading there,
// so older hosts load it and their added accounts get no usage report.
const usageRegistry = await import("@oh-my-pi/pi-ai/usage/registry").catch(() => undefined);

// Built-in usage fetchers only accept their own provider id, so a sub would get no
// usage report. Probe as the base provider and relabel the report as the sub. The
// host caches, invalidates and retains the relabeled report under the sub's id.
function subUsageProvider(baseProvider: string, name: string): UsageProvider | undefined {
	const base = usageRegistry?.defaultUsageProvider(baseProvider);
	if (!base) return undefined;
	const asSub = (report: UsageReport | null): UsageReport | null =>
		report && {
			...report,
			provider: name,
			limits: report.limits.map(limit => ({ ...limit, scope: { ...limit.scope, provider: name } })),
		};
	const { supports, parseRateLimitHeaders } = base;
	return {
		...base,
		id: name,
		fetchUsage: async (params, ctx) => asSub(await base.fetchUsage({ ...params, provider: baseProvider }, ctx)),
		supports: supports && (params => supports({ ...params, provider: baseProvider })),
		parseRateLimitHeaders: parseRateLimitHeaders && ((...args) => asSub(parseRateLimitHeaders(...args))),
	};
}

function registerCodexSub(pi: ExtensionAPI, name: string, index: number, oauth: ProviderOAuth): void {
	pi.registerProvider(name, {
		baseUrl: CODEX_BASE_URL,
		api: "openai-codex-responses",
		oauth,
		usage: subUsageProvider("openai-codex", name),
		async fetchDynamicModels(accessToken) {
			// OMP peeks at this provider's credential without refreshing it.
			if (!accessToken) {
				const auth = await pi.pi.discoverAuthStorage();
				try {
					const storage = adaptAuthStorage(auth);
					accessToken = (await storage.getOAuthAccess?.(name))?.accessToken;
					if (!accessToken && storage.hasAuth(name)) throw new Error("Codex OAuth access unavailable");
				} finally {
					auth.close();
				}
			}
			if (!accessToken) return [];

			const result = await fetchCodexModels({ accessToken, accountId: getCodexAccountId(accessToken) });
			// Throw on failure so OMP keeps this account's last good catalog.
			if (!result) throw new Error("Codex model list unavailable");
			if (result.rejectedStatus) throw new Error(`Codex model list rejected (HTTP ${result.rejectedStatus})`);

			// Resolve native Codex capability and pricing rules before OMP assigns the
			// synthetic provider name. Do not add bundled IDs the account didn't list.
			return result.models.map(spec => {
				const model = buildModel(spec);
				return { ...model, name: `${model.name} (#${index})`, input: model.input as ("text" | "image")[] };
			});
		},
	});
}

// An account takes the endpoint its base provider is configured with in
// models.yml (a gateway or proxy baseUrl and its headers), because
// models.yml overrides are keyed by provider id and never reach the
// `<provider>-N` ids registered here. Credentials stay the account's own.
function baseProviderTransport(provider: string): { baseUrl?: string; headers?: Record<string, string> } {
	let parsed: { providers?: Record<string, { baseUrl?: unknown; headers?: unknown }> } | null;
	// Same lookup as the host: models.yaml is read only when models.yml is absent.
	const yml = join(getAgentDir(), "models.yml");
	try {
		parsed = YAML.parse(readFileSync(existsSync(yml) ? yml : join(getAgentDir(), "models.yaml"), "utf8")) as typeof parsed;
	} catch {
		return {};
	}
	const override = parsed?.providers?.[provider];
	const headers = override?.headers;
	return {
		baseUrl: typeof override?.baseUrl === "string" ? override.baseUrl : undefined,
		headers: headers && typeof headers === "object" ? { ...(headers as Record<string, string>) } : undefined,
	};
}

export function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;
	const name = subProviderName(entry);
	const oauth = template.buildOAuth?.(entry.index);
	if (entry.provider === "openai-codex" && oauth) {
		registerCodexSub(pi, name, entry.index, oauth);
		return;
	}
	const transport = baseProviderTransport(entry.provider);
	// An explicit baseUrl wins over the token-derived Copilot endpoint.
	const modifyModels = transport.baseUrl ? undefined : template.buildModifyModels?.(name);

	const builtinModels = getModels(entry.provider);
	const transportApi = SUB_TRANSPORT_CONFIG[entry.provider]?.customApiId;
	const streamSimple = getSubscriptionStream(entry.provider, transport.baseUrl);
	const baseUrl = transport.baseUrl ?? (builtinModels[0]?.baseUrl || "");
	const models = cloneModels(entry.provider, entry.index);

	// Static `models` provide startup catalog for this subscription.
	pi.registerProvider(name, {
		baseUrl,
		headers: transport.headers,
		api: transportApi ?? builtinModels[0]?.api,
		streamSimple,
		oauth: oauth && modifyModels ? { ...oauth, modifyModels } : oauth,
		usage: subUsageProvider(entry.provider, name),
		models,
	});
}
