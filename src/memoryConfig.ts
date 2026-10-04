import { BotConfig } from "./types";

export interface MemoryScope {
  kinId: string;
  storyline: string;
  guildId: string;
  channelId: string;
  discordBotId: string;
}

export interface MemoryConfig {
  enabled: boolean;
  adminUserIds: Set<string>;
  contexts: Omit<MemoryScope, "discordBotId">[];
}

const identifier = /^[a-zA-Z0-9_-]{1,64}$/;
const snowflake = /^\d{17,20}$/;

export function loadMemoryConfig(bots: BotConfig[]): MemoryConfig {
  const enabledValue = process.env.MEMORY_ENABLED?.toLowerCase();
  if (enabledValue && !["true", "false"].includes(enabledValue)) {
    throw new Error("MEMORY_ENABLED must be true or false");
  }
  const config: MemoryConfig = { enabled: enabledValue === "true", adminUserIds: new Set(), contexts: [] };
  if (!config.enabled) return config;
  if (!process.env.DATABASE_URL) throw new Error("Memory requires DATABASE_URL");
  const kinIds = new Set<string>();
  for (const bot of bots) {
    if (!bot.kinId || !identifier.test(bot.kinId) || kinIds.has(bot.kinId)) {
      throw new Error("Every bot needs a unique, stable KIN_ID_N (letters, numbers, underscores, hyphens)");
    }
    kinIds.add(bot.kinId);
  }
  const admins = (process.env.MEMORY_ADMIN_USER_IDS || "").split(",").map(id => id.trim()).filter(Boolean);
  if (!admins.length || admins.some(id => !snowflake.test(id))) {
    throw new Error("MEMORY_ADMIN_USER_IDS must contain Discord user IDs");
  }
  config.adminUserIds = new Set(admins);

  // Temporary diagnostics: inspect the raw value without logging its contents.
  const raw = process.env.MEMORY_CONTEXTS;
  let jsonParseSucceeded = false;
  let parsedIsArray = false;
  let entryCount: number | null = null;
  try {
    if (raw !== undefined) {
      const diagnosticValue: unknown = JSON.parse(raw);
      jsonParseSucceeded = true;
      parsedIsArray = Array.isArray(diagnosticValue);
      entryCount = Array.isArray(diagnosticValue) ? diagnosticValue.length : null;
    }
  } catch {
    // Parsing errors can include input text; leave them out of diagnostic logs.
  }
  console.info({
    exists: raw !== undefined,
    characterLength: raw?.length ?? 0,
    jsonParseSucceeded,
    parsedIsArray,
    entryCount,
  });

  const parsed: unknown = JSON.parse(process.env.MEMORY_CONTEXTS || "[]");
  if (!Array.isArray(parsed) || !parsed.length) throw new Error("MEMORY_CONTEXTS must be a nonempty JSON array");
  const locations = new Set<string>();
  for (const entry of parsed as unknown[]) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid memory context");
    const row = entry as Record<string, unknown>;
    const { kinId, storyline, guildId, channelId } = row;
    if (typeof kinId !== "string" || !kinIds.has(kinId) ||
        typeof storyline !== "string" || !identifier.test(storyline) ||
        typeof guildId !== "string" || !snowflake.test(guildId) ||
        typeof channelId !== "string" || !snowflake.test(channelId)) {
      throw new Error("Each memory context needs a configured kinId, storyline, guildId and channelId");
    }
    const key = `${kinId}:${guildId}:${channelId}`;
    if (locations.has(key)) throw new Error("Each kin/channel must map to exactly one storyline");
    locations.add(key);
    config.contexts.push({ kinId, storyline, guildId, channelId });
  }
  return config;
}

export function resolveMemoryScope(
  config: MemoryConfig, kinId: string | undefined, discordBotId: string | undefined,
  guildId: string | null, channelId: string
): MemoryScope | undefined {
  if (!config.enabled || !kinId || !discordBotId || !guildId) return undefined;
  const context = config.contexts.find(c => c.kinId === kinId && c.guildId === guildId && c.channelId === channelId);
  return context ? { ...context, discordBotId } : undefined;
}
