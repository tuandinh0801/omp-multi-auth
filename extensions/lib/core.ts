// Cross-module types and zero-dependency helpers.
import type { ExtensionCommandContext, ExtensionContext, AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { getBundledModels, type GeneratedProvider } from "@oh-my-pi/pi-catalog";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { GoogleQuotaAccountSnapshot, CodexUsageSnapshot } from "./quota.ts";

export function getModels(providerId: string): Model<Api>[] {
	return getBundledModels(providerId as GeneratedProvider) as Model<Api>[];
}

export type QuotaStatusKind = "ready" | "watch" | "low" | "blocked" | "error" | "missing-auth";

export interface AuthStorageEntry {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	email?: string;
	projectId?: string;
	[key: string]: unknown;
}

export function getAuthStorage(ctx: ExtensionContext | ExtensionCommandContext): AuthStorage {
	return ctx.modelRegistry.authStorage;
}

export interface QuotaAccount {
	providerName: string;
	baseProvider: string;
	displayName: string;
	auth?: AuthStorageEntry;
}

export interface QuotaCheckResult {
	account: QuotaAccount;
	kind: QuotaStatusKind;
	summary: string;
	details: string[];
	score: number;
	googleSnapshot?: GoogleQuotaAccountSnapshot;
	codexSnapshot?: CodexUsageSnapshot;
}

export interface ProviderQuotaChecker {
	baseProvider: string;
	check(account: QuotaAccount, authStorage: AuthStorage, signal?: AbortSignal): Promise<QuotaCheckResult>;
}
export interface SubEntry {
	provider: string;
	index: number;
	label?: string;
}

/** A named routing preset that maps to an ordered list of provider+model entries. */
export interface PresetEntry {
	/** Provider name (e.g. "openai-codex", "anthropic-2") */
	provider: string;
	/** Model ID to use */
	model: string;
	/** Whether this entry is active */
	enabled: boolean;
}

export interface PresetConfig {
	/** Preset name (e.g. "coding-premium", "coding-budget") */
	name: string;
	/** Ordered provider+model entries to try */
	entries: PresetEntry[];
	/** Whether this preset is available */
	enabled: boolean;
}

export interface MultiAuthConfig {
	subscriptions: SubEntry[];
	presets: PresetConfig[];
}


/** Project-level config (.omp/multi-auth.json) */
export interface ProjectConfig {
	/** Restrict which provider names can be used in this project (for example
	 * "openai-codex" or "openai-codex-2"). If set, only these exact providers
	 * are available in this project. If not set, all global providers are available. */
	allowedSubs?: string[];
}

/** Effective config after merging global + project */
export interface EffectiveConfig {
	subscriptions: SubEntry[];
	presets: PresetConfig[];
	/** Exact provider names allowed in this project, if restricted. */
	allowedProviderNames?: string[];
}

export function subProviderName(entry: SubEntry): string {
	return `${entry.provider}-${entry.index}`;
}
