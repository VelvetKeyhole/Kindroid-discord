# Production memory guide

This layer controls which PostgreSQL notes enter each outgoing Kindroid request. It does
not change Kindroid's own backstory/app memory, erase information already sent to an API,
or filter the existing recent Discord conversation. Keep private Discord conversations in
private channels, and do not put confidential production data into a public kin's app backstory.

## Configuration and migration

No additional environment variables are required. Keep `DATABASE_URL`, stable `KIN_ID_N`,
`MEMORY_ADMIN_USER_IDS`, `MEMORY_ENABLED`, `MEMORY_AUTO_ENABLED`, and
`MEMORY_AUTO_CHANNEL_IDS`. Extraction still needs both the master and exact channel allowlist.

`MEMORY_CONTEXTS` accepts optional visibility. Example templates (replace ID placeholders):

```json
[
  {"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID","categoryId":"PUBLIC_CATEGORY_ID","visibility":"public"},
  {"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID","channelId":"PRIVATE_CHANNEL_ID","visibility":"private"},
  {"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID","channelId":"CONFESSIONAL_CHANNEL_ID","visibility":"confessional"},
  {"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID","channelId":"PRODUCTION_CHANNEL_ID","visibility":"production"}
]
```

Exact channel overrides still exclude category memory completely. Category inheritance
requires synchronized permissions; threads do not inherit category memory. DMs remain excluded.
Visibility is an explicit production classification, not guessed from a Discord channel name.
Review private categories too: category-scoped notes are intentionally shared with eligible
channels in that category. Use exact mappings when audiences differ.

Migration 003 preserves IDs, text, source IDs, timestamps, scope and status. Existing manual
and already-approved records default to public **inside their original scope**, known only
by the owning kin. Existing unapproved automatic candidates default to private. Legacy villa
and challenge notes default to event; other legacy notes default to fact. This is a conservative
starting classification, not semantic inference. Review old confidential notes and state notes.

`metadata` is a validated JSONB object on `memories`; ownership/context and workflow status
remain normalized columns. New tables are `memory_revisions`, `memory_audit`, `memory_aliases`,
and `memory_binding_history`. Database triggers preserve original text, capture complete
revision snapshots, validate metadata, and record mutations in the same transaction.

Before deployment: take a recoverable PostgreSQL backup, test restoring it, pause bot/admin
writes, run `npm run migrate`, verify, then start the updated bot. The migration framework
records 003 once and runs all outstanding migrations transactionally. Test data is small;
large tables may require a maintenance window and review of the existing database timeouts.
The app does not migrate production automatically. Migration needs table ownership, schema
CREATE, and permission to create functions/triggers/indexes; ordinary writes also need access
to the new tables and their sequences. Do not run the new code before 003 is applied.

If rolling back to code that does not enforce metadata privacy, first disable memory and
extraction. Old code could otherwise retrieve newly private notes. There is no destructive
down-migration. Use compatible forward fixes or a tested full backup recovery; restoring a
backup loses writes after that backup unless separately preserved. Never remove revision tables
to make an old destructive delete command work.

After migrations 002/003, never run the older memory implementation against this schema
with memory enabled. Set `MEMORY_ENABLED=false` and `MEMORY_AUTO_ENABLED=false` before
starting an older build. If schema compatibility is uncertain, restoring a tested full backup
is the safe rollback path. Preserve a post-migration backup too if newer writes must be recovered.

## Edit concurrency and atomic operations

Edits, approval, retcon, merge, import staging and alias changes use a single PostgreSQL
transaction. Lock order is always kin binding, context, then memory rows. This intentionally
serializes writes for the same kin, including different contexts, because binding takes a
kin-row lock. Large imports can delay other operations for that kin; keep production batches small.
Nested import additions reuse the same connection and transaction.

Ordinary edits read metadata only after locking the current memory row. They merge only the
supplied metadata fields into that current metadata, preserving other governance changes.
Discord edits also carry the PostgreSQL row version (`xmin`) from their initial inspection.
If approval, another edit, retcon or merge changes that version, the command fails with an
explicit inspect-again/retry message. This token is temporary, not a durable revision ID;
never reuse it across a restore or keep it as a long-term identifier. Programmatic edits based
on a previously read full snapshot must pass its `edit_version` too. Patch-only callers without
a version serialize; later explicit changes to the same field win deliberately.

Revision/audit triggers remain in the mutation transaction. Alias changes and their explicit
audit insert now commit together; audit failure rolls both back. Kin rebinding already includes
its binding history and audit in one transaction. Single-statement archive, rejection, retention
and source-review operations use the existing atomic audit/revision triggers.

Failed transactional mutations also roll back any identity/context registration they created.
Read/configuration paths still register configured scopes before their later query. A failed
read can leave an empty identity/context registry row: this grants no memory knowledge and
contains no canon. Binding rejects reuse of a stable kin ID by a different Discord bot. These
empty registry rows are harmless and do not require cleanup before retrying.

## Visibility versus knowledge

`visibility`: public, private, confessional, or production.
`knownByKinIds`: explicit stable character IDs, not display names.
`knownAt`: ISO timestamp when this record's owning character learned the information.

Non-production notes must name their owner as a knower. Listing another kin here does not
grant access to that kin's bot: every query still requires the record's own kin/storyline/server/
resolved context. A reveal needs a deliberately created recipient-scoped record with its own
knowledge timestamp; optional `revealOf` links the source. Do not backdate a newly learned reveal.
Production notes may have an empty knower list: ownership associates a production record with
a character's workflow, not a claim that the character knows it.

Public notes are eligible in public/private/confessional contexts only if the character knows
them and the exact scope matches. Private notes require private requests; confessional notes
require confessional requests. Production notes never enter ordinary responses, including
responses in a production-classified channel. Privacy/knowledge/time filtering precedes
relevance and pin/authority ranking, with another filter before request injection.

All newly extracted candidates default to private in an ordinary public context; explicit
private/confessional/production mappings retain that narrower classification. Approval never
changes visibility or knowledge. To intentionally make a reviewed candidate public, edit
visibility explicitly before/after approval. This means approval alone may produce no change
in a public kin reply, which is deliberate.

Normal retrieval uses the current time and labels knowledge time in continuity notes.
The storage API also accepts an explicit `at` time for historical retrieval; it does not infer
a historical role-play clock from natural-language messages. Preserve reveal dates in text
when discussing what a character knew on a particular villa day.

## Memory and provenance

`memoryType`: event, state, fact, preference, relationship, belief.
`statementType`: fact, belief, suspicion, claim, interpretation, reported_speech.
`domain`: identity (core backstory) or continuity (evolving storyline).
`speakerId`/`speakerName`, source snapshots/Discord IDs, original candidate, creator/editor,
reviewer/time, and full revision snapshots preserve provenance. The extractor quotes sources;
it never upgrades a generated claim or suspicion into objective truth.

Events are history and cannot expire or be replaced by normal state supersession. Current
states/relationships may be superseded with explicit approval. Facts/preferences need not
expire. Temporary states can use `expiresAt`; expiration excludes retrieval without changing
or deleting the record. No automatic expiration time is guessed for emotional candidates.

Source types: manual, auto_extracted, discord_import, kindroid_export, production_override.
Priority among eligible relevant notes: explicit production override, authoritative Kindroid
import, manual, other approved sources. This is ranking, not an automatic conflict resolver.
Pinned/importance preferences never bypass privacy. The existing maximum five notes and
2000-character note budget remain. Very long notes may not fit and are skipped.

## Discord administration

All commands require `MEMORY_ADMIN_USER_IDS`, configured scope, and private/ephemeral responses.
Large reports use private attachments; protect downloaded files too.

- Existing add/list/show/edit/delete/pending/approve/reject/auto-status/auto-on/auto-off remain.
- Add/edit options: `visibility`, `known-by`, `known-at`, `type`, `statement`, `speaker-id`,
  `expires-at` (ISO timestamp or `none`), `pinned`, `domain`, `fact-key`, `assertion`.
- `/memory show id:UUID` includes full metadata/provenance/original text in a JSON attachment.
- `/memory pending` displays visibility/audience/score/confidence and previews; show inspects fully.
- Pending edits preserve the original candidate; approval records the approver and activates
  the edited version. Edit cannot activate pending/rejected/superseded records.
- `/memory history id:UUID`: revision IDs and complete historical snapshots, up to 100 latest revisions.
- `/memory restore id:UUID revision:NUMBER`: recover text/metadata without automatic activation.
  Automatic candidates return to pending; rejected records remain rejected. Manual recovery
  is inactive and needs deliberate enabling. Restoration is itself a new revision.
- `/memory delete id:UUID confirm:true`: archive, never hard-delete. History/restore still work.
- `/memory retcon id:UUID content:... reason:...`: explicit production correction of an active/
  inactive record, preserving old text and privacy. This is not an in-story event. It does not
  activate pending/rejected/archived records or silently supersede other notes.
  Optional `fact-key`/`assertion` correct explicit conflict values along with the summary.
- `/memory approve id:UUID supersedes:OLD_UUID`: atomic same-scope non-event state replacement.
- `/memory merge id:KEEP_UUID duplicate:DUPLICATE_UUID`: only equivalent active notes with
  matching visibility, audience, domain, type, statement classification and expiration. The
  later knowledge time is retained; duplicates stay archived with sources/history and links.
- `/memory conflicts`: review pairs with the same `factKey` but different `assertion` values.
  A narrow likes/hates rule proposes keys for simple preference contradictions. Other conflicts
  need explicit keys. Neither conflicting eligible active note is injected until resolved.
  Correct/archive/supersede explicitly; authority/newness alone does not decide the winner.
- `/memory snapshot`: current eligible active canon for this context, excluding pending,
  archived, superseded, expired and flagged conflicting notes. JSON contains type/category
  fields, with a readable companion grouped by memory type; public snapshots omit private/confessional/production notes. Discord
snapshots are capped at 1000 records; use the local tool for larger output.

**Public-filtered exports and snapshots are not automatically publication-safe.** Their
original text, revision attachments and source/provenance metadata can contain confidential
material even when the current summary is public. Export/snapshot responses now include an
explicit warning. Inspect and redact files manually before sharing; filtering current visibility
does not sanitize historical or source text.

## Local bulk production tool

Run `npm run memory:tools -- REQUEST.json OUTPUT.json`. The output must be a new file.
Requests need an allowlisted `actorId`, a configured exact scope, and the registered bot ID.
This is a local trusted production tool, not a network service. Protect database credentials,
request/output files, and access to the host. It never logs exports or raw database errors.

Request template (replace placeholders; Discord IDs must be numeric):

```json
{
  "actorId":"ADMIN_USER_ID",
  "scope":{"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID",
    "channelId":"SOURCE_CHANNEL_ID","discordBotId":"BOT_USER_ID",
    "contextType":"category","contextId":"CATEGORY_ID"},
  "operation":"export",
  "filter":{"page":1,"status":"active","visibility":"public"}
}
```

For exact scopes use contextType channel and contextId equal to channelId. The tool checks
the configured context; it trusts the production operator's chosen physical source channel,
without calling Discord to inspect category membership. Live reply/command resolution still
uses Discord's category/permission checks.

Operations: `export`, `preview`, `stage`, `snapshot`, `audit`, `retention`, `alias`, `source-review`,
`rebind`. Export pages hold 1000 records and optional status/visibility/from/until filters
(ISO dates on creation time). Scope selects kin/storyline/server/category or channel. Export
returns a readable summary and a structured `bundle`; copy the bundle, not the whole wrapper,
into an import request. No status filter exports every status including archives/history links.
Reconciliation and snapshots review at most 10000 records; larger workflows use paginated
exports rather than silently truncated results. Audit returns up to 1000 recent scoped operations.

Normalized bundle template:

```json
{
  "version":1,
  "scope":{"kinId":"vincent-villa","storyline":"villa-season-1","guildId":"SERVER_ID",
    "contextType":"channel","contextId":"CHANNEL_ID"},
  "source":"kindroid_export","namespace":"vincent_app_revision_ledger","authoritative":true,
  "items":[{"externalId":"core-birthday","content":"Vincent's birthday is February 14.",
    "category":"personal_fact","importance":3,"tags":["birthday"],
    "metadata":{"visibility":"private","knownByKinIds":["vincent-villa"],
      "knownAt":"2026-10-01T12:00:00Z","memoryType":"fact","statementType":"claim",
      "domain":"identity","factKey":"vincent-birthday","assertion":"02-14"}}]
}
```

Use stable namespace/externalId values across versions, not fresh IDs every export. A bundle
accepts up to 1000 items. Existing PostgreSQL round-trip exports carry UUIDs and all original
metadata/source fields. IDs only resolve in the selected scope; a foreign UUID is rejected.

1. Convert a Kindroid app export/continuity summary into these structured items. The tool does
   not guess the vendor's native export format or split arbitrary prose automatically.
2. Submit operation `preview` with `bundle`. It returns unchanged/duplicate/new/changed/conflict/
   obsolete entries and a token. Obsolete only means missing from this import namespace;
   the system never interprets omission as permission to delete canon.
3. Inspect the preview. Submit `stage` with the identical bundle and token. Changes to the
   scope/bundle/database invalidate the preview. The entire staging batch is transactional.
4. New/changed/conflicting items become pending, private by default unless explicitly classified.
   Unchanged/duplicates are skipped. Re-preview recognizes already staged versions. Original
   source snapshots/provenance and round-trip IDs stay available; history is not flattened.
5. Review/edit each proposed correction. Authoritative=true marks intended authority but never
   activates a record or overwrites another. Use explicit approval with supersedes for a changed
   state, or a reasoned production retcon for corrections, including historical factual mistakes.

Round-trip recognition uses scoped IDs, stable external keys and conservative normalized
wording comparisons. It cannot reliably recognize heavily rewritten paraphrases; review is
still needed. No automatic two-way Kindroid synchronization or API extraction call exists.

Equivalent items with different external IDs in the same batch are staged once. This requires
matching normalized full text, governance, attribution, temporal meaning and correction target;
ambiguous items remain separate. Suppressed external IDs are retained as `importAliases`, and
Discord source message IDs are combined. If combining evidence would exceed the existing
eight-message bound, items remain separate rather than dropping evidence. Preview shows which
entry is the duplicate, and later imports recognize those retained external keys.

The local tool writes its result file after a successful database operation. A file-write failure
does not undo an already committed staging batch; inspect the database or re-preview before retrying.

`retention` takes optional `days` (default 30) and archives older unreviewed candidates. Run
deliberately during maintenance; no startup purge/hard deletion. Rejected/archived candidates
retain content/provenance for duplicate suppression. There is no public audit or automatic
hard-delete mechanism; future legal/retention purging needs an explicit separate workflow.

`alias` takes `alias` and `subjectId`. Aliases are approved, lowercased and scoped to kin/
storyline/server; unknown aliases are not guessed. The resolver is available to production
workflows, but the regex extractor does not attempt natural-language entity resolution.

`source-review` takes memory `id` and `reason`, preserving the original source snapshot and
flagging a discrepancy. No Discord message-update/delete listener rewrites canon. A production
operator checks sources and marks important discrepancies; automatic monitoring is deferred.

`rebind` takes `oldBotId`, `newBotId`, and a reason; stop the old bot first. It checks the existing
binding, preserves the stable kin ID and records the transfer. Configure the new bot afterward.
Replacing a Kindroid's share code likewise requires deliberate production reconciliation,
not changing stable ownership IDs or treating display names as identities.

## What remains intentionally manual

Production/world knowledge is separate from character knowledge through visibility, domain
and explicit reveal records; no universal world-state engine exists. Retcons, conflict resolution,
reveals, authoritative reconciliation, aliases, source discrepancies and retention remain
admin decisions. Bulk operations use reusable scoped transactions and revision triggers;
there is no giant UI or automatic mass visibility promotion. Extraction remains bounded,
background, rule-based and approval-only, with database/extraction failures falling back to
the existing normal recent-context reply flow.
