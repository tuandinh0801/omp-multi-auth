import assert from "node:assert/strict";

function subProviderName(entry) {
  return `${entry.provider}-${entry.index}`;
}

function normalizeEntries(entries) {
  const byProvider = new Map();
  for (const entry of entries) {
    if (!byProvider.has(entry.provider)) byProvider.set(entry.provider, []);
    byProvider.get(entry.provider).push(entry);
  }

  const normalized = [];
  for (const [provider, list] of byProvider.entries()) {
    const usedIndices = new Set(list.filter((e) => e.index > 0).map((e) => e.index));
    if (list.some((e) => e.index === 0)) {
      let nextIndex = 2;
      while (usedIndices.has(nextIndex)) nextIndex += 1;
      normalized.push({ provider, index: nextIndex });
      usedIndices.add(nextIndex);
    }
    for (const entry of list.filter((e) => e.index > 0).sort((a, b) => a.index - b.index)) {
      normalized.push(entry);
    }
  }
  return normalized;
}

function mergeConfigs(fileConfig, envEntries) {
  const merged = [...fileConfig.subscriptions];
  for (const envEntry of envEntries) {
    const existingCount = merged.filter((s) => s.provider === envEntry.provider).length;
    const envCountForProvider = envEntries.filter((e) => e.provider === envEntry.provider).length;
    if (existingCount < envCountForProvider) {
      const usedIndices = merged
        .filter((s) => s.provider === envEntry.provider)
        .map((s) => s.index);
      let nextIndex = 2;
      while (usedIndices.includes(nextIndex)) nextIndex += 1;
      merged.push({ provider: envEntry.provider, index: nextIndex });
    }
  }
  return merged;
}

function normalizeAllowedProviderNames(allowedSubs) {
  if (!allowedSubs || allowedSubs.length === 0) return undefined;
  const normalized = [...new Set(allowedSubs.map((value) => value.trim()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function buildEffectiveConfig(globalConfig, projectConfig, envEntries = []) {
  const mergedSubscriptions = normalizeEntries(mergeConfigs(globalConfig, envEntries));
  const allowedProviderNames = normalizeAllowedProviderNames(projectConfig?.allowedSubs);
  let subscriptions = mergedSubscriptions;
  if (allowedProviderNames) {
    const allowed = new Set(allowedProviderNames);
    subscriptions = mergedSubscriptions.filter((entry) => allowed.has(subProviderName(entry)));
  }
  return { subscriptions, allowedProviderNames };
}

function runExactProviderRestrictionCheck() {
  const globalConfig = {
    subscriptions: [{ provider: "openai-codex", index: 2, label: "mw" }],
  };

  const effective = buildEffectiveConfig(globalConfig, { allowedSubs: ["openai-codex-2"] });

  assert.deepEqual(effective.allowedProviderNames, ["openai-codex-2"]);
  assert.deepEqual(effective.subscriptions.map(subProviderName), ["openai-codex-2"]);
}

function runBaseProviderAllowedCheck() {
  const globalConfig = {
    subscriptions: [{ provider: "openai-codex", index: 2 }],
  };

  const effective = buildEffectiveConfig(globalConfig, { allowedSubs: ["openai-codex"] });
  assert.deepEqual(effective.allowedProviderNames, ["openai-codex"]);
  assert.deepEqual(effective.subscriptions.map(subProviderName), []);
}

function runUnrestrictedEnvMergeCheck() {
  const globalConfig = { subscriptions: [] };
  const envEntries = [{ provider: "openai-codex", index: 0 }];

  const effective = buildEffectiveConfig(globalConfig, undefined, envEntries);
  assert.deepEqual(effective.subscriptions.map(subProviderName), ["openai-codex-2"]);
  assert.equal(effective.allowedProviderNames, undefined);
}

runExactProviderRestrictionCheck();
runBaseProviderAllowedCheck();
runUnrestrictedEnvMergeCheck();
console.log("project restriction checks passed");
