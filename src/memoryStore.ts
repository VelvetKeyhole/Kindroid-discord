import { createHash, randomUUID } from "node:crypto";
import { Database } from "./database";
import { MemoryScope, resolvedContext } from "./memoryConfig";
import { MemoryMetadata, metadataFor, conflictHint } from "./memoryPolicy";
import { hasPublicLayer, layeredReadSql, layeredConflictsSql } from './memoryLayers';

export const memoryCategories = ["relationship", "conflict", "preference", "promise", "villa_event", "challenge_outcome", "personal_fact", "emotional_shift"] as const;
export type MemoryCategory = typeof memoryCategories[number];
export type MemoryStatus = "active" | "inactive" | "pending" | "rejected" | "superseded" | "archived";
export interface MemoryInput { content: string; category: MemoryCategory; tags: string[]; importance: number; metadata?: Partial<MemoryMetadata>;
  provenance?: { sourceChannelId: string; occurredAt: string; sourceMessageIds: string[]; subjects: string[] } }
export interface MemoryRecord extends MemoryInput {
  id: string; kin_id: string; storyline: string; guild_id: string; context_id: string; context_type: "channel" | "category";
  active: boolean; status: MemoryStatus; origin_kind: "manual" | "automatic";
  created_by: string; updated_by: string; created_at: Date; updated_at: Date;
  candidate_importance: number | null; confidence: number | null; subjects: string[];
  source_channel_id: string | null; occurred_at: Date | null; source_message_ids: string[];
  supersedes_id: string | null;
  metadata: MemoryMetadata; original_content: string; archived_from: MemoryStatus | null;
  edit_version?: string;
}
export class MemoryEditConflict extends Error {
  constructor() { super('Memory changed while this edit was being prepared. Inspect it again and retry.'); }
}
export interface MemoryCandidate {
  content: string; category: MemoryCategory; importance: number; confidence: number;
  subjects: string[]; sourceChannelId: string; occurredAt: string; sourceMessageIds: string[];
  metadata?: Partial<MemoryMetadata>;
}

const scopeWhere = "kin_id = $1 AND storyline = $2 AND guild_id = $3 AND context_id = $4 AND context_type = $5";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function scopeValues(scope: MemoryScope): string[] {
  const context = resolvedContext(scope);
  if (![scope.kinId, scope.storyline, scope.guildId, scope.channelId, scope.discordBotId, context.id].every(Boolean) ||
      !["channel", "category"].includes(context.type)) throw new Error("A complete memory scope is required");
  return [scope.kinId, scope.storyline, scope.guildId, context.id, context.type];
}

export function validateMemory(input: MemoryInput): MemoryInput {
  const content = input.content.trim();
  if (!content || content.length > 1000 || !memoryCategories.includes(input.category) ||
      !Number.isInteger(input.importance) || input.importance < 1 || input.importance > 5 ||
      input.tags.length > 10 || input.tags.some(tag => !tag.trim() || tag.length > 40)) {
    throw new Error("Use 1–1000 characters, a supported category, importance 1–5, and at most 10 tags of 1–40 characters.");
  }
  if (input.provenance && (!/^\d{17,20}$/.test(input.provenance.sourceChannelId) || !Number.isFinite(Date.parse(input.provenance.occurredAt)) ||
      input.provenance.sourceMessageIds.length>8 || input.provenance.sourceMessageIds.some(id=>!/^\d{17,20}$/.test(id)) ||
      input.provenance.subjects.length>10 || input.provenance.subjects.some(id=>!id || id.length>80))) throw new Error('Invalid source provenance');
  return { ...input, content, tags: [...new Set(input.tags.map(tag => tag.trim().toLowerCase()))] };
}

export function normalizedMemory(content: string): string {
  return content.replace(/^Reported statement by [^\n]{1,80}:\s*/i, "").replace(/^"|"$/g, "")
    .toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function substantiallyMatches(a: string, b: string): boolean {
  const left = normalizedMemory(a), right = normalizedMemory(b);
  if (left === right) return true;
  const tokensA = new Set(left.split(" ")), tokensB = new Set(right.split(" "));
  const markers = (tokens: Set<string>) => [...tokens].filter(t => /^\d+$/.test(t) ||
    ["not", "never", "no", "suspects", "suspect", "might", "maybe", "thinks", "jealous", "unsure"].includes(t)).sort().join(" ");
  if (markers(tokensA) !== markers(tokensB)) return false;
  const common = [...tokensA].filter(t => tokensB.has(t)).length;
  return common >= 4 && common / new Set([...tokensA, ...tokensB]).size >= 0.85;
}

export class MemoryStore {
  constructor(private readonly database: Database, private readonly inTransaction = false) {}

  async productionTransaction<T>(scope: MemoryScope, work: (store: MemoryStore) => Promise<T>): Promise<T> {
    return this.locked(scope, store => work(store));
  }

  private async bindScope(scope: MemoryScope): Promise<string[]> {
    const values = scopeValues(scope);
    const kin = await this.database.query(
      "INSERT INTO memory_kins (id, discord_bot_id) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id WHERE memory_kins.discord_bot_id = EXCLUDED.discord_bot_id RETURNING id",
      [scope.kinId, scope.discordBotId]
    );
    if (!kin.rowCount) throw new Error("Kin identity does not match its registered Discord bot");
    await this.database.query(
      "INSERT INTO memory_contexts (kin_id, storyline, guild_id, context_id, context_type) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", values
    );
    return values;
  }

  private async locked<T>(scope: MemoryScope, work: (store: MemoryStore, values: string[]) => Promise<T>): Promise<T> {
    if (this.inTransaction) return work(this, await this.bindScope(scope));
    if (!this.database.connect) throw new Error("Memory mutation requires a transactional database connection");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // Always lock in this order: kin binding, context, then individual memory rows.
      // Scope registration rolls back too when the mutation fails.
      const store = new MemoryStore(client, true);
      const values = await store.bindScope(scope);
      await client.query(`SELECT auto_enabled FROM memory_contexts WHERE ${scopeWhere} FOR UPDATE`, values);
      const result = await work(store, values);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve original failure. */ }
      throw error;
    } finally { client.release(); }
  }

  async add(scope: MemoryScope, input: MemoryInput, userId: string): Promise<MemoryRecord> {
    const clean = validateMemory(input);
    const metadata = metadataFor(scope.kinId, { visibility: scope.visibility ?? 'public', ...conflictHint(clean.content), ...input.metadata });
    return this.locked(scope, async (store, values) => (await store.database.query<MemoryRecord>(
      "INSERT INTO memories (kin_id,storyline,guild_id,context_id,context_type,id,content,category,tags,importance,created_by,updated_by,source_channel_id,occurred_at,metadata,status,active,change_type,source_message_ids,subjects) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$17::timestamptz,$13::jsonb,$14,$15,$16,$18,$19) RETURNING *",
      [...values, randomUUID(), clean.content, clean.category, clean.tags, clean.importance, userId, input.provenance?.sourceChannelId ?? scope.channelId,
        JSON.stringify(metadata),
        input.metadata?.sourceType === 'kindroid_export' || input.metadata?.sourceType === 'discord_import' ? 'pending' : 'active',
        !(input.metadata?.sourceType === 'kindroid_export' || input.metadata?.sourceType === 'discord_import'),
        input.metadata?.sourceType === 'kindroid_export' || input.metadata?.sourceType === 'discord_import' ? 'import' : 'add',
        input.provenance?.occurredAt ?? new Date().toISOString(),input.provenance?.sourceMessageIds ?? [],input.provenance?.subjects ?? []]
    )).rows[0]);
  }

  async list(scope: MemoryScope, page = 1, pendingOnly = false): Promise<MemoryRecord[]> {
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error("Invalid page");
    const values = await this.bindScope(scope);
    return (await this.database.query<MemoryRecord>(
      `SELECT * FROM memories WHERE ${scopeWhere}${pendingOnly ? " AND status = 'pending'" : " AND status <> 'archived'"} ORDER BY created_at DESC, id LIMIT 10 OFFSET $6`,
      [...values, (page - 1) * 10]
    )).rows;
  }

  async show(scope: MemoryScope, id: string, includeArchived = false): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id)) return undefined;
    const values = await this.bindScope(scope);
    return (await this.database.query<MemoryRecord>(`SELECT *, xmin::text AS edit_version FROM memories WHERE ${scopeWhere} AND id = $6${includeArchived ? '' : " AND status <> 'archived'"}`, [...values, id])).rows[0];
  }

  async edit(scope: MemoryScope, id: string, input: MemoryInput, active: boolean | undefined, userId: string, expectedVersion?: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id)) return undefined;
    const clean = validateMemory(input);
    return this.locked(scope, async (store, values) => {
      const existing = (await store.database.query<MemoryRecord>(
        `SELECT *, xmin::text AS edit_version FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values,id]
      )).rows[0];
      if (!existing) return undefined;
      if (expectedVersion !== undefined && existing.edit_version !== expectedVersion) throw new MemoryEditConflict();
      if (existing.status === 'archived') return undefined;
      const metadata = metadataFor(scope.kinId, { ...existing.metadata, ...(existing.content!==clean.content ? conflictHint(clean.content) : {}), ...input.metadata });
      return (await store.database.query<MemoryRecord>(
        `UPDATE memories SET content=$7,category=$8,tags=$9,importance=$10,
         active=CASE WHEN status IN ('active','inactive') THEN $11 ELSE false END,
         status=CASE WHEN status IN ('active','inactive') THEN CASE WHEN $11 THEN 'active' ELSE 'inactive' END ELSE status END,
         metadata=$13::jsonb,change_type=$14,change_reason=$15,
         updated_by=$12,updated_at=now() WHERE ${scopeWhere} AND id=$6 AND status <> 'archived' RETURNING *`,
        [...values, id, clean.content, clean.category, clean.tags, clean.importance, active ?? existing.active, userId, JSON.stringify(metadata),
          metadata.visibility !== existing.metadata.visibility || JSON.stringify(metadata.knownByKinIds) !== JSON.stringify(existing.metadata.knownByKinIds) ? 'visibility_change' : 'edit', null]
      )).rows[0];
    });
  }

  async delete(scope: MemoryScope, id: string, userId = 'system'): Promise<boolean> {
    if (!uuid.test(id)) return false;
    const values = await this.bindScope(scope);
    return (await this.database.query(`UPDATE memories SET archived_from=status,status='archived',active=false,change_type='archive',updated_by=$7,updated_at=now() WHERE ${scopeWhere} AND id=$6 AND status <> 'archived'`, [...values, id, userId])).rowCount === 1;
  }

  async retrieve(scope: MemoryScope, terms: string[], at = new Date()): Promise<MemoryRecord[]> {
    if (!Number.isFinite(at.getTime())) throw new Error('Invalid knowledge time');
    const values = await this.bindScope(scope);
    if (hasPublicLayer(scope)) return (await this.database.query<MemoryRecord>(layeredReadSql(),
      [...values,terms.slice(0,20),scope.visibility,at.toISOString(),scope.publicBase!.contextId,scope.publicBase!.contextType])).rows;
    return (await this.database.query<MemoryRecord>(
      `SELECT * FROM memories AS m WHERE ${scopeWhere} AND active = true AND status = 'active'
       AND memory_eligible(metadata,$1,$7,$8::timestamptz)
       AND NOT EXISTS (SELECT 1 FROM memories AS other WHERE other.id <> m.id AND other.kin_id=m.kin_id AND other.storyline=m.storyline
         AND other.guild_id=m.guild_id AND other.context_id=m.context_id AND other.context_type=m.context_type AND other.status='active'
         AND memory_eligible(other.metadata,$1,$7,$8::timestamptz) AND m.metadata->>'factKey' IS NOT NULL
         AND other.metadata->>'factKey'=m.metadata->>'factKey' AND other.metadata->>'assertion' IS DISTINCT FROM m.metadata->>'assertion')
       AND (importance = 5 OR EXISTS (
         SELECT 1 FROM unnest($6::text[]) AS term WHERE strpos(lower(content), term) > 0 OR term = ANY(tags)
       )) ORDER BY (metadata->>'pinned')::boolean DESC, importance DESC,
       CASE WHEN metadata->>'sourceType'='production_override' THEN 4 WHEN metadata->>'sourceType'='kindroid_export' AND (metadata->>'authoritative')::boolean THEN 3
         WHEN metadata->>'sourceType'='manual' THEN 2 ELSE 1 END DESC, updated_at DESC, id LIMIT 5`, [...values, terms.slice(0, 20), scope.visibility ?? 'public',at.toISOString()]
    )).rows;
  }

  async layeredSnapshot(scope: MemoryScope): Promise<MemoryRecord[]> {
    if (!hasPublicLayer(scope)) throw new Error('Layered snapshot requires a configured public base');
    const values = await this.bindScope(scope);
    const rows = (await this.database.query<MemoryRecord>(layeredReadSql(true),
      [...values,[],scope.visibility,new Date().toISOString(),scope.publicBase!.contextId,scope.publicBase!.contextType])).rows;
    if (rows.length>10000) throw new Error('Production review exceeds 10000 records; use paginated exports');
    return rows;
  }

  async autoSetting(scope: MemoryScope): Promise<boolean | null> {
    const values = await this.bindScope(scope);
    const result = await this.database.query<{ auto_enabled: boolean | null }>(`SELECT auto_enabled FROM memory_contexts WHERE ${scopeWhere}`, values);
    return result.rows[0]?.auto_enabled ?? null;
  }

  async setAutoSetting(scope: MemoryScope, enabled: boolean): Promise<void> {
    const values = await this.bindScope(scope);
    await this.database.query(`UPDATE memory_contexts SET auto_enabled=$6 WHERE ${scopeWhere}`, [...values, enabled]);
  }

  async createPending(scope: MemoryScope, candidate: MemoryCandidate): Promise<MemoryRecord | undefined> {
    if (!Number.isInteger(candidate.importance) || candidate.importance < 1 || candidate.importance > 10 ||
        !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1 ||
        candidate.sourceChannelId !== scope.channelId || !Number.isFinite(Date.parse(candidate.occurredAt)) ||
        candidate.subjects.length > 10 || candidate.subjects.some(s => !s || s.length > 80) ||
        candidate.sourceMessageIds.length > 8 || candidate.sourceMessageIds.some(id => !/^\d{17,20}$/.test(id))) {
      throw new Error("Invalid scoped memory candidate");
    }
    if (candidate.importance < 5) return undefined;
    const clean = validateMemory({ ...candidate, importance: Math.min(4, Math.ceil(candidate.importance / 2)), tags: [] });
    return this.locked(scope, async (store, values) => {
      const setting = await store.database.query<{ auto_enabled: boolean | null }>(`SELECT auto_enabled FROM memory_contexts WHERE ${scopeWhere}`, values);
      if (setting.rows[0]?.auto_enabled === false) return undefined;
      const existing = await store.database.query<MemoryRecord>(
        `SELECT * FROM memories WHERE ${scopeWhere} AND status IN ('active','pending','rejected','archived')`, values
      );
      const subjects = [...candidate.subjects].sort().join("\n");
      if (existing.rows.some(m => m.category === candidate.category &&
          (!m.subjects.length || [...m.subjects].sort().join("\n") === subjects) &&
          substantiallyMatches(m.content, clean.content))) return undefined;
      const fingerprint = createHash("sha256").update(`${candidate.category}:${normalizedMemory(clean.content)}`).digest("hex");
      return (await store.database.query<MemoryRecord>(
        `INSERT INTO memories (kin_id,storyline,guild_id,context_id,context_type,id,content,category,tags,importance,created_by,updated_by,
         active,status,origin_kind,candidate_importance,confidence,subjects,source_channel_id,occurred_at,source_message_ids,fingerprint,metadata,change_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,false,'pending','automatic',$12,$13,$14,$15,$16,$17,$18,$19::jsonb,'extract') RETURNING *`,
        [...values, randomUUID(), clean.content, clean.category, [], clean.importance, "automatic-extractor",
          candidate.importance, candidate.confidence, candidate.subjects, candidate.sourceChannelId,
          candidate.occurredAt, candidate.sourceMessageIds, fingerprint,
          JSON.stringify(metadataFor(scope.kinId, { visibility: scope.visibility && scope.visibility !== 'public' ? scope.visibility : 'private',
            sourceType: 'auto_extracted', statementType: 'reported_speech', knownAt: candidate.occurredAt, ...candidate.metadata }))]
      )).rows[0];
    });
  }

  async approve(scope: MemoryScope, id: string, userId: string, supersedesId?: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id) || (supersedesId && (!uuid.test(supersedesId) || supersedesId === id))) return undefined;
    return this.locked(scope, async (store, values) => {
      const candidate = (await store.database.query<MemoryRecord>(
        `SELECT * FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values, id]
      )).rows[0];
      if (!candidate || candidate.status !== "pending") return undefined;
      if (supersedesId) {
        const old = (await store.database.query<MemoryRecord>(
          `SELECT * FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values, supersedesId]
        )).rows[0];
        if (!old || old.status !== "active" || old.metadata.memoryType === 'event') throw new Error("Replacement must target an active non-event memory in this exact context");
        await store.database.query(
          `UPDATE memories SET status='superseded',active=false,change_type='supersede',updated_by=$7,updated_at=now() WHERE ${scopeWhere} AND id=$6 AND status='active'`,
          [...values, supersedesId, userId]
        );
      }
      return (await store.database.query<MemoryRecord>(
        `UPDATE memories SET status='active',active=true,change_type='approve',reviewed_by=$7,reviewed_at=now(),updated_by=$7,updated_at=now(),supersedes_id=$8
         WHERE ${scopeWhere} AND id=$6 AND status='pending' RETURNING *`, [...values, id, userId, supersedesId ?? null]
      )).rows[0];
    });
  }

  async reject(scope: MemoryScope, id: string, userId: string): Promise<boolean> {
    if (!uuid.test(id)) return false;
    const values = await this.bindScope(scope);
    return (await this.database.query(
      `UPDATE memories SET status='rejected',active=false,change_type='reject',reviewed_by=$7,reviewed_at=now(),updated_by=$7,updated_at=now()
       WHERE ${scopeWhere} AND id=$6 AND status='pending'`, [...values, id, userId]
    )).rowCount === 1;
  }

  async scan(scope: MemoryScope, page = 1): Promise<MemoryRecord[]> {
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new Error('Invalid export page');
    const values = await this.bindScope(scope);
    return (await this.database.query<MemoryRecord>(`SELECT * FROM memories WHERE ${scopeWhere} ORDER BY id LIMIT 1000 OFFSET $6`, [...values, (page - 1) * 1000])).rows;
  }
  async audit(scope: MemoryScope): Promise<{ operation: string; actor_id: string; reason: string | null; recorded_at: Date; memory_id: string }[]> {
    const values=await this.bindScope(scope);
    return (await this.database.query<{ operation: string; actor_id: string; reason: string | null; recorded_at: Date; memory_id: string }>(
      `SELECT operation,actor_id,reason,recorded_at,memory_id FROM memory_audit WHERE ${scopeWhere} ORDER BY id DESC LIMIT 1000`,values)).rows;
  }

  async history(scope: MemoryScope, id: string): Promise<{ id: string; snapshot: MemoryRecord; operation: string; actor_id: string; recorded_at: Date }[]> {
    if (!await this.show(scope, id, true)) return [];
    return (await this.database.query<{ id: string; snapshot: MemoryRecord; operation: string; actor_id: string; recorded_at: Date }>(
      'SELECT id,snapshot,operation,actor_id,recorded_at FROM memory_revisions WHERE memory_id=$1 ORDER BY id DESC LIMIT 100', [id]
    )).rows;
  }

  async restore(scope: MemoryScope, id: string, revisionId: string, actor: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id) || !/^\d+$/.test(revisionId)) return undefined;
    return this.locked(scope, async (store, values) => {
      const current = (await store.database.query<MemoryRecord>(`SELECT * FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values, id])).rows[0];
      if (!current) return undefined;
      const revision = (await store.database.query<{ snapshot: MemoryRecord }>('SELECT snapshot FROM memory_revisions WHERE memory_id=$1 AND id=$2', [id, revisionId])).rows[0];
      if (!revision) return undefined;
      const old = revision.snapshot;
      // Undo is deliberately inactive. Rejected candidates cannot bypass review via restore.
      const status = current.status === 'rejected' || current.archived_from === 'rejected' ? 'rejected' : current.origin_kind === 'automatic' || old.status === 'pending' ? 'pending' : 'inactive';
      return (await store.database.query<MemoryRecord>(`UPDATE memories SET content=$7,category=$8,tags=$9,importance=$10,
        metadata=$11::jsonb,status=$12,active=false,updated_by=$13,updated_at=now(),change_type='restore',change_reason=$14
        WHERE ${scopeWhere} AND id=$6 RETURNING *`, [...values, id, old.content, old.category, old.tags, old.importance,
        JSON.stringify(metadataFor(scope.kinId, old.metadata)), status, actor, `revision ${revisionId}`])).rows[0];
    });
  }

  async activate(scope: MemoryScope, id: string, actor: string): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id)) return undefined;
    return this.locked(scope, async (store, values) => {
      const current = (await store.database.query<MemoryRecord>(
        `SELECT * FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values, id]
      )).rows[0];
      if (!current || current.status !== 'inactive' || current.active !== false) return undefined;
      // An inactive record is absent from normal conflict scans. Check the conflict it
      // would introduce against active canon, without relaxing scope or privacy.
      if (current.metadata.factKey) {
        const conflict = await store.database.query(
          `SELECT id FROM memories WHERE ${scopeWhere} AND id<>$6 AND status='active'
           AND metadata->>'factKey'=$7 AND metadata->>'assertion' IS DISTINCT FROM $8::text LIMIT 1`,
          [...values, id, current.metadata.factKey, current.metadata.assertion ?? null]
        );
        if (conflict.rows.length) return undefined;
      }
      // Change only activation and audit fields. The existing triggers append revision/audit
      // history atomically; never copy metadata from a stale snapshot into this update.
      return (await store.database.query<MemoryRecord>(
        `UPDATE memories SET active=true,status='active',change_type='activate',change_reason=NULL,
         updated_by=$7,updated_at=now() WHERE ${scopeWhere} AND id=$6 AND status='inactive' AND active=false RETURNING *`,
        [...values, id, actor]
      )).rows[0];
    });
  }

  async retcon(scope: MemoryScope, id: string, content: string, actor: string, reason: string, correction: { factKey?: string; assertion?: string } = {}): Promise<MemoryRecord | undefined> {
    if (!uuid.test(id) || !reason.trim() || reason.length > 500) throw new Error('Retcons require a reason');
    return this.locked(scope, async (store, values) => {
      const old = (await store.database.query<MemoryRecord>(`SELECT * FROM memories WHERE ${scopeWhere} AND id=$6 FOR UPDATE`, [...values, id])).rows[0];
      if (!old || !['active','inactive'].includes(old.status)) return undefined;
      const clean = validateMemory({ ...old, content });
      const metadata = metadataFor(scope.kinId, { ...old.metadata, sourceType: 'production_override', authoritative: true,
        ...conflictHint(content),...correction });
      return (await store.database.query<MemoryRecord>(`UPDATE memories SET content=$7,metadata=$8::jsonb,updated_by=$9,updated_at=now(),
        change_type='retcon',change_reason=$10 WHERE ${scopeWhere} AND id=$6 RETURNING *`, [...values,id,clean.content,JSON.stringify(metadata),actor,reason])).rows[0];
    });
  }

  async merge(scope: MemoryScope, keepId: string, duplicateId: string, actor: string): Promise<boolean> {
    if (!uuid.test(keepId) || !uuid.test(duplicateId) || keepId === duplicateId) return false;
    return this.locked(scope, async (store, values) => {
      const rows = (await store.database.query<MemoryRecord>(`SELECT * FROM memories WHERE ${scopeWhere} AND id IN ($6,$7) ORDER BY id FOR UPDATE`, [...values, keepId, duplicateId])).rows;
      const keep = rows.find(m => m.id === keepId), duplicate = rows.find(m => m.id === duplicateId);
      if (!keep || !duplicate || keep.status !== 'active' || duplicate.status !== 'active' ||
          keep.metadata.visibility !== duplicate.metadata.visibility ||
          JSON.stringify([...keep.metadata.knownByKinIds].sort()) !== JSON.stringify([...duplicate.metadata.knownByKinIds].sort()) ||
          keep.metadata.domain !== duplicate.metadata.domain || keep.metadata.statementType !== duplicate.metadata.statementType ||
          keep.metadata.memoryType !== duplicate.metadata.memoryType ||
          (keep.metadata.expiresAt ?? null) !== (duplicate.metadata.expiresAt ?? null) || !substantiallyMatches(keep.content, duplicate.content)) throw new Error('Only equivalent memories with identical privacy/knowledge may merge');
      const metadata = metadataFor(scope.kinId, { ...keep.metadata,
        knownAt: new Date(Math.max(Date.parse(keep.metadata.knownAt),Date.parse(duplicate.metadata.knownAt))).toISOString(),
        mergedFrom: [...new Set([...(keep.metadata.mergedFrom ?? []),duplicate.id])] });
      await store.database.query(`UPDATE memories SET metadata=$7::jsonb,change_type='merge',change_reason=$8,updated_by=$9,updated_at=now() WHERE ${scopeWhere} AND id=$6`,
        [...values,keepId,JSON.stringify(metadata),duplicateId,actor]);
      await store.database.query(`UPDATE memories SET archived_from=status,status='archived',active=false,change_type='merge',change_reason=$7,updated_by=$8,updated_at=now() WHERE ${scopeWhere} AND id=$6`, [...values,duplicateId,keepId,actor]);
      return true;
    });
  }

  async conflicts(scope: MemoryScope): Promise<{ id: string; other_id: string; fact_key: string }[]> {
    const values = await this.bindScope(scope);
    if (hasPublicLayer(scope)) return (await this.database.query<{ id: string; other_id: string; fact_key: string }>(
      layeredConflictsSql(), [...values,[],scope.visibility,new Date().toISOString(),scope.publicBase!.contextId,scope.publicBase!.contextType]
    )).rows;
    return (await this.database.query<{ id: string; other_id: string; fact_key: string }>(`SELECT m.id,other.id AS other_id,m.metadata->>'factKey' AS fact_key
      FROM memories m JOIN memories other ON other.id>m.id AND other.kin_id=m.kin_id AND other.storyline=m.storyline
      AND other.guild_id=m.guild_id AND other.context_id=m.context_id AND other.context_type=m.context_type
      WHERE m.kin_id=$1 AND m.storyline=$2 AND m.guild_id=$3 AND m.context_id=$4 AND m.context_type=$5
      AND m.status='active' AND other.status='active' AND m.metadata->>'factKey' IS NOT NULL
      AND other.metadata->>'factKey'=m.metadata->>'factKey' AND other.metadata->>'assertion' IS DISTINCT FROM m.metadata->>'assertion' LIMIT 100`, values)).rows;
  }

  async archivePending(scope: MemoryScope, days: number, actor: string): Promise<number> {
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Invalid retention days');
    const values = await this.bindScope(scope);
    return (await this.database.query(`UPDATE memories SET archived_from=status,status='archived',active=false,
      change_type='archive',change_reason='pending retention',updated_by=$7,updated_at=now()
      WHERE ${scopeWhere} AND status='pending' AND created_at < now()-($6 * interval '1 day')`, [...values,days,actor])).rowCount ?? 0;
  }

  async flagSource(scope: MemoryScope, id: string, reason: string, actor: string): Promise<void> {
    const old = await this.show(scope,id,true);
    if (!old || reason.length > 200) throw new Error('Invalid source review');
    const values = await this.bindScope(scope);
    await this.database.query(`UPDATE memories SET metadata=jsonb_set(metadata,'{sourceDiscrepancy}',to_jsonb($7::text)),
      change_type='source_review',updated_by=$8,updated_at=now() WHERE ${scopeWhere} AND id=$6`, [...values,id,reason,actor]);
  }

  async setAlias(scope: MemoryScope, alias: string, subjectId: string, actor: string): Promise<void> {
    if (!alias.trim() || alias.length>80 || !/^[a-zA-Z0-9_-]{1,64}$/.test(subjectId)) throw new Error('Invalid alias');
    await this.locked(scope, async (store,values) => {
      await store.database.query('INSERT INTO memory_aliases VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (kin_id,storyline,guild_id,alias) DO UPDATE SET subject_id=EXCLUDED.subject_id,approved_by=EXCLUDED.approved_by',
        [scope.kinId,scope.storyline,scope.guildId,alias.trim().toLowerCase(),subjectId,actor]);
      await store.database.query("INSERT INTO memory_audit(kin_id,storyline,guild_id,context_id,context_type,operation,actor_id) VALUES ($1,$2,$3,$4,$5,'alias',$6)", [...values,actor]);
    });
  }
  async resolveAlias(scope: MemoryScope, alias: string): Promise<string | undefined> {
    await this.bindScope(scope);
    return (await this.database.query<{ subject_id: string }>('SELECT subject_id FROM memory_aliases WHERE kin_id=$1 AND storyline=$2 AND guild_id=$3 AND alias=$4',
      [scope.kinId,scope.storyline,scope.guildId,alias.trim().toLowerCase()])).rows[0]?.subject_id;
  }
  async rebindKin(scope: MemoryScope, oldBotId: string, newBotId: string, actor: string, reason: string): Promise<void> {
    if (scope.discordBotId !== oldBotId || !/^\d{17,20}$/.test(newBotId) || !reason.trim() || reason.length>500) throw new Error('Invalid identity transfer');
    await this.locked(scope, async (store) => {
      const changed = await store.database.query('UPDATE memory_kins SET discord_bot_id=$3 WHERE id=$1 AND discord_bot_id=$2', [scope.kinId,oldBotId,newBotId]);
      if (changed.rowCount !== 1) throw new Error('Previous bot binding did not match');
      await store.database.query('INSERT INTO memory_binding_history(kin_id,old_bot_id,new_bot_id,actor_id,reason) VALUES ($1,$2,$3,$4,$5)', [scope.kinId,oldBotId,newBotId,actor,reason]);
      await store.database.query("INSERT INTO memory_audit(kin_id,operation,actor_id,reason) VALUES ($1,'rebind',$2,$3)", [scope.kinId,actor,reason]);
    });
  }
}
