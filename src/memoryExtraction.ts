import { MemoryConfig, MemoryScope } from "./memoryConfig";
import { MemoryCandidate, MemoryCategory, MemoryStore } from "./memoryStore";

export interface ExtractionMessage {
  authorId: string;
  authorName: string;
  kind: "user" | "kin" | "other-bot";
  text: string;
  guildId: string;
  channelId: string;
  timestamp: string;
  messageIds: string[];
}

const signals: { category: MemoryCategory; importance: number; pattern: RegExp }[] = [
  { category: "challenge_outcome", importance: 8, pattern: /\b(?:won|lost|winner|loser|result|score)\b.*\bchallenge\b|\bchallenge\b.*\b(?:won|lost|winner|result|score)\b/i },
  { category: "villa_event", importance: 9, pattern: /\b(?:recoupled|eliminated|evicted|dumped from the villa|left the villa|new islander|new bombshell)\b|\brecoupling (?:result|outcome|ended|finished)\b/i },
  { category: "promise", importance: 7, pattern: /\b(?:promise[ds]?|commit(?:ted|ment)?|swear|vow(?:ed)?|agreed to)\b/i },
  { category: "relationship", importance: 7, pattern: /\b(?:broke up|break up|exclusive|coupled up|ended our relationship|in love|love you|romantic feelings|choose you|dating|relationship is over)\b/i },
  { category: "conflict", importance: 6, pattern: /\b(?:betrayed|betrayal|lied|lying|suspects?|argument|apologiz(?:e|ed)|apologis(?:e|ed)|forgive|forgave|trust is broken)\b/i },
  { category: "preference", importance: 5, pattern: /\b(?:strongly prefer|always prefer|never want|cannot stand|can't stand|hate being|my favorite|my favourite)\b/i },
  { category: "personal_fact", importance: 6, pattern: /\b(?:my birthday|my hometown|grew up in|i am allergic|i'm allergic|my family|my sibling|my brother|my sister)\b/i },
  { category: "emotional_shift", importance: 5, pattern: /\b(?:jealous|no longer trust|feel betrayed|feel unsafe|feel safe with|feel abandoned|finally trust|feelings have changed)\b/i },
];

export function extractCandidates(scope: MemoryScope, batch: ExtractionMessage[]): MemoryCandidate[] {
  // Reject the entire batch before evaluating text if any message comes from another location.
  if (!batch.length || batch.length > 4 || batch.some(m => m.guildId !== scope.guildId ||
      m.channelId !== scope.channelId || !Number.isFinite(Date.parse(m.timestamp)))) return [];
  const result: MemoryCandidate[] = [];
  for (const message of batch) {
    for (const sentence of message.text.slice(0, 6000).split(/(?<=[.!?])\s+|\n+/).slice(0, 12)) {
      const text = sentence.trim();
      if (text.length < 15 || text.length > 800 || text.endsWith("?") || /\b(?:just kidding|just joking|only joking|jk|no continuity)\b/i.test(text)) continue;
      const signal = signals.find(rule => rule.pattern.test(text));
      if (!signal) continue;
      if (signal.category === "personal_fact" && message.kind !== "kin") continue;
      const uncertain = /\b(?:suspects?|might|maybe|thinks?|jealous|feel(?:s)?|unclear|unsure|possibly)\b/i.test(text);
      // Quote the evidence; never convert suspicions or generated dialogue into objective fact.
      const author = message.authorName.replace(/[\r\n"]/g, " ").slice(0, 60);
      result.push({
        content: `Reported statement by ${author}: "${text}"`,
        category: signal.category,
        importance: signal.importance,
        confidence: uncertain ? 0.5 : message.kind === "user" ? 0.8 : 0.6,
        subjects: [...new Set([scope.kinId, message.authorId])],
        sourceChannelId: message.channelId,
        occurredAt: message.timestamp,
        sourceMessageIds: message.messageIds.slice(0, 8),
        metadata: {
          visibility: scope.visibility && scope.visibility !== 'public' ? scope.visibility : 'private',
          knownByKinIds: scope.visibility==='production' ? [] : [scope.kinId], knownAt: message.timestamp,
          speakerId: message.authorId, speakerName: author, sourceSnapshot: text,
          sourceType: 'auto_extracted', statementType: uncertain ? 'suspicion' : 'reported_speech',
          memoryType: signal.category === 'villa_event' || signal.category === 'challenge_outcome' ? 'event' :
            signal.category === 'emotional_shift' ? 'state' : signal.category === 'preference' ? 'preference' : 'belief',
        },
      });
      if (result.length === 3) return result;
    }
  }
  return result;
}

export class MemoryExtractionWorker {
  private jobs: { scope: MemoryScope; batch: ExtractionMessage[] }[] = [];
  private running = false;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly config: MemoryConfig, private readonly store: Pick<MemoryStore, "autoSetting" | "createPending">) {}

  schedule(scope: MemoryScope | undefined, batch: ExtractionMessage[]): void {
    if (!this.config.enabled || !this.config.autoEnabled || !scope ||
        !this.config.autoChannelIds?.has(scope.channelId) || this.jobs.length >= 20) return;
    this.jobs.push({ scope: { ...scope }, batch: batch.map(m => ({ ...m, messageIds: [...m.messageIds] })) });
    if (!this.running) {
      this.running = true;
      setImmediate(() => { void this.drain(); });
    }
  }

  private async drain(): Promise<void> {
    try {
      for (let job = this.jobs.shift(); job; job = this.jobs.shift()) {
        try {
          const candidates = extractCandidates(job.scope, job.batch);
          if (!candidates.length || await this.store.autoSetting(job.scope) === false) continue;
          for (const candidate of candidates) await this.store.createPending(job.scope, candidate);
        } catch {
          console.warn("Automatic memory extraction unavailable; normal replies are unaffected.");
        }
      }
    } finally {
      this.running = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  // Useful for tests and controlled shutdowns, never awaited by a Discord reply handler.
  whenIdle(): Promise<void> {
    return this.running ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve();
  }
}
