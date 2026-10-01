import { ChatInputCommandInteraction, Client, MessageFlags, SlashCommandBuilder } from "discord.js";
import { MemoryConfig, resolveMemoryScope } from "./memoryConfig";
import { MemoryCategory, MemoryInput, MemoryStore, memoryCategories, validateMemory } from "./memoryStore";

export interface MemoryRuntime { config: MemoryConfig; store: MemoryStore }

export function memoryCommandDefinition(): SlashCommandBuilder {
  const categoryChoices = memoryCategories.map(value => ({ name: value, value }));
  return new SlashCommandBuilder().setName("memory").setDescription("Manage this kin's memories in this channel")
    .addSubcommand(command => command.setName("add").setDescription("Add an important continuity note")
      .addStringOption(o => o.setName("content").setDescription("Short factual summary").setRequired(true).setMaxLength(1000))
      .addStringOption(o => o.setName("category").setDescription("Memory type").setRequired(true).addChoices(...categoryChoices))
      .addStringOption(o => o.setName("tags").setDescription("Comma-separated search tags; maximum 10"))
      .addIntegerOption(o => o.setName("importance").setDescription("1–5; 5 always considered for context").setMinValue(1).setMaxValue(5)))
    .addSubcommand(command => command.setName("list").setDescription("List this context's memories")
      .addIntegerOption(o => o.setName("page").setDescription("Page number").setMinValue(1).setMaxValue(10000)))
    .addSubcommand(command => command.setName("show").setDescription("Inspect a memory in this context")
      .addStringOption(o => o.setName("id").setDescription("Memory UUID").setRequired(true)))
    .addSubcommand(command => command.setName("edit").setDescription("Update a memory in this context")
      .addStringOption(o => o.setName("id").setDescription("Memory UUID").setRequired(true))
      .addStringOption(o => o.setName("content").setDescription("Replacement summary").setMaxLength(1000))
      .addStringOption(o => o.setName("category").setDescription("Memory type").addChoices(...categoryChoices))
      .addStringOption(o => o.setName("tags").setDescription("Replace tags; enter a comma to clear"))
      .addIntegerOption(o => o.setName("importance").setDescription("Priority 1–5").setMinValue(1).setMaxValue(5))
      .addBooleanOption(o => o.setName("active").setDescription("Whether this memory may be retrieved")))
    .addSubcommand(command => command.setName("delete").setDescription("Permanently delete one memory")
      .addStringOption(o => o.setName("id").setDescription("Memory UUID").setRequired(true))
      .addBooleanOption(o => o.setName("confirm").setDescription("Confirm permanent deletion").setRequired(true))) as SlashCommandBuilder;
}

export async function registerMemoryCommands(client: Client, kinId: string, config: MemoryConfig): Promise<void> {
  const guildIds = new Set(config.contexts.filter(c => c.kinId === kinId).map(c => c.guildId));
  for (const guildId of guildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      const existing = (await guild.commands.fetch()).find(command => command.name === "memory");
      const definition = memoryCommandDefinition().toJSON();
      // Only create/update our command; preserve unrelated application commands.
      if (existing) await guild.commands.edit(existing.id, definition);
      else await guild.commands.create(definition);
    } catch {
      console.warn(`Memory slash command registration failed for kin ${kinId}, guild ${guildId}.`);
    }
  }
}

function parseTags(text: string): string[] {
  return text.split(",").map(tag => tag.trim()).filter(Boolean);
}

export async function handleMemoryCommand(
  interaction: ChatInputCommandInteraction, kinId: string | undefined, runtime: MemoryRuntime | undefined
): Promise<void> {
  const respond = async (content: string) => {
    const payload = { content, allowedMentions: { parse: [] as never[] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  };
  try {
    if (!runtime?.config.enabled || !runtime.config.adminUserIds.has(interaction.user.id)) {
      await respond("Memory administration is unavailable or you are not authorized.");
      return;
    }
    const scope = resolveMemoryScope(runtime.config, kinId, interaction.client.user?.id,
      interaction.guildId, interaction.channelId);
    if (!scope) {
      await respond("Memory is not configured for this kin and channel. DMs are not enabled.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const command = interaction.options.getSubcommand();
    const id = interaction.options.getString("id") || "";
    if (command === "list") {
      const page = interaction.options.getInteger("page") ?? 1;
      const rows = await runtime.store.list(scope, page);
      const lines = rows.map(m => `${m.id} | ${m.category} | ${m.active ? "active" : "inactive"}\n${m.content.replace(/\s+/g, " ").slice(0, 80)}`);
      await respond(`Kin: ${scope.kinId} | Story: ${scope.storyline} | Page ${page}\n${lines.join("\n\n") || "No memories on this page."}`);
      return;
    }
    if (command === "delete") {
      if (!interaction.options.getBoolean("confirm")) {
        await respond("Nothing deleted. Use confirm:true to permanently delete this memory in this context.");
        return;
      }
      await respond(await runtime.store.delete(scope, id) ? "Memory deleted." : "Memory not found in this context.");
      return;
    }
    const existing = command === "add" ? undefined : await runtime.store.show(scope, id);
    if (command !== "add" && !existing) {
      await respond("Memory not found in this context.");
      return;
    }
    if (command === "show" && existing) {
      await respond(`${existing.id}\nKin: ${scope.kinId} | Story: ${scope.storyline}\n${existing.category} | importance ${existing.importance} | ${existing.active ? "active" : "inactive"}\nTags: ${existing.tags.join(", ") || "none"}\n${existing.content}\nCreated: ${existing.created_at.toISOString()} | Updated: ${existing.updated_at.toISOString()}`);
      return;
    }
    const input: MemoryInput = {
      content: interaction.options.getString("content") ?? existing?.content ?? "",
      category: (interaction.options.getString("category") ?? existing?.category ?? "personal_fact") as MemoryCategory,
      tags: interaction.options.getString("tags") === null ? existing?.tags ?? [] : parseTags(interaction.options.getString("tags") || ""),
      importance: interaction.options.getInteger("importance") ?? existing?.importance ?? 3,
    };
    try { validateMemory(input); } catch {
      await respond("Use 1–1000 characters, a supported category, importance 1–5, and up to 10 tags of 1–40 characters.");
      return;
    }
    if (command === "add") {
      const memory = await runtime.store.add(scope, input, interaction.user.id);
      await respond(`Memory added: ${memory.id}\nKin: ${scope.kinId} | Story: ${scope.storyline} | This channel only.`);
    } else if (command === "edit" && existing) {
      const memory = await runtime.store.edit(scope, id, input,
        interaction.options.getBoolean("active") ?? existing.active, interaction.user.id);
      await respond(memory ? "Memory updated." : "Memory not found in this context.");
    }
  } catch {
    console.warn("Memory command failed; no database details were exposed.");
    try { await respond("Memory operation failed. Check database connectivity and migration status; inspect the record before retrying a write."); }
    catch { console.warn("Could not send the private memory command response."); }
  }
}
