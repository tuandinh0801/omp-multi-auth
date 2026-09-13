// ========================================================================
// Provider templates
// ========================================================================
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth";
import { AssistantMessageEventStream, streamSimple, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { getModels, subProviderName, type SubEntry } from "./core.ts";

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
};


export const ANTIGRAVITY_SENSITIVE_TAGS = ["system-conventions", "system-directive"] as const;

/** Case-flip Google's fingerprinted system-prompt tags so Cloud Code Assist stops
 *  masking the request as 429 RESOURCE_EXHAUSTED (omp issue #11809). Content is
 *  preserved; only the exact-substring fingerprint is defeated. */
export function defeatAntigravityFingerprint(text: string): string {
	let out = text;
	for (const tag of ANTIGRAVITY_SENSITIVE_TAGS) {
		out = out
			.split(`<${tag}>`).join(`<${tag.toUpperCase()}>`)
			.split(`</${tag}>`).join(`</${tag.toUpperCase()}>`);
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

export function createSubscriptionStream(canonicalProvider: string, builtinApi: Api | ((modelId: string) => Api)): SubscriptionStream {
	return (model, context, options) => {
		const internalApi = typeof builtinApi === "function" ? builtinApi(model.id) : builtinApi;
		const baseModel = getModels(canonicalProvider).find(candidate => candidate.id === model.id);
		if (!baseModel) throw new Error(`Missing bundled model ${canonicalProvider}/${model.id}`);
		const internalModel = { ...baseModel, api: internalApi, provider: canonicalProvider } as Model<Api>;
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
export function getSubscriptionStream(baseProvider: string): SubscriptionStream | undefined {
	const config = SUB_TRANSPORT_CONFIG[baseProvider];
	if (!config) return undefined;
	let stream = SUBSCRIPTION_STREAMS[baseProvider];
	if (!stream) {
		stream = createSubscriptionStream(baseProvider, config.builtinApi);
		SUBSCRIPTION_STREAMS[baseProvider] = stream;
	}
	return stream;
}



export interface ProviderTemplate {
	displayName: string;
	apiKey?: string;
	buildOAuth?(index: number): ProviderOAuth;
	buildModifyModels?(providerName: string): ProviderOAuth["modifyModels"];
}

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

	minimax: {
		displayName: "MiniMax (Global)",
		apiKey: "$MINIMAX_API_KEY",
	},

	"minimax-cn": {
		displayName: "MiniMax (China)",
		apiKey: "$MINIMAX_CN_API_KEY",
	},
};

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

export function registerSub(pi: ExtensionAPI, entry: SubEntry): void {
	const template = PROVIDER_TEMPLATES[entry.provider];
	if (!template) return;
	const name = subProviderName(entry);
	const oauth = template.buildOAuth?.(entry.index);
	const modifyModels = template.buildModifyModels?.(name);

	const builtinModels = getModels(entry.provider);
	const transportApi = SUB_TRANSPORT_CONFIG[entry.provider]?.customApiId;
	const streamSimple = getSubscriptionStream(entry.provider);
	const baseUrl = builtinModels[0]?.baseUrl || "";
	const models = cloneModels(entry.provider, entry.index);

	// Static `models` provide startup catalog for this subscription.
	pi.registerProvider(name, {
		baseUrl,
		api: transportApi ?? builtinModels[0]?.api,
		apiKey: template.apiKey,
		streamSimple,
		oauth: oauth && modifyModels ? { ...oauth, modifyModels } : oauth,
		models,
	});
}
