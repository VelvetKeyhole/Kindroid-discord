import { ChatInputCommandInteraction, Client, MessageFlags, SlashCommandBuilder } from "discord.js";
import { MemoryConfig, resolveMemoryScope, resolvedContext } from "./memoryConfig";
import { MemoryExtractionWorker } from "./memoryExtraction";
import { MemoryCategory, MemoryInput, MemoryStore, MemoryEditConflict, memoryCategories, validateMemory } from "./memoryStore";
import { MemoryMetadata, visibilities, memoryTypes, statementTypes } from './memoryPolicy';
import { MemoryProduction, readableCanon, exportSafetyWarning } from './memoryProduction';

export interface MemoryRuntime { config: MemoryConfig; store: MemoryStore; extractor?: MemoryExtractionWorker }

export function memoryCommandDefinition(): SlashCommandBuilder {
  const categoryChoices = memoryCategories.map(value => ({ name: value, value }));
  const definition = new SlashCommandBuilder().setName("memory").setDescription("Manage this kin's memories in this channel")
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
    .addSubcommand(command => command.setName("delete").setDescription("Archive one memory, preserving recovery history")
      .addStringOption(o => o.setName("id").setDescription("Memory UUID").setRequired(true))
      .addBooleanOption(o => o.setName("confirm").setDescription("Confirm archive").setRequired(true)))
    .addSubcommand(command => command.setName("pending").setDescription("List candidates awaiting approval")
      .addIntegerOption(o => o.setName("page").setDescription("Page number").setMinValue(1).setMaxValue(10000)))
    .addSubcommand(command => command.setName("approve").setDescription("Approve a pending candidate")
      .addStringOption(o => o.setName("id").setDescription("Pending memory UUID").setRequired(true))
      .addStringOption(o => o.setName("supersedes").setDescription("Optional active UUID replaced by this current-state fact")))
    .addSubcommand(command => command.setName("reject").setDescription("Reject a pending candidate and retain its history")
      .addStringOption(o => o.setName("id").setDescription("Pending memory UUID").setRequired(true)))
    .addSubcommand(command => command.setName("auto-status").setDescription("Inspect extraction switches for this context"))
    .addSubcommand(command => command.setName("auto-on").setDescription("Enable candidates here, subject to the environment gates"))
    .addSubcommand(command => command.setName("auto-off").setDescription("Disable candidate extraction in this context"))
    .addSubcommand(c=>c.setName('history').setDescription('Inspect revision IDs and change history').addStringOption(o=>o.setName('id').setDescription('Memory UUID').setRequired(true)))
    .addSubcommand(c=>c.setName('restore').setDescription('Restore a revision without automatically activating it')
      .addStringOption(o=>o.setName('id').setDescription('Memory UUID').setRequired(true))
      .addStringOption(o=>o.setName('revision').setDescription('Revision number from history').setRequired(true)))
    .addSubcommand(c=>c.setName('retcon').setDescription('Correct canon as a production override, retaining history')
      .addStringOption(o=>o.setName('id').setDescription('Memory UUID').setRequired(true))
      .addStringOption(o=>o.setName('content').setDescription('Corrected summary').setRequired(true).setMaxLength(1000))
      .addStringOption(o=>o.setName('reason').setDescription('Production reason, not an in-story event').setRequired(true).setMaxLength(500))
      .addStringOption(o=>o.setName('fact-key').setDescription('Optional corrected conflict key').setMaxLength(200))
      .addStringOption(o=>o.setName('assertion').setDescription('Optional corrected value for conflict resolution').setMaxLength(200)))
    .addSubcommand(c=>c.setName('merge').setDescription('Consolidate equivalent active notes without losing sources')
      .addStringOption(o=>o.setName('id').setDescription('Memory UUID to keep').setRequired(true))
      .addStringOption(o=>o.setName('duplicate').setDescription('Equivalent UUID to archive').setRequired(true)))
    .addSubcommand(c=>c.setName('conflicts').setDescription('List contradictory current facts for review'))
    .addSubcommand(c=>c.setName('snapshot').setDescription('Export current eligible canon privately'));
  for (const command of definition.options.filter(o=>['add','edit'].includes(o.toJSON().name))) {
    // Both builders are subcommands; options remain below Discord's 25-option limit.
    const c = command as import('discord.js').SlashCommandSubcommandBuilder;
    c.addStringOption(o=>o.setName('visibility').setDescription('Allowed request context').addChoices(...visibilities.map(value=>({name:value,value}))))
      .addStringOption(o=>o.setName('known-by').setDescription('Comma-separated stable kin IDs; must include owner').setMaxLength(1300))
      .addStringOption(o=>o.setName('known-at').setDescription('ISO timestamp when the owner learned this'))
      .addStringOption(o=>o.setName('type').setDescription('Historical event or current knowledge type').addChoices(...memoryTypes.map(value=>({name:value,value}))))
      .addStringOption(o=>o.setName('statement').setDescription('Truth/uncertainty classification').addChoices(...statementTypes.map(value=>({name:value,value}))))
      .addStringOption(o=>o.setName('speaker-id').setDescription('Stable speaker identifier').setMaxLength(200))
      .addStringOption(o=>o.setName('expires-at').setDescription('ISO expiry; use none to clear; events cannot expire'))
      .addBooleanOption(o=>o.setName('pinned').setDescription('Prefer this note after privacy filtering'))
      .addStringOption(o=>o.setName('domain').setDescription('Identity/backstory versus storyline').addChoices({name:'identity',value:'identity'},{name:'continuity',value:'continuity'}))
      .addStringOption(o=>o.setName('fact-key').setDescription('Shared key for mutually exclusive current facts').setMaxLength(200))
      .addStringOption(o=>o.setName('assertion').setDescription('Value for conflict comparison').setMaxLength(200));
  }
  return definition as SlashCommandBuilder;
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
    const payload = content.length > 3900 ? { content:'Private memory report attached.', files:[{attachment:Buffer.from(content),name:'memory-report.txt'}], allowedMentions:{parse:[] as never[]} } : content.length <= 1900
      ? { content, allowedMentions: { parse: [] as never[] } }
      : { content: "", embeds: [{ description: content }], allowedMentions: { parse: [] as never[] } };
    if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
    else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  };
  try {
    if (!runtime?.config.enabled || !runtime.config.adminUserIds.has(interaction.user.id)) {
      await respond("Memory administration is unavailable or you are not authorized.");
      return;
    }
    const scope = resolveMemoryScope(runtime.config, kinId, interaction.client.user?.id,
      interaction.guildId, interaction.channelId, {
        categoryId: interaction.channel && "parentId" in interaction.channel ? interaction.channel.parentId : null,
        isThread: interaction.channel?.isThread() ?? false,
        categoryPermissionsSynced: interaction.channel && "permissionsLocked" in interaction.channel ? interaction.channel.permissionsLocked === true : false,
      });
    if (!scope) {
      await respond("Memory is not configured for this kin and channel. DMs are not enabled.");
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const command = interaction.options.getSubcommand();
    const id = interaction.options.getString("id") || "";
    const context = resolvedContext(scope);
    if (command==='history') {
      const history = await runtime.store.history(scope,id);
      if (!history.length) { await respond('No history in this context.'); return; }
      await interaction.editReply({content:'Revision history attached privately. Use a revision ID with /memory restore.',
        files:[{attachment:Buffer.from(JSON.stringify(history,null,2)),name:'memory-history.json'}]}); return;
    }
    if (command==='restore') { await respond(await runtime.store.restore(scope,id,interaction.options.getString('revision')||'',interaction.user.id) ? 'Revision restored without automatic activation. Review before enabling.' : 'Memory/revision not found.'); return; }
    if (command==='retcon') { await respond(await runtime.store.retcon(scope,id,interaction.options.getString('content')||'',interaction.user.id,interaction.options.getString('reason')||'',metadataOptions(interaction)) ? 'Production correction recorded; previous text preserved in history.' : 'Memory not found or not eligible.'); return; }
    if (command==='merge') { await respond(await runtime.store.merge(scope,id,interaction.options.getString('duplicate')||'',interaction.user.id) ? 'Merged; original records and provenance retained.' : 'Memories not found.'); return; }
    if (command==='conflicts') { await respond((await runtime.store.conflicts(scope)).slice(0,15).map(c=>`${c.fact_key}: ${c.id} / ${c.other_id}`).join('\n') || 'No flagged conflicts. Detection is conservative.'); return; }
    if (command==='snapshot') {
      const rows = await new MemoryProduction(runtime.store).snapshot(scope);
      if (rows.length>1000) { await respond('Snapshot exceeds the Discord preview limit. Use the local production tool for the full snapshot.'); return; }
      await interaction.editReply({ content:`Current eligible canon; private attachments. ${exportSafetyWarning}`, files:[
        { attachment:Buffer.from(JSON.stringify(rows,null,2)),name:'current-canon.json' },
        { attachment:Buffer.from(readableCanon(scope,rows)),name:'current-canon.txt' }] }); return;
    }
    if (["auto-status", "auto-on", "auto-off"].includes(command)) {
      if (command !== "auto-status") await runtime.store.setAutoSetting(scope, command === "auto-on");
      const override = await runtime.store.autoSetting(scope);
      const allowlisted = runtime.config.autoChannelIds?.has(scope.channelId) === true;
      const enabled = runtime.config.autoEnabled === true && allowlisted && override !== false;
      await respond(`Context: ${context.type}:${context.id}\nMaster MEMORY_AUTO_ENABLED: ${runtime.config.autoEnabled === true}\nThis channel allowlisted: ${allowlisted}\nContext override: ${override ?? "inherit"}\nExtraction effective here: ${enabled}\nAll candidates require approval; automatic activation is disabled.`);
      return;
    }
    if (command === "approve") {
      const memory = await runtime.store.approve(scope, id, interaction.user.id, interaction.options.getString("supersedes") ?? undefined);
      await respond(memory ? "Pending memory approved and activated." : "Pending memory not found in this context.");
      return;
    }
    if (command === "reject") {
      await respond(await runtime.store.reject(scope, id, interaction.user.id) ? "Candidate rejected; retained for history and deduplication." : "Pending memory not found in this context.");
      return;
    }
    if (command === "list" || command === "pending") {
      const page = interaction.options.getInteger("page") ?? 1;
      const rows = await runtime.store.list(scope, page, command === "pending");
      const lines = rows.map(m => `${m.id} | ${m.category} | ${m.status} | ${m.metadata.visibility}\nKnown by: ${m.metadata.knownByKinIds.join(', ')} | Score: ${m.candidate_importance ?? 'manual'} | Confidence: ${m.confidence ?? 'manual'}\n${m.content.replace(/\s+/g, " ").slice(0, 80)}`);
      await respond(`Kin: ${scope.kinId} | Story: ${scope.storyline} | Page ${page}\n${lines.join("\n\n") || "No memories on this page."}`);
      return;
    }
    if (command === "delete") {
      if (!interaction.options.getBoolean("confirm")) {
        await respond("Nothing archived. Use confirm:true to archive this memory with recovery history.");
        return;
      }
      await respond(await runtime.store.delete(scope, id, interaction.user.id) ? "Memory archived; history/restore remain available." : "Memory not found in this context.");
      return;
    }
    const existing = command === "add" ? undefined : await runtime.store.show(scope, id);
    if (command !== "add" && !existing) {
      await respond("Memory not found in this context.");
      return;
    }
    if (command === "show" && existing) {
      await interaction.editReply({ content:`${existing.id}\n${existing.category} | ${existing.status}\nVisibility: ${existing.metadata.visibility}\nKnown by: ${existing.metadata.knownByKinIds.join(', ')}\nFull content, original candidate, provenance and governance metadata attached privately.`,
        files:[{attachment:Buffer.from(JSON.stringify(existing,null,2)),name:'memory.json'}] });
      return;
    }
    const input: MemoryInput = {
      content: interaction.options.getString("content") ?? existing?.content ?? "",
      category: (interaction.options.getString("category") ?? existing?.category ?? "personal_fact") as MemoryCategory,
      tags: interaction.options.getString("tags") === null ? existing?.tags ?? [] : parseTags(interaction.options.getString("tags") || ""),
      importance: interaction.options.getInteger("importance") ?? existing?.importance ?? 3,
      metadata: metadataOptions(interaction),
    };
    try { validateMemory(input); } catch {
      await respond("Use 1–1000 characters, a supported category, importance 1–5, and up to 10 tags of 1–40 characters.");
      return;
    }
    if (command === "add") {
      const memory = await runtime.store.add(scope, input, interaction.user.id);
      await respond(`Memory added: ${memory.id}\nKin: ${scope.kinId} | Story: ${scope.storyline} | Context: ${context.type}:${context.id}`);
    } else if (command === "edit" && existing) {
      const memory = await runtime.store.edit(scope, id, input,
        interaction.options.getBoolean("active") ?? undefined, interaction.user.id, existing.edit_version);
      await respond(memory ? "Memory updated." : "Memory not found in this context.");
    }
  } catch (error) {
    if (error instanceof MemoryEditConflict) {
      try { await respond(error.message); } catch { console.warn('Could not send the private edit-conflict response.'); }
      return;
    }
    console.warn("Memory command failed; no database details were exposed.");
    try { await respond("Memory operation failed. Check database connectivity and migration status; inspect the record before retrying a write."); }
    catch { console.warn("Could not send the private memory command response."); }
  }
}

function metadataOptions(interaction: ChatInputCommandInteraction): Partial<MemoryMetadata> {
  const result: Record<string, unknown> = {};
  for (const [option,key] of [['visibility','visibility'],['known-at','knownAt'],['type','memoryType'],['statement','statementType'],['speaker-id','speakerId'],['domain','domain'],['fact-key','factKey'],['assertion','assertion']]) {
    const value = interaction.options.getString(option); if (value!==null) result[key]=value;
  }
  const audience = interaction.options.getString('known-by'); if (audience!==null) result.knownByKinIds=audience.split(',').map(s=>s.trim()).filter(Boolean);
  const expiry = interaction.options.getString('expires-at'); if (expiry!==null) result.expiresAt=expiry==='none'?null:expiry;
  const pinned = interaction.options.getBoolean('pinned'); if (pinned!==null) result.pinned=pinned;
  return result as Partial<MemoryMetadata>;
}
