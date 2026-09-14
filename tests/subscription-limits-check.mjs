import assert from "node:assert/strict";

function normalizeCodexUsageWindow(window) {
  if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
  return {
    usedPercent: typeof window.used_percent === "number" ? window.used_percent : 0,
    windowSeconds: typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : 0,
    resetAt: typeof window.reset_at === "number" ? window.reset_at : undefined,
  };
}

function matchesUsageWindow(window, expectedSeconds) {
  if (!window) return false;
  return Math.abs(window.windowSeconds - expectedSeconds) <= 120;
}

function parseCodexUsageSnapshot(data) {
  const rateLimit = data?.rate_limit || {};
  const windows = [
    normalizeCodexUsageWindow(rateLimit.primary_window),
    normalizeCodexUsageWindow(rateLimit.secondary_window),
  ].filter(Boolean);
  return {
    planType: typeof data?.plan_type === "string" ? data.plan_type : "unknown",
    email: typeof data?.email === "string" ? data.email : "",
    fiveHour: windows.find((window) => matchesUsageWindow(window, 5 * 60 * 60)),
    weekly: windows.find((window) => matchesUsageWindow(window, 7 * 24 * 60 * 60)),
  };
}

function getCodexWindowRemaining(window) {
  if (!window) return undefined;
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function classifyCodexQuotaKind(snapshot) {
  const values = [getCodexWindowRemaining(snapshot.fiveHour), getCodexWindowRemaining(snapshot.weekly)]
    .filter((value) => value !== undefined);
  if (values.length === 0) return { kind: "error", score: 0 };
  const bottleneck = Math.min(...values);
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function normalizeGoogleRemainingPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function parseIsoTimestampSeconds(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt, key) {
  const existing = modelsByName.get(model);
  if (!existing) {
    modelsByName.set(model, { model, remainingPercent, resetAt, key });
    return;
  }

  let next = existing;
  if (existing.key === undefined && key !== undefined) {
    next = { ...next, key };
  }
  if (remainingPercent !== undefined) {
    if (existing.remainingPercent === undefined || remainingPercent < existing.remainingPercent) {
      next = { ...next, remainingPercent };
    }
  }
  if (resetAt !== undefined) {
    if (next.resetAt === undefined || resetAt < next.resetAt) {
      next = { ...next, resetAt };
    }
  }
  if (next !== existing) {
    modelsByName.set(model, next);
  }
}

function buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName) {
  const models = [...modelsByName.values()];
  const remainingPercents = models
    .map((model) => model.remainingPercent)
    .filter((value) => value !== undefined);
  const worstRemainingPercent = remainingPercents.length > 0
    ? Math.min(...remainingPercents)
    : undefined;

  return { endpoint, projectId, models, worstRemainingPercent };
}

function getGoogleGeminiModelLabel(modelId) {
  if (!modelId) return "unknown";
  const normalized = modelId.toLowerCase();
  if (normalized.includes("pro")) return "Pro";
  if (normalized.includes("flash")) return "Flash";
  return modelId;
}

function parseGoogleGeminiQuotaSnapshot(data, projectId) {
  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  const modelsByName = new Map();

  for (const bucket of buckets) {
    const rawKey = typeof bucket?.modelId === "string" ? bucket.modelId : undefined;
    if (rawKey && (rawKey.toLowerCase().includes("placeholder") || rawKey.toLowerCase().startsWith("tab_"))) {
      continue;
    }
    const model = getGoogleGeminiModelLabel(rawKey);
    if (model.toLowerCase().includes("placeholder")) continue;
    const remainingPercent = normalizeGoogleRemainingPercent(bucket?.remainingFraction);
    const resetAt = typeof bucket?.resetTime === "string"
      ? parseIsoTimestampSeconds(bucket.resetTime)
      : undefined;
    if (remainingPercent === undefined && resetAt === undefined) continue;
    updateGoogleQuotaModel(modelsByName, model, remainingPercent, resetAt, rawKey);
  }

  return buildGoogleQuotaSnapshot(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    projectId,
    modelsByName,
  );
}

const GOOGLE_ANTIGRAVITY_HIDDEN_MODELS = new Set(["tab_flash_lite_preview"]);

function isGoogleAntigravityPlaceholder(value) {
  if (!value) return true;
  const lower = String(value).toLowerCase();
  return lower.includes("placeholder") || lower.startsWith("model_");
}

function isGoogleAntigravityHiddenModel(modelKey, displayName) {
  const lowerKey = String(modelKey).toLowerCase();
  if (
    lowerKey.startsWith("tab_") ||
    lowerKey.startsWith("chat_") ||
    lowerKey.includes("placeholder") ||
    GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(lowerKey)
  ) {
    return true;
  }
  if (displayName) {
    const lowerName = String(displayName).toLowerCase();
    if (
      lowerName.includes("placeholder") ||
      GOOGLE_ANTIGRAVITY_HIDDEN_MODELS.has(lowerName)
    ) {
      return true;
    }
  }
  return false;
}

function formatAntigravityModelKey(key) {
  const base = key.replace(/-tiered$/, "");
  return base
    .split("-")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function parseGoogleAntigravityQuotaSnapshot(data, endpoint, projectId) {
  const rawModels = data?.models && typeof data.models === "object" ? data.models : {};
  const modelsByName = new Map();

  for (const [modelKey, modelValue] of Object.entries(rawModels)) {
    if (modelValue?.isInternal === true) continue;
    if (isGoogleAntigravityHiddenModel(modelKey)) continue;

    const rawDisplayName = typeof modelValue?.displayName === "string" && modelValue.displayName.length > 0
      ? modelValue.displayName
      : typeof modelValue?.model === "string" && modelValue.model.length > 0 && !isGoogleAntigravityPlaceholder(modelValue.model)
        ? modelValue.model
        : undefined;

    const displayName = (rawDisplayName && !isGoogleAntigravityPlaceholder(rawDisplayName))
      ? rawDisplayName
      : formatAntigravityModelKey(modelKey);

    if (isGoogleAntigravityHiddenModel(modelKey, displayName)) continue;

    const quotaInfo = modelValue?.quotaInfo || {};
    const remainingPercent = normalizeGoogleRemainingPercent(quotaInfo.remainingFraction);
    const resetAt = typeof quotaInfo.resetTime === "string"
      ? parseIsoTimestampSeconds(quotaInfo.resetTime)
      : undefined;
    if (remainingPercent === undefined && resetAt === undefined) continue;
    updateGoogleQuotaModel(modelsByName, displayName, remainingPercent, resetAt, modelKey);
  }

  return buildGoogleQuotaSnapshot(endpoint, projectId, modelsByName);
}

function classifyGoogleQuotaKind(snapshot) {
  const bottleneck = snapshot.worstRemainingPercent;
  if (bottleneck === undefined) return { kind: "error", score: 0 };
  if (bottleneck <= 5) return { kind: "blocked", score: bottleneck };
  if (bottleneck <= 15) return { kind: "low", score: bottleneck };
  if (bottleneck <= 30) return { kind: "watch", score: bottleneck };
  return { kind: "ready", score: bottleneck };
}

function normalizeModelToken(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripCloneSuffix(name) {
  return String(name || "").replace(/\s*\(#\d+\)\s*$/, "");
}

function getGeminiFamily(model) {
  const idNorm = normalizeModelToken(model.id);
  const nameNorm = normalizeModelToken(model.name);
  if (idNorm.includes("pro") || nameNorm.includes("pro")) return "pro";
  if (idNorm.includes("flash") || nameNorm.includes("flash")) return "flash";
  return undefined;
}

function matchGoogleQuotaModels(baseProvider, model, snapshot) {
  if (baseProvider === "google-gemini-cli") {
    const family = getGeminiFamily(model);
    if (!family) return [];
    return snapshot.models.filter((bucket) => bucket.model.toLowerCase() === family);
  }

  const mid = normalizeModelToken(model.id);
  const mname = normalizeModelToken(stripCloneSuffix(model.name));

  return snapshot.models.filter((bucket) => {
    const bkey = normalizeModelToken(bucket.key ?? "");
    const blabel = normalizeModelToken(bucket.model);

    if (bkey && mid && bkey === mid) return true;
    if (blabel && mname && blabel === mname) return true;

    if (bkey && mid && Math.min(bkey.length, mid.length) >= 4) {
      if (bkey.startsWith(mid) || mid.startsWith(bkey)) return true;
    }
    if (blabel && mname && Math.min(blabel.length, mname.length) >= 4) {
      if (blabel.startsWith(mname) || mname.startsWith(blabel)) return true;
    }

    return false;
  });
}

function pickWorstQuotaModel(models) {
  if (!models || models.length === 0) return undefined;
  let worst = models[0];
  for (let i = 1; i < models.length; i++) {
    const current = models[i];
    const currentPercent = current.remainingPercent ?? 101;
    const worstPercent = worst.remainingPercent ?? 101;
    if (currentPercent < worstPercent) {
      worst = current;
    }
  }
  return worst;
}

function formatResetShort(resetAt) {
  if (!resetAt) return "--";
  const diffMs = resetAt * 1000 - Date.now();
  if (diffMs <= 0) return "now";
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function formatRemainingPercent(value) {
  if (value === undefined) return "--";
  return `${value}%`;
}

function formatCurrentModelQuota(result, model) {
  if (result.kind === "missing-auth" || result.kind === "error") {
    return undefined;
  }

  if (result.googleSnapshot) {
    const matches = matchGoogleQuotaModels(result.account.baseProvider, model, result.googleSnapshot);
    const worst = pickWorstQuotaModel(matches);
    if (!worst) return undefined;
    return `${worst.model} ${formatRemainingPercent(worst.remainingPercent)} ${formatResetShort(worst.resetAt)}`;
  }

  if (result.codexSnapshot) {
    const s = result.codexSnapshot;
    const five = getCodexWindowRemaining(s.fiveHour);
    const week = getCodexWindowRemaining(s.weekly);
    let windowLabel;
    let remaining;
    let resetAt;

    if (five !== undefined && week !== undefined) {
      if (five <= week) {
        windowLabel = "5h";
        remaining = five;
        resetAt = s.fiveHour?.resetAt;
      } else {
        windowLabel = "7d";
        remaining = week;
        resetAt = s.weekly?.resetAt;
      }
    } else if (five !== undefined) {
      windowLabel = "5h";
      remaining = five;
      resetAt = s.fiveHour?.resetAt;
    } else if (week !== undefined) {
      windowLabel = "7d";
      remaining = week;
      resetAt = s.weekly?.resetAt;
    }

    if (windowLabel === undefined || remaining === undefined) return undefined;
    return `${windowLabel} ${formatRemainingPercent(remaining)} ${formatResetShort(resetAt)}`;
  }

  return undefined;
}

function subDisplayName(entry) {
  const providerNames = {
    "openai-codex": "ChatGPT Plus/Pro (Codex)",
    anthropic: "Anthropic (Claude Pro/Max)",
  };
  const providerName = `${providerNames[entry.provider] || entry.provider} #${entry.index}`;
  if (!entry.label) return providerName;
  return `${entry.label} — ${providerName}`;
}

function runWindowClassificationChecks() {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const snapshot = parseCodexUsageSnapshot({
    plan_type: "pro",
    email: "test@example.com",
    rate_limit: {
      // Intentionally reversed from the human-friendly order.
      primary_window: {
        used_percent: 35,
        limit_window_seconds: 7 * 24 * 60 * 60,
        reset_at: resetAt + 6 * 24 * 60 * 60,
      },
      secondary_window: {
        used_percent: 10,
        limit_window_seconds: 5 * 60 * 60,
        reset_at: resetAt,
      },
    },
  });

  assert.equal(snapshot.planType, "pro");
  assert.equal(snapshot.email, "test@example.com");
  assert.equal(snapshot.fiveHour.windowSeconds, 5 * 60 * 60);
  assert.equal(snapshot.weekly.windowSeconds, 7 * 24 * 60 * 60);
  assert.equal(getCodexWindowRemaining(snapshot.fiveHour), 90);
  assert.equal(getCodexWindowRemaining(snapshot.weekly), 65);
}

function runSeverityChecks() {
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 20 }, weekly: { usedPercent: 40 } }).kind,
    "ready",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 75 }, weekly: { usedPercent: 20 } }).kind,
    "watch",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 88 }, weekly: { usedPercent: 15 } }).kind,
    "low",
  );
  assert.equal(
    classifyCodexQuotaKind({ fiveHour: { usedPercent: 97 }, weekly: { usedPercent: 10 } }).kind,
    "blocked",
  );
  assert.equal(classifyCodexQuotaKind({}).kind, "error");
}

function runGoogleGeminiQuotaParsingChecks() {
  const snapshot = parseGoogleGeminiQuotaSnapshot({
    buckets: [
      {
        modelId: "Gemini 2.5 Pro",
        remainingFraction: 0.82,
        resetTime: "2026-03-21T12:00:00Z",
      },
      {
        modelId: "Gemini 2.5 Flash",
        remainingFraction: 0.25,
        resetTime: "2026-03-20T18:30:00Z",
      },
      {
        modelId: "Gemini 2.5 Pro",
        remainingFraction: 0.61,
      },
    ],
  }, "project-123");

  assert.equal(snapshot.projectId, "project-123");
  assert.equal(snapshot.endpoint, "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota");
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models.find((model) => model.model === "Pro")?.remainingPercent, 61);
  assert.equal(snapshot.models.find((model) => model.model === "Flash")?.remainingPercent, 25);
  assert.ok(snapshot.models.find((model) => model.model === "Pro")?.resetAt > 0);
  assert.equal(snapshot.worstRemainingPercent, 25);
}

function runGoogleAntigravityQuotaParsingChecks() {
  const snapshot = parseGoogleAntigravityQuotaSnapshot({
    models: {
      "gemini-3-pro-high": {
        displayName: "G3 Pro",
        quotaInfo: {
          remainingFraction: 0.7,
          resetTime: "2026-03-21T10:00:00Z",
        },
      },
      duplicate: {
        displayName: "G3 Pro",
        quotaInfo: {
          remainingFraction: 0.42,
        },
      },
      hidden: {
        displayName: "tab_flash_lite_preview",
        quotaInfo: { remainingFraction: 0.99 },
      },
      tab_jump_flash_lite_preview: {
        model: "MODEL_PLACEHOLDER_M28",
        quotaInfo: { remainingFraction: 0.99 },
      },
      placeholder: {
        displayName: "MODEL_PLACEHOLDER_M196",
        quotaInfo: { remainingFraction: 0.99 },
      },
      tiered38: {
        model: "MODEL_PLACEHOLDER_M322",
        quotaInfo: {
          remainingFraction: 0.99,
          resetTime: "2026-03-21T10:00:00Z",
        },
      },
      internal: {
        displayName: "Internal",
        isInternal: true,
        quotaInfo: { remainingFraction: 0.01 },
      },
      flash: {
        model: "G3 Flash",
        quotaInfo: {
          remainingFraction: 0.88,
          resetTime: "2026-03-20T18:30:00Z",
        },
      },
    },
  }, "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels", "project-456");

  assert.equal(snapshot.projectId, "project-456");
  // Hidden models (tab_flash_lite_preview, tabJump/MODEL_PLACEHOLDER_M28, placeholder/MODEL_PLACEHOLDER_M196, internal) are filtered.
  // tiered38 (gemini-3.8-flash-tiered) resolves to "Gemini 3.8 Flash".
  assert.equal(snapshot.models.length, 3);
  assert.equal(snapshot.models.find((model) => model.model === "G3 Pro")?.remainingPercent, 42);
  assert.equal(snapshot.models.find((model) => model.model === "G3 Flash")?.remainingPercent, 88);
  assert.equal(snapshot.models.find((model) => model.model === "Tiered38")?.remainingPercent, 99);
  assert.equal(snapshot.models.some((model) => model.model.includes("PLACEHOLDER")), false);
  assert.ok(snapshot.models.find((model) => model.model === "G3 Flash")?.resetAt > 0);
  assert.equal(snapshot.worstRemainingPercent, 42);
}

function runGoogleClassificationChecks() {
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 80 }).kind, "ready");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 25 }).kind, "watch");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 10 }).kind, "low");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: 3 }).kind, "blocked");
  assert.equal(classifyGoogleQuotaKind({ worstRemainingPercent: undefined }).kind, "error");
}

function runDisplayNameChecks() {
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 2 }),
    "ChatGPT Plus/Pro (Codex) #2",
  );
  assert.equal(
    subDisplayName({ provider: "openai-codex", index: 3, label: "Outlook" }),
    "Outlook — ChatGPT Plus/Pro (Codex) #3",
  );
}

function runModelMatchChecks() {
  const resetAt = Math.floor(Date.now() / 1000) + 3600;
  const antigravitySnapshot = parseGoogleAntigravityQuotaSnapshot({
    models: {
      "gemini-3.8-flash": {
        displayName: "Gemini 3.8 Flash",
        quotaInfo: {
          remainingFraction: 0.85,
          resetTime: "2026-03-21T12:00:00Z",
        },
      },
      "gemini-3.6-flash-high": {
        displayName: "Gemini 3.6 Flash (High)",
        quotaInfo: {
          remainingFraction: 0.40,
          resetTime: "2026-03-21T12:00:00Z",
        },
      },
      "gemini-3.6-flash-medium": {
        displayName: "Gemini 3.6 Flash (Medium)",
        quotaInfo: {
          remainingFraction: 0.65,
          resetTime: "2026-03-21T12:00:00Z",
        },
      },
    },
  }, "https://cloudcode-pa.googleapis.com", "proj-1");

  // Retained key assertion
  const flash38 = antigravitySnapshot.models.find((m) => m.model === "Gemini 3.8 Flash");
  assert.equal(flash38?.key, "gemini-3.8-flash");
  const flash36High = antigravitySnapshot.models.find((m) => m.model === "Gemini 3.6 Flash (High)");
  assert.equal(flash36High?.key, "gemini-3.6-flash-high");

  // Model match: clone name stripped, id matched exactly
  const matches38 = matchGoogleQuotaModels(
    "google-antigravity",
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (#2)" },
    antigravitySnapshot,
  );
  assert.equal(matches38.length, 1);
  assert.equal(matches38[0].model, "Gemini 3.8 Flash");

  const formatted38 = formatCurrentModelQuota(
    {
      account: { baseProvider: "google-antigravity", providerName: "google-antigravity-2", displayName: "Antigravity #2" },
      kind: "ready",
      googleSnapshot: antigravitySnapshot,
    },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash (#2)", provider: "google-antigravity-2" },
  );
  assert.ok(formatted38?.includes("Gemini 3.8 Flash"));
  assert.ok(formatted38?.includes("85%"));

  // Tier variants: prefix match matches High and Medium buckets; pickWorst picks lowest (40%)
  const matches36 = matchGoogleQuotaModels(
    "google-antigravity",
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    antigravitySnapshot,
  );
  assert.equal(matches36.length, 2);
  const worst36 = pickWorstQuotaModel(matches36);
  assert.equal(worst36?.model, "Gemini 3.6 Flash (High)");
  assert.equal(worst36?.remainingPercent, 40);

  // Gemini-CLI family match
  const geminiCliSnapshot = parseGoogleGeminiQuotaSnapshot({
    buckets: [
      { modelId: "Gemini 2.5 Pro", remainingFraction: 0.9 },
      { modelId: "Gemini 2.5 Flash", remainingFraction: 0.5 },
    ],
  }, "proj-2");

  const matchesCliFlash = matchGoogleQuotaModels(
    "google-gemini-cli",
    { id: "gemini-3.8-flash-preview", name: "Gemini 3.8 Flash Preview" },
    geminiCliSnapshot,
  );
  assert.equal(matchesCliFlash.length, 1);
  assert.equal(matchesCliFlash[0].model, "Flash");

  const matchesCliPro = matchGoogleQuotaModels(
    "google-gemini-cli",
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    geminiCliSnapshot,
  );
  assert.equal(matchesCliPro.length, 1);
  assert.equal(matchesCliPro[0].model, "Pro");

  // Unmatched model returns [] and formatCurrentModelQuota returns undefined
  const unmatched = matchGoogleQuotaModels(
    "google-antigravity",
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
    antigravitySnapshot,
  );
  assert.deepEqual(unmatched, []);

  const formattedUnmatched = formatCurrentModelQuota(
    {
      account: { baseProvider: "google-antigravity", providerName: "google-antigravity", displayName: "Antigravity" },
      kind: "ready",
      googleSnapshot: antigravitySnapshot,
    },
    { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet", provider: "google-antigravity" },
  );
  assert.equal(formattedUnmatched, undefined);

  // Error/missing-auth returns undefined
  assert.equal(
    formatCurrentModelQuota(
      { account: { baseProvider: "google-antigravity" }, kind: "missing-auth", googleSnapshot: antigravitySnapshot },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", provider: "google-antigravity" },
    ),
    undefined,
  );

  // Codex status formatting
  const codexFormatted = formatCurrentModelQuota(
    {
      account: { baseProvider: "openai-codex", providerName: "openai-codex", displayName: "Codex" },
      kind: "ready",
      codexSnapshot: {
        planType: "pro",
        email: "a@b.com",
        fiveHour: { usedPercent: 20, windowSeconds: 18000, resetAt },
        weekly: { usedPercent: 40, windowSeconds: 604800, resetAt: resetAt + 10000 },
      },
    },
    { id: "gpt-4o", name: "GPT-4o", provider: "openai-codex" },
  );
  assert.ok(codexFormatted?.startsWith("7d 60%"));
}

runWindowClassificationChecks();
runSeverityChecks();
runGoogleGeminiQuotaParsingChecks();
runGoogleAntigravityQuotaParsingChecks();
runGoogleClassificationChecks();
runDisplayNameChecks();
runModelMatchChecks();
console.log("subscription limit checks passed");
