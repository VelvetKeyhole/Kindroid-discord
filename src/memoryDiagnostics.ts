import { randomUUID } from "node:crypto";
import { MemoryScope, resolvedContext } from "./memoryConfig";
import { MemoryRecord } from "./memoryStore";
import { memoryScopeEligible, memoryLayerPrivacyEligible } from './memoryLayers';
import { ConversationMessage } from "./types";

const testMemoryId = "21e4ad40-d5d6-4cfb-9b44-d238223887be";
type Exclusion = "status" | "scope" | "visibility" | "expired" | "future knowledge" | "note budget" | "record limit" | null;
interface DiagnosticMemory {
  uuid: string; active: boolean; status: string;
  activeStatusEligible: boolean; scopeEligible: boolean; visibilityEligible: boolean;
  included: boolean; exclusionReason: Exclusion;
}
export interface MemoryDiagnostic {
  requestId: string;
  kinId: string | null;
  scope?: MemoryScope;
  retrievalOutcome: "not attempted" | "returned" | "failed";
  memories: DiagnosticMemory[];
  injectedMemoryCount: number;
  noteCharacters: number;
  block?: ConversationMessage;
}

export function createMemoryDiagnostic(kinId?: string): MemoryDiagnostic | undefined {
  if (process.env.MEMORY_DEBUG_ENABLED?.toLowerCase() !== "true") return undefined;
  return { requestId: randomUUID().replace(/-/g, "").slice(0, 12), kinId: kinId ?? null,
    retrievalOutcome: "not attempted", memories: [], injectedMemoryCount: 0, noteCharacters: 0 };
}

export function recordMemoryCandidates(
  diagnostic: MemoryDiagnostic | undefined, scope: MemoryScope, rows: MemoryRecord[],
  eligible: MemoryRecord[], included: Set<MemoryRecord>
): void {
  if (!diagnostic) return;
  diagnostic.retrievalOutcome = "returned";
  diagnostic.memories = rows.map(memory => {
    const activeStatusEligible = memory.active && memory.status === "active";
    const scopeEligible = memoryScopeEligible(scope,memory);
    const visibilityEligible = memoryLayerPrivacyEligible(scope,memory);
    const injected = included.has(memory);
    let exclusionReason: Exclusion = null;
    if (!injected) {
      if (!activeStatusEligible) exclusionReason = "status";
      else if (!scopeEligible) exclusionReason = "scope";
      else if (!visibilityEligible) {
        const now = Date.now();
        exclusionReason = memory.metadata?.expiresAt && Date.parse(memory.metadata.expiresAt) <= now ? "expired"
          : Date.parse(memory.metadata?.knownAt) > now ? "future knowledge" : "visibility";
      } else exclusionReason = eligible.includes(memory) ? "note budget" : "record limit";
    }
    // Explicit field allowlist: never retain a record, its text, metadata, or an error object.
    return { uuid: memory.id, active: memory.active, status: memory.status,
      activeStatusEligible, scopeEligible, visibilityEligible, included: injected, exclusionReason };
  });
  diagnostic.injectedMemoryCount = included.size;
}

export function logMemoryDiagnostic(diagnostic: MemoryDiagnostic | undefined, outgoing: ConversationMessage[]): void {
  if (!diagnostic || process.env.MEMORY_DEBUG_ENABLED?.toLowerCase() !== "true") return;
  const scope = diagnostic.scope;
  const context = scope ? resolvedContext(scope) : undefined;
  const index = diagnostic.block ? outgoing.indexOf(diagnostic.block) : -1;
  try { console.info("[MEMORY_DIAG] " + JSON.stringify({
    requestId: diagnostic.requestId, kinId: scope?.kinId ?? diagnostic.kinId, storyline: scope?.storyline ?? null,
    contextType: context?.type ?? null, contextId: context?.id ?? null, visibility: scope?.visibility ?? (scope ? "public" : null),
    retrievalOutcome: diagnostic.retrievalOutcome,
    candidateCount: diagnostic.retrievalOutcome === "returned" ? diagnostic.memories.length : null,
    returnedMemoryUuids: diagnostic.memories.map(memory => memory.uuid),
    testMemoryReturned: diagnostic.memories.some(memory => memory.uuid === testMemoryId),
    memories: diagnostic.memories, injectedMemoryCount: diagnostic.injectedMemoryCount,
    continuityNoteCharacters: diagnostic.noteCharacters, continuityBlockExists: index !== -1,
    continuityBlockIndex: index === -1 ? null : index, outgoingConversationEntries: outgoing.length,
  })); } catch { /* Diagnostic logging must never prevent a normal reply. */ }
}
