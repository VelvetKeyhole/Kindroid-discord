import { createHash } from 'node:crypto';
import { MemoryScope, resolvedContext } from './memoryConfig';
import { MemoryInput, MemoryRecord, MemoryStore, normalizedMemory, substantiallyMatches, validateMemory } from './memoryStore';
import { MemoryMetadata, metadataFor, privacyEligible, authority, conflictHint } from './memoryPolicy';

export interface ImportItem extends MemoryInput { id?: string; externalId?: string;
  source_channel_id?: string | null; occurred_at?: string | Date | null; source_message_ids?: string[];
  subjects?: string[]; original_content?: string; created_at?: string | Date; reviewed_at?: string | Date | null;
  created_by?: string; updated_by?: string; reviewed_by?: string | null }
// Original production actors remain provenance; the importer is the new record's creator.
export interface MemoryBundle {
  version: 1; scope: { kinId: string; storyline: string; guildId: string; contextType: string; contextId: string };
  source: 'kindroid_export' | 'discord_import'; namespace: string; authoritative: boolean;
  items: ImportItem[];
}
export interface ReconciliationItem { action: 'unchanged' | 'duplicate' | 'new' | 'changed' | 'conflict' | 'obsolete'; index?: number; existingId?: string; duplicateOfIndex?: number }
export interface ImportPreview { token: string; entries: ReconciliationItem[] }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const exportSafetyWarning = 'NOT PUBLICATION-SAFE: public-filtered records can retain confidential original, revision, and source metadata. Review/redact before sharing.';
function provenanceOf(item: ImportItem): MemoryInput['provenance'] {
  return item.provenance ?? (item.occurred_at && item.source_channel_id ? {
    sourceChannelId:item.source_channel_id,occurredAt:new Date(item.occurred_at).toISOString(),
    sourceMessageIds:item.source_message_ids ?? [],subjects:item.subjects ?? [] } : undefined);
}
function equivalentBatchItems(scope: MemoryScope, a: ImportItem, b: ImportItem): boolean {
  // Keep attribution intact and require matching governance/temporal meaning, not word overlap.
  const text = (item: ImportItem) => item.content.trim().normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
  const meaning = (item: ImportItem) => ({category:item.category,importance:item.importance,
    tags:[...validateMemory(item).tags].sort(), metadata:metadataFor(scope.kinId,{visibility:'private',knownAt:'1970-01-01T00:00:00Z',...item.metadata}),
    provenance:provenanceOf(item) ? {...provenanceOf(item),sourceMessageIds:[]} : undefined,
    original:item.original_content,created:item.created_at,reviewed:item.reviewed_at,creator:item.created_by,editor:item.updated_by,approver:item.reviewed_by});
  const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry==='object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key=>[key,entry[key]])) : entry);
  return text(a)===text(b) && stable(meaning(a))===stable(meaning(b));
}
export function readableCanon(scope: MemoryScope, rows: MemoryRecord[]): string {
  const groups=['state','relationship','preference','fact','belief','event'];
  return `${scope.kinId} — ${scope.storyline} — Current Canon\nContext: ${resolvedContext(scope).type}:${resolvedContext(scope).id}\n\n`+
    groups.map(type=>{
      const notes=rows.filter(m=>m.metadata.memoryType===type);
      return notes.length ? `${type.toUpperCase()}\n${notes.map(m=>`- ${m.metadata.pinned?'[pinned] ':''}[${m.metadata.statementType}] ${m.content}`).join('\n')}` : '';
    }).filter(Boolean).join('\n\n');
}
export function bundleScope(scope: MemoryScope): MemoryBundle['scope'] {
  const context = resolvedContext(scope);
  return { kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,contextType:context.type,contextId:context.id };
}
function validateBundle(scope: MemoryScope, value: MemoryBundle): void {
  if (value.version !== 1 || !value.scope || Object.entries(bundleScope(scope)).some(([key,entry])=>value.scope[key as keyof MemoryBundle['scope']]!==entry) ||
      !['kindroid_export','discord_import'].includes(value.source) || !/^[a-zA-Z0-9_-]{1,80}$/.test(value.namespace) ||
      typeof value.authoritative !== 'boolean' || !Array.isArray(value.items) || value.items.length>1000) throw new Error('Invalid import scope or bundle');
  const keys = new Set<string>();
  for (const item of value.items) {
    validateMemory(item); metadataFor(scope.kinId, item.metadata);
    for (const date of [item.created_at,item.reviewed_at,item.occurred_at]) if (date && !Number.isFinite(new Date(date).getTime())) throw new Error('Invalid import provenance time');
    if (item.original_content && item.original_content.length>1000) throw new Error('Original content too long');
    if (item.source_channel_id) validateMemory({...item,provenance:{sourceChannelId:item.source_channel_id,
      occurredAt:item.occurred_at ? new Date(item.occurred_at).toISOString() : new Date().toISOString(),
      sourceMessageIds:item.source_message_ids ?? [],subjects:item.subjects ?? []}});
    if (item.id && !/^[a-f0-9-]{36}$/i.test(item.id)) throw new Error('Invalid round-trip ID');
    if (!item.id && !item.externalId) throw new Error('Each imported item needs a stable externalId');
    if (item.externalId && (!/^[a-zA-Z0-9_-]{1,100}$/.test(item.externalId) || keys.has(item.externalId))) throw new Error('Duplicate/invalid external key');
    if (item.externalId) keys.add(item.externalId);
  }
}
export class MemoryProduction {
  constructor(private readonly store: MemoryStore) {}
  private async all(scope: MemoryScope): Promise<MemoryRecord[]> {
    const rows: MemoryRecord[]=[];
    for (let page=1;page<=11;page++) {
      const batch=await this.store.scan(scope,page);
      rows.push(...batch);
      if (rows.length>10000) throw new Error('Production review exceeds 10000 records; use paginated exports');
      if (batch.length<1000) return rows;
    }
    throw new Error('Production review limit exceeded');
  }

  async export(scope: MemoryScope, filter: { page?: number; status?: string; visibility?: string; from?: string; until?: string } = {}): Promise<{ bundle: MemoryBundle; readable: string; warning: string }> {
    for (const time of [filter.from,filter.until]) if (time && !Number.isFinite(Date.parse(time))) throw new Error('Invalid date filter');
    const rows = (await this.store.scan(scope,filter.page)).filter(m => (!filter.status || m.status===filter.status) &&
      (!filter.visibility || m.metadata.visibility===filter.visibility) && (!filter.from || m.created_at>=new Date(filter.from)) &&
      (!filter.until || m.created_at<=new Date(filter.until)));
    return { warning:exportSafetyWarning, bundle: { version:1,scope:bundleScope(scope),source:'kindroid_export',namespace:'production_roundtrip',authoritative:false,
      items: rows.map(m => ({ ...m, id:m.id,metadata:{...m.metadata}, externalId:m.id })) },
      readable: `${exportSafetyWarning}\n\n`+rows.map(m => `${m.id} | ${m.status} | ${m.metadata.visibility} | ${m.metadata.memoryType}\n${m.content}`).join('\n\n') };
  }

  async preview(scope: MemoryScope, bundle: MemoryBundle): Promise<ImportPreview> {
    validateBundle(scope,bundle);
    const existing = await this.all(scope);
    const entries: ReconciliationItem[] = [], seen = new Set<string>();
    for (let index=0;index<bundle.items.length;index++) {
      const item = bundle.items[index];
      const staged=existing.find(m=>m.status==='pending' && m.metadata.importNamespace===bundle.namespace &&
        (m.metadata.externalId===(item.externalId ?? item.id) || m.metadata.importAliases?.includes(item.externalId ?? item.id ?? '')) && normalizedMemory(m.content)===normalizedMemory(item.content) &&
        m.metadata.visibility===(item.metadata?.visibility ?? 'private') && m.metadata.authoritative===bundle.authoritative &&
        (!item.metadata || Object.entries(item.metadata).every(([key,value])=>JSON.stringify(m.metadata[key as keyof MemoryMetadata])===JSON.stringify(value))));
      if (staged) { seen.add(staged.id); entries.push({index,existingId:staged.id,action:'duplicate'}); continue; }
      let match = item.id ? existing.find(m=>m.id===item.id) : undefined;
      if (item.id && !match) throw new Error('Round-trip ID does not exist in the selected scope');
      if (!match && item.externalId) match = existing.find(m=>m.metadata.importNamespace===bundle.namespace && (m.metadata.externalId===item.externalId || m.metadata.importAliases?.includes(item.externalId!)));
      if (match) {
        seen.add(match.id);
        const same = normalizedMemory(match.content)===normalizedMemory(item.content) &&
          (!item.metadata || Object.entries(item.metadata).every(([key,value])=>JSON.stringify(match!.metadata[key as keyof MemoryMetadata])===JSON.stringify(value)));
        entries.push({ index, existingId:match.id, action:same ? 'unchanged' : bundle.authoritative ? 'changed' : 'conflict' });
        continue;
      }
      const metadata = metadataFor(scope.kinId,{...conflictHint(item.content),...item.metadata});
      match = existing.find(m => m.category===item.category && m.metadata.visibility===metadata.visibility &&
        m.metadata.domain===metadata.domain && m.metadata.statementType===metadata.statementType &&
        m.metadata.speakerId===metadata.speakerId && (m.metadata.expiresAt ?? null)===(metadata.expiresAt ?? null) &&
        JSON.stringify([...m.metadata.knownByKinIds].sort())===JSON.stringify([...metadata.knownByKinIds].sort()) && substantiallyMatches(m.content,item.content));
      if (match) { seen.add(match.id); entries.push({ index, existingId:match.id,action:'duplicate' }); }
      else {
        const conflict = existing.find(m => m.status==='active' && metadata.factKey && m.metadata.factKey===metadata.factKey && m.metadata.assertion!==metadata.assertion);
        entries.push({ index,existingId:conflict?.id,action:conflict ? 'conflict' : 'new' });
      }
    }
    // Compare prospective new candidates with each other, without collapsing different correction targets.
    for (const entry of entries) {
      if (entry.index===undefined || !['new','changed','conflict'].includes(entry.action)) continue;
      const prior = entries.find(other=>other.index!==undefined && other.index<entry.index! && other.action===entry.action &&
        other.existingId===entry.existingId && equivalentBatchItems(scope,bundle.items[other.index],bundle.items[entry.index!]));
      if (!prior || prior.index===undefined) continue;
      const group=entries.filter(e=>e.index===prior.index || e.duplicateOfIndex===prior.index).map(e=>bundle.items[e.index!]);
      const messageIds=new Set([...group,bundle.items[entry.index]].flatMap(i=>provenanceOf(i)?.sourceMessageIds ?? []));
      if (messageIds.size>8) continue; // Preserve both candidates rather than truncate evidence.
      entry.action='duplicate'; entry.duplicateOfIndex=prior.index;
    }
    for (const m of existing) if (m.metadata.importNamespace===bundle.namespace && !seen.has(m.id) && !bundle.items.some(i=>i.externalId===m.metadata.externalId)) {
      entries.push({ action:'obsolete',existingId:m.id });
    }
    return { token:hash({ scope:bundleScope(scope),bundle,existing }),entries };
  }

  async stage(scope: MemoryScope, bundle: MemoryBundle, token: string, actor: string): Promise<string[]> {
    return this.store.productionTransaction(scope, store=>new MemoryProduction(store).stageLocked(scope,bundle,token,actor));
  }
  private async stageLocked(scope: MemoryScope, bundle: MemoryBundle, token: string, actor: string): Promise<string[]> {
    const preview = await this.preview(scope,bundle);
    if (preview.token!==token) throw new Error('Preview is stale or import changed; preview again');
    const ids: string[] = [];
    // The complete staging batch is transactional; never replace canon or act on omissions.
    for (const entry of preview.entries) {
      if (entry.index===undefined || !['new','changed','conflict'].includes(entry.action)) continue;
      const item = bundle.items[entry.index];
      const duplicates=preview.entries.filter(e=>e.duplicateOfIndex===entry.index).map(e=>bundle.items[e.index!]);
      const metadata = metadataFor(scope.kinId,{ visibility:'private',...item.metadata,
        sourceType:bundle.source,authoritative:bundle.authoritative,importNamespace:bundle.namespace,
        externalId:item.externalId ?? item.id, revealOf:item.metadata?.revealOf,
        importAliases:[...new Set([...(item.metadata?.importAliases ?? []),...duplicates.flatMap(i=>[i.externalId ?? i.id ?? '',...(i.metadata?.importAliases ?? [])]).filter(Boolean)])],
        originalSourceType:item.metadata?.originalSourceType ?? item.metadata?.sourceType,
        importOriginalContent:item.original_content ?? item.metadata?.importOriginalContent,
        sourceCreatedBy:item.created_by ?? item.metadata?.sourceCreatedBy,
        sourceApprovedBy:item.reviewed_by ?? item.metadata?.sourceApprovedBy,
        sourceEditedBy:item.updated_by ?? item.metadata?.sourceEditedBy,
        sourceCreatedAt:item.created_at ? new Date(item.created_at).toISOString() : item.metadata?.sourceCreatedAt,
        sourceApprovedAt:item.reviewed_at ? new Date(item.reviewed_at).toISOString() : item.metadata?.sourceApprovedAt });
      const originalProvenance=provenanceOf(item);
      const provenance=originalProvenance ? {...originalProvenance,sourceMessageIds:[...new Set([item,...duplicates].flatMap(i=>provenanceOf(i)?.sourceMessageIds ?? []))]} : undefined;
      const saved = await this.store.add(scope,{...item,metadata,provenance},actor);
      ids.push(saved.id);
    }
    return ids;
  }

  async snapshot(scope: MemoryScope): Promise<MemoryRecord[]> {
    const rows = (await this.all(scope)).filter(m=>m.status==='active' && privacyEligible(m.metadata,scope.kinId,scope.visibility));
    const ids = new Set(rows.map(m=>m.id));
    const conflicts = await this.store.conflicts(scope);
    const blocked = new Set(conflicts.filter(c=>ids.has(c.id)&&ids.has(c.other_id)).flatMap(c=>[c.id,c.other_id]));
    return rows.filter(m=>!blocked.has(m.id)).sort((a,b)=>Number(b.metadata.pinned)-Number(a.metadata.pinned)||b.importance-a.importance||authority(b.metadata)-authority(a.metadata));
  }
}
