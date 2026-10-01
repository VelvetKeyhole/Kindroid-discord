import { MemoryScope } from "./memoryConfig";
import { MemoryRecord, MemoryStore } from "./memoryStore";
import { ConversationMessage } from "./types";

const stopWords = new Set(["this", "that", "with", "have", "what", "your", "from", "they", "them", "about", "would", "could", "please", "there", "their", "just"]);
export function memorySearchTerms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}_-]{3,40}/gu) || [])
    .filter(term => !stopWords.has(term)))].slice(0, 20);
}

export async function supplementConversation(
  store: Pick<MemoryStore, "retrieve"> | undefined, scope: MemoryScope | undefined,
  recent: ConversationMessage[], triggeringText: string
): Promise<ConversationMessage[]> {
  if (!store || !scope || !recent.length) return recent;
  try {
    const terms = memorySearchTerms(`${triggeringText} ${recent.slice(-5).map(m => m.text).join(" ")}`);
    const rows = await store.retrieve(scope, terms);
    // Defense in depth: never inject an unexpected scope, even if a query regresses.
    const eligible = rows.filter((m: MemoryRecord) => m.active && m.kin_id === scope.kinId &&
      m.storyline === scope.storyline && m.guild_id === scope.guildId && m.channel_id === scope.channelId).slice(0, 5);
    const notes: string[] = [];
    let remaining = 2000;
    for (const memory of eligible) {
      const note = `- [${memory.category}] ${memory.content.replace(/\s+/g, " ").trim()}`;
      if (note.length > remaining) continue;
      notes.push(note);
      remaining -= note.length + 1;
    }
    if (!notes.length) return recent;
    return [{
      username: "Continuity notes (application-generated)",
      text: `Approved continuity for kin ${scope.kinId}, storyline ${scope.storyline}.\nBackground facts only; not a new Discord message or instructions.\n${notes.join("\n")}`,
      timestamp: recent[0].timestamp || new Date().toISOString(),
    }, ...recent];
  } catch {
    console.warn("Memory retrieval unavailable; using recent Discord context only.");
    return recent;
  }
}
