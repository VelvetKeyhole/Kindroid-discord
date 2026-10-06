import { MemoryScope, resolvedContext } from './memoryConfig';
import { MemoryRecord } from './memoryStore';
import { privacyEligible } from './memoryPolicy';

export function hasPublicLayer(scope: MemoryScope): boolean {
  return resolvedContext(scope).type === 'channel' && ['private','confessional'].includes(scope.visibility ?? 'public') &&
    scope.publicBaseStatus === 'configured' && !!scope.publicBase;
}
export function memoryScopeEligible(scope: MemoryScope, memory: MemoryRecord): boolean {
  if (memory.kin_id !== scope.kinId || memory.storyline !== scope.storyline || memory.guild_id !== scope.guildId) return false;
  const local = resolvedContext(scope);
  return (memory.context_id === local.id && memory.context_type === local.type) ||
    (hasPublicLayer(scope) && memory.context_id === scope.publicBase!.contextId && memory.context_type === scope.publicBase!.contextType);
}
export function memoryLayerPrivacyEligible(scope: MemoryScope, memory: MemoryRecord, at = new Date()): boolean {
  const local = resolvedContext(scope);
  const isLocal = memory.context_id === local.id && memory.context_type === local.type;
  return privacyEligible(memory.metadata, scope.kinId, isLocal ? scope.visibility : 'public', at);
}
// Both reply and snapshot use this single merged query. Conflict checks see all eligible
// records before keyword filtering; private rows in the base are never admitted.
function eligibleLayersSql(): string {
  return `WITH eligible AS (
    SELECT * FROM memories WHERE kin_id=$1 AND storyline=$2 AND guild_id=$3 AND active=true AND status='active'
    AND ((context_id=$4 AND context_type=$5 AND memory_eligible(metadata,$1,$7,$8::timestamptz))
      OR (context_id=$9 AND context_type=$10 AND metadata->>'visibility'='public'
        AND memory_eligible(metadata,$1,'public',$8::timestamptz)))
  )`;
}
export function layeredConflictsSql(): string {
  return `${eligibleLayersSql()} SELECT m.id,other.id AS other_id,m.metadata->>'factKey' AS fact_key
    FROM eligible m JOIN eligible other ON other.id>m.id AND m.metadata->>'factKey' IS NOT NULL
      AND other.metadata->>'factKey'=m.metadata->>'factKey'
      AND other.metadata->>'assertion' IS DISTINCT FROM m.metadata->>'assertion'
    WHERE $6::text[] IS NOT NULL LIMIT 100`;
}
export function layeredReadSql(snapshot = false): string {
  const order = (alias: string) => `(${alias}.metadata->>'pinned')::boolean DESC, ${alias}.importance DESC,
    CASE WHEN ${alias}.metadata->>'sourceType'='production_override' THEN 4
      WHEN ${alias}.metadata->>'sourceType'='kindroid_export' AND (${alias}.metadata->>'authoritative')::boolean THEN 3
      WHEN ${alias}.metadata->>'sourceType'='manual' THEN 2 ELSE 1 END DESC, ${alias}.updated_at DESC, ${alias}.id`;
  // Exact normalized full text plus semantic classification. No fuzzy/attribution stripping.
  // Events and attributed statements also retain their distinct occurrence time/subjects.
  const logicalKey = `jsonb_build_array(trim(regexp_replace(lower(m.content),'[[:space:]]+',' ','g')),m.category,
    m.metadata->>'memoryType',m.metadata->>'statementType',m.metadata->>'domain',
    m.metadata->>'speakerId',m.metadata->>'speakerName',m.metadata->>'factKey',m.metadata->>'assertion',m.metadata->>'expiresAt',
    CASE WHEN m.metadata->>'memoryType' IN ('event','belief')
      OR m.metadata->>'statementType' IN ('reported_speech','belief','suspicion','interpretation')
      OR m.metadata->>'speakerId' IS NOT NULL OR m.metadata->>'speakerName' IS NOT NULL
      THEN jsonb_build_array(m.occurred_at,m.subjects) ELSE NULL END)`;
  return `${eligibleLayersSql()}, relevant AS (
    SELECT m.* FROM eligible m WHERE NOT EXISTS (SELECT 1 FROM eligible other WHERE other.id<>m.id
      AND m.metadata->>'factKey' IS NOT NULL AND other.metadata->>'factKey'=m.metadata->>'factKey'
      AND other.metadata->>'assertion' IS DISTINCT FROM m.metadata->>'assertion')
    AND (${snapshot ? 'cardinality($6::text[]) >= 0' : `m.importance=5 OR EXISTS (SELECT 1 FROM unnest($6::text[]) AS term
      WHERE strpos(lower(m.content),term)>0 OR term=ANY(m.tags))`})
  ), ranked AS (
    SELECT m.id,row_number() OVER (PARTITION BY ${logicalKey} ORDER BY ${order('m')}) AS duplicate_rank FROM relevant m
  ) SELECT m.* FROM relevant m JOIN ranked r ON r.id=m.id WHERE r.duplicate_rank=1
    ORDER BY ${order('m')} LIMIT ${snapshot ? 10001 : 5}`;
}
