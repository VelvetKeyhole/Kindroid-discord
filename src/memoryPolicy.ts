export const visibilities = ['public', 'private', 'confessional', 'production'] as const;
export type Visibility = typeof visibilities[number];
export const memoryTypes = ['event', 'state', 'fact', 'preference', 'relationship', 'belief'] as const;
export const statementTypes = ['fact', 'belief', 'suspicion', 'claim', 'interpretation', 'reported_speech'] as const;
export const sourceTypes = ['manual', 'auto_extracted', 'discord_import', 'kindroid_export', 'production_override'] as const;
export interface MemoryMetadata {
  visibility: Visibility; knownByKinIds: string[]; knownAt: string;
  memoryType: typeof memoryTypes[number]; statementType: typeof statementTypes[number];
  sourceType: typeof sourceTypes[number]; domain: 'identity' | 'continuity';
  pinned: boolean; authoritative: boolean; speakerId?: string; speakerName?: string;
  expiresAt?: string | null; revealOf?: string; factKey?: string; assertion?: string;
  importNamespace?: string; externalId?: string; sourceSnapshot?: string;
  mergedFrom?: string[]; sourceDiscrepancy?: string;
  originalSourceType?: string; sourceCreatedAt?: string; sourceApprovedAt?: string; importOriginalContent?: string;
  sourceCreatedBy?: string; sourceApprovedBy?: string; sourceEditedBy?: string;
  importAliases?: string[];
}
export function metadataFor(kinId: string, input: Partial<MemoryMetadata> = {}): MemoryMetadata {
  const value: MemoryMetadata = { visibility: 'public', knownByKinIds: [kinId], knownAt: new Date().toISOString(),
    memoryType: 'fact', statementType: 'claim', sourceType: 'manual', domain: 'continuity', pinned: false, authoritative: false, ...input };
  if (value.visibility==='production' && input.knownByKinIds===undefined) value.knownByKinIds=[];
  if (!visibilities.includes(value.visibility) || !memoryTypes.includes(value.memoryType) ||
      !statementTypes.includes(value.statementType) || !sourceTypes.includes(value.sourceType) ||
      !['identity','continuity'].includes(value.domain) || typeof value.pinned !== 'boolean' || typeof value.authoritative !== 'boolean' ||
      !Array.isArray(value.knownByKinIds) || (value.visibility!=='production' && !value.knownByKinIds.includes(kinId)) || value.knownByKinIds.length > 20 ||
      value.knownByKinIds.some(id => !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) || !Number.isFinite(Date.parse(value.knownAt)) ||
      (value.expiresAt && (!Number.isFinite(Date.parse(value.expiresAt)) || value.memoryType === 'event'))) throw new Error('Invalid memory metadata');
  for (const key of ['speakerId','speakerName','revealOf','factKey','assertion','importNamespace','externalId','sourceDiscrepancy','sourceCreatedBy','sourceApprovedBy','sourceEditedBy'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key]!.length > 200)) throw new Error('Invalid memory metadata field');
  }
  if (value.sourceSnapshot && value.sourceSnapshot.length > 6000) throw new Error('Source snapshot too long');
  if (value.importOriginalContent && value.importOriginalContent.length>1000) throw new Error('Original import content too long');
  if (value.originalSourceType && !sourceTypes.includes(value.originalSourceType as typeof sourceTypes[number])) throw new Error('Invalid original source');
  for (const date of [value.sourceCreatedAt,value.sourceApprovedAt]) if (date && !Number.isFinite(Date.parse(date))) throw new Error('Invalid provenance time');
  if (value.mergedFrom && (value.mergedFrom.length > 100 || value.mergedFrom.some(id => !/^[a-f0-9-]{36}$/i.test(id)))) throw new Error('Invalid merge links');
  if (value.importAliases && (value.importAliases.length>1000 || value.importAliases.some(id=>!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))) throw new Error('Invalid import aliases');
  return value;
}
export function privacyEligible(meta: MemoryMetadata | undefined, kin: string, visibility: Visibility = 'public', at = new Date()): boolean {
  if (!meta || visibility === 'production' || meta.visibility === 'production' || !meta.knownByKinIds?.includes(kin)) return false;
  const known = Date.parse(meta.knownAt), expiry = meta.expiresAt ? Date.parse(meta.expiresAt) : Infinity;
  return Number.isFinite(known) && known <= at.getTime() && expiry > at.getTime() &&
    (meta.visibility === 'public' || meta.visibility === visibility);
}
export function authority(meta: MemoryMetadata): number {
  return meta.sourceType === 'production_override' ? 4 : meta.authoritative && meta.sourceType === 'kindroid_export' ? 3 : meta.sourceType === 'manual' ? 2 : 1;
}
// Deliberately narrow: a review hint, not semantic truth inference.
export function conflictHint(content: string): { factKey?: string; assertion?: string } {
  const text = content.toLowerCase();
  const negative = text.match(/\b([a-z]+) (?:hates|dislikes) ([a-z]+)\b/);
  const positive = text.match(/\b([a-z]+)(?:'s favorite (?:liquor|food|drink) is| loves| likes) ([a-z]+)\b/);
  const match = negative || positive;
  return match ? { factKey: `preference:${match[1]}:${match[2]}`, assertion: negative ? 'dislikes' : 'likes' } : {};
}
