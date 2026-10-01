import { randomUUID } from "node:crypto";
import { Database } from "./database";
import { MemoryScope } from "./memoryConfig";

export const memoryCategories = ["relationship", "conflict", "preference", "promise", "villa_event", "challenge_outcome", "personal_fact"] as const;
export type MemoryCategory = typeof memoryCategories[number];
export interface MemoryInput { content: string; category: MemoryCategory; tags: string[]; importance: number }
export interface MemoryRecord extends MemoryInput {
  id: string; kin_id: string; storyline: string; guild_id: string; channel_id: string;
  active: boolean; created_by: string; updated_by: string; created_at: Date; updated_at: Date;
}

const scopeWhere = "kin_id = $1 AND storyline = $2 AND guild_id = $3 AND channel_id = $4";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function scopeValues(scope: MemoryScope): string[] {
  if (![scope.kinId, scope.storyline, scope.guildId, scope.channelId, scope.discordBotId].every(Boolean)) {
    throw new Error("A complete memory scope is required");
  }
  return [scope.kinId, scope.storyline, scope.guildId, scope.channelId];
}

export function validateMemory(input: MemoryInput): MemoryInput {
  const content = input.content.trim();
  if (!content || content.length > 1000 || !memoryCategories.includes(input.category) ||
      !Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5 ||
      input.tags.length > 10 || input.tags.some(tag => !tag.trim() || tag.length > 40)) {
    throw new Error("Use 1–1000 characters, a supported category, importance 1–5, and at most 10 tags of 1–40 characters.");
  }
  return { ...input, content, tags: [...new Set(input.tags.map(tag => tag.trim().toLowerCase()))] };
}

export class MemoryStore {
  constructor(private readonly database: Database) {}

  private async bindScope(scope: MemoryScope): Promise<string[]> {
    const values = scopeValues(scope);
    // An existing identity cannot silently be reassigned to a different Discord bot.
    const kin = await this.database.query(
      "INSERT INTO memory_kins (id, discord_bot_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id WHERE memory_kins.discord_bot_id = EXCLUDED.discord_bot_id RETURNING id",
      [scope.kinId, scope.discordBotId]
    );
    if (!kin.rowCount) throw new Error("Kin identity does not match its registered Discord bot");
    await this.database.query(
      "INSERT INTO memory_contexts (kin_id, storyline, guild_id, channel_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING", values
    );
    return values;
  }

  async add(scope: MemoryScope, input: MemoryInput, userId: string): Promise<MemoryRecord> {
    const clean = validateMemory(input);
    const values = await this.bindScope(scope);
    const result = await this.database.query<MemoryRecord>(
      "INSERT INTO memories (kin_id, storyline, guild_id, channel_id, id, content, category, tags, importance, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *",
      [...values, randomUUID(), clean.content, clean.category, clean.tags, clean.importance, userId]
    );
    return result.rows[0];
  }

  async list(scope: MemoryScope, page = 1): Promise<MemoryRecord[]> {
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error("Invalid page");
    const values = await this.bindScope(scope);
    const result = await this.database.query<MemoryRecord>(
      `SELECT * FROM memories WHERE ${scopeWhere} ORDER BY created_at DESC, id LIMIT 10 OFFSET $5`,
      [...values, (page - 1) * 10]
    );
    return result.rows;
  }

  async show(scope: MemoryScope, id: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id)) return undefined;
    const values = await this.bindScope(scope);
    const result = await this.database.query<MemoryRecord>(`SELECT * FROM memories WHERE ${scopeWhere} AND id = $5`, [...values, id]);
    return result.rows[0];
  }

  async edit(scope: MemoryScope, id: string, input: MemoryInput, active: boolean, userId: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id)) return undefined;
    const clean = validateMemory(input);
    const values = await this.bindScope(scope);
    const result = await this.database.query<MemoryRecord>(
      `UPDATE memories SET content=$6, category=$7, tags=$8, importance=$9, active=$10, updated_by=$11, updated_at=now() WHERE ${scopeWhere} AND id=$5 RETURNING *`,
      [...values, id, clean.content, clean.category, clean.tags, clean.importance, active, userId]
    );
    return result.rows[0];
  }

  async delete(scope: MemoryScope, id: string): Promise<boolean> {
    if (!uuid.test(id)) return false;
    const values = await this.bindScope(scope);
    const result = await this.database.query(`DELETE FROM memories WHERE ${scopeWhere} AND id=$5`, [...values, id]);
    return result.rowCount === 1;
  }

  async retrieve(scope: MemoryScope, terms: string[]): Promise<MemoryRecord[]> {
    const values = await this.bindScope(scope);
    const result = await this.database.query<MemoryRecord>(
      `SELECT * FROM memories WHERE ${scopeWhere} AND active = true
       AND (importance = 5 OR EXISTS (
         SELECT 1 FROM unnest($5::text[]) AS term
         WHERE strpos(lower(content), term) > 0 OR term = ANY(tags)
       ))
       ORDER BY importance DESC, updated_at DESC, id LIMIT 5`,
      [...values, terms.slice(0, 20)]
    );
    return result.rows;
  }
}
