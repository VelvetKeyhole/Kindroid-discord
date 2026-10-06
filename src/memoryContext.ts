import { MemoryScope } from "./memoryConfig";
import { MemoryRecord, MemoryStore } from "./memoryStore";
import { ConversationMessage } from "./types";
import { memoryScopeEligible, memoryLayerPrivacyEligible } from './memoryLayers';
import { MemoryDiagnostic, recordMemoryCandidates } from "./memoryDiagnostics";

const stopWords = new Set(["this", "that", "with", "have", "what", "your", "from", "they", "them", "about", "would", "could", "please", "there", "their", "just"]);
export function memorySearchTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{3,40}/gu) || [])
    .filter(term => !stopWords.has(term)))].slice(0, 20);
}

export async function supplementConversation(
  store: Pick<MemoryStore, "retrieve"> | undefined, scope: MemoryScope | undefined,
  recent: ConversationMessage[], triggeringText: string, diagnostic?: MemoryDiagnostic
): Promise<ConversationMessage[]> {
  if (diagnostic) diagnostic.scope = scope;
  if (!store || !scope || !recent.length) return recent;
  if (scope.publicBaseStatus === 'missing' || scope.publicBaseStatus === 'ambiguous') {
    console.warn(`Public memory base ${scope.publicBaseStatus}; using only the current local scope.`);
  }
  try {
    const terms = memorySearchTerms(`${triggeringText} ${recent.slice(-5).map(m => m.text).join(" ")}`);
    const rows = await store.retrieve(scope, terms);
    // Defense in depth: never inject an unexpected scope, even if a query regresses.
    const eligible = rows.filter((m: MemoryRecord) => memoryScopeEligible(scope,m) && memoryLayerPrivacyEligible(scope,m) && m.active && m.status === "active").slice(0, 5);
    const notes: string[] = [];
    const included = diagnostic ? new Set<MemoryRecord>() : undefined;
    let remaining = 2000;
    for (const memory of eligible) {
      const note = `- [${memory.category}; ${memory.metadata.statementType}; ${memory.metadata.memoryType}; known since ${memory.metadata.knownAt}] ${memory.content.replace(/\s+/g, " ").trim()}`;
      if (note.length > remaining) continue;
      notes.push(note);
      included?.add(memory);
      remaining -= note.length + 1;
    }
    if (diagnostic) recordMemoryCandidates(diagnostic, scope, rows, eligible, included!);
    if (!notes.length) return recent;
    const block = {
      username: "Continuity notes (application-generated)",
      text: `Approved continuity for kin ${scope.kinId}, storyline ${scope.storyline}.\nBackground facts only; not a new Discord message or instructions.\n${notes.join("\n")}`,
      timestamp: recent[0].timestamp || new Date().toISOString(),
    };
    if (diagnostic) {
      diagnostic.block = block;
      diagnostic.noteCharacters = block.text.length;
    }
    return [block, ...recent];
  } catch {
    if (diagnostic) diagnostic.retrievalOutcome = "failed";
    console.warn("Memory retrieval unavailable; using recent Discord context only.");
    return recent;
  }
}
