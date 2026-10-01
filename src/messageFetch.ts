import { TextChannel, DMChannel, Message } from "discord.js";
import { ConversationMessage } from "./types";

// Track message cache with proper typing
interface CacheEntry {
  lastFetchTime: number;
  messages: ConversationMessage[];
}

// Cache for display names
interface DisplayNameCacheEntry {
  displayName: string;
  lastFetchTime: number;
}

// In-memory cache for recent message fetches
const channelCache = new Map<string, CacheEntry>();
// Cache for display names - key is guildId:userId
const displayNameCache = new Map<string, DisplayNameCacheEntry>();

const DISPLAY_NAME_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Gets the display name for a message author with proper member fetching
 * @param msg - Discord message
 * @returns The most appropriate display name
 */
async function getUserDisplayName(msg: Message): Promise<string> {
  try {
    // Check cache first
    const cacheKey = msg.guildId
      ? `${msg.guildId}:${msg.author.id}`
      : msg.author.id;
    const now = Date.now();
    const cached = displayNameCache.get(cacheKey);

    if (cached && now - cached.lastFetchTime < DISPLAY_NAME_CACHE_DURATION) {
      return cached.displayName;
    }

    let displayName: string;

    // If in a guild, try to get server nickname
    if (msg.guildId) {
      try {
        const guild = msg.client.guilds.cache.get(msg.guildId);
        if (!guild) {
          throw new Error("Guild not found in cache");
        }

        const member = await guild.members.fetch(msg.author.id);
        if (member && member.nickname) {
          displayName = member.nickname;
        } else if (msg.author.globalName) {
          displayName = msg.author.globalName;
        } else {
          displayName = msg.author.username;
        }
      } catch (error) {
        console.error("Error fetching guild member:", error);
        displayName = msg.author.globalName || msg.author.username;
      }
    } else {
      displayName = msg.author.globalName || msg.author.username;
    }

    // Update cache
    displayNameCache.set(cacheKey, {
      displayName,
      lastFetchTime: now,
    });

    // Clean old cache entries periodically
    if (displayNameCache.size > 1000) {
      const oldestAllowed = now - DISPLAY_NAME_CACHE_DURATION;
      for (const [key, value] of displayNameCache.entries()) {
        if (value.lastFetchTime < oldestAllowed) {
          displayNameCache.delete(key);
        }
      }
    }

    return displayName;
  } catch (error) {
    console.error("Error getting display name:", error);
    return msg.author.username;
  }
}

/**
 * Fetches conversation from Discord channel
 * @param channel - The Discord channel to fetch from
 * @param limit - Number of messages to fetch
 * @returns Array of formatted messages
 */
async function fetchConversationFromDiscord(
  channel: TextChannel | DMChannel,
  limit: number = 30,
  triggeringMessage?: Message
): Promise<ConversationMessage[]> {
  try {
    // Fetch messages from Discord
    const fetched = await channel.messages.fetch({ limit });

    // Keep the trigger even if newer messages have pushed it out of the window.
    if (triggeringMessage && !fetched.has(triggeringMessage.id)) {
      const oldest = Array.from(fetched.values()).sort(
        (a, b) => a.createdTimestamp - b.createdTimestamp
      )[0];
      if (fetched.size >= limit && oldest) fetched.delete(oldest.id);
      fetched.set(triggeringMessage.id, triggeringMessage);
    }

    // Sort messages chronologically (oldest first)
    const sorted = Array.from(fetched.values()).sort(
      (a: Message, b: Message) => a.createdTimestamp - b.createdTimestamp
    );

    // Get our bot's client ID
    const ourBotId = channel.client.user?.id;
    if (!ourBotId) {
      throw new Error("Bot client ID not found");
    }

    // Pre-fetch display names for all users except our bot
    const uniqueUsers = new Set(
      sorted
        .filter((msg) => msg.author.id !== ourBotId)
        .map((msg) => msg.author.id)
    );
    const displayNamePromises = Array.from(uniqueUsers).map(async (userId) => {
      // Find first message from this user to use as reference
      const userMsg = sorted.find((m) => m.author.id === userId);
      if (userMsg) {
        await getUserDisplayName(userMsg);
      }
    });

    // Wait for all display names to be cached
    await Promise.all(displayNamePromises);

    // Now format messages using cached display names or {{ai}} for our bot's messages
    const messages = await Promise.all(
      sorted.map(
        async (msg: Message): Promise<ConversationMessage> => ({
          username:
            msg.author.id === ourBotId
              ? "{{ai}}"
              : await getUserDisplayName(msg),
          text: msg.content,
          timestamp: msg.createdAt.toISOString(),
        })
      )
    );

    return messages;
  } catch (error) {
    console.error("Error fetching messages:", error);
    throw new Error("Failed to fetch conversation history");
  }
}

/**
 * Fetches conversation with caching support
 * @param channel - The Discord channel
 * @param limit - Number of messages to fetch
 * @param cacheDurationMs - How long to cache messages
 * @param triggeringMessage - Refresh history and ensure this message is included
 */
async function ephemeralFetchConversation(
  channel: TextChannel | DMChannel,
  limit: number = 30,
  cacheDurationMs: number = 5000,
  triggeringMessage?: Message
): Promise<ConversationMessage[]> {
  const now = Date.now();
  const botId = channel.client.user?.id;
  if (!botId) throw new Error("Bot client ID not found");
  const cacheKey = `${botId}:${channel.id}:${limit}`;
  const cached = channelCache.get(cacheKey);

  // Only reads without a trigger may reuse cached context.
  if (
    !triggeringMessage &&
    cached &&
    now - cached.lastFetchTime < cacheDurationMs
  ) {
    return cached.messages;
  }

  // Fetch new data
  const messages = await fetchConversationFromDiscord(
    channel,
    limit,
    triggeringMessage
  );

  // Update cache
  channelCache.set(cacheKey, {
    lastFetchTime: now,
    messages,
  });

  // Clean old cache entries periodically
  if (channelCache.size > 1000) {
    // Prevent unbounded growth
    const oldestAllowed = now - cacheDurationMs;
    for (const [key, value] of channelCache.entries()) {
      if (value.lastFetchTime < oldestAllowed) {
        channelCache.delete(key);
      }
    }
  }

  return messages;
}

export { fetchConversationFromDiscord, ephemeralFetchConversation };
