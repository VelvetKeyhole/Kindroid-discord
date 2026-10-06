# Kindroid Discord Multi-Bot Manager

Tutorial on how to use this repo: https://docs.kindroid.ai/official-discord-bot-integration

A Node.js service that manages multiple Discord bots, each tied to a unique Kindroid AI persona. The system uses just-in-time message fetching to provide conversation context without storing large message logs.

## Features

- **Multi-bot** support: Run multiple Discord bots from a single service
- **Kindroid AI integration**: Each bot is tied to a unique AI persona (via `SHARED_AI_CODE_n`)
- **JIT message fetching**: Dynamically grabs the last ~30 messages for context
- **Caching**: Minimizes redundant Discord API calls
- **Graceful shutdown**: Bots disconnect on SIGINT/SIGTERM
- **Configurable NSFW filtering** via environment variables

## Prerequisites

- Node.js 16.x or higher
- Discord Bot Token(s) from the [Discord Developer Portal](https://discord.com/developers/applications)
- Kindroid AI API access (API key and share code)

## Setup

1. **Clone the repository**:

   ```bash
   git clone https://github.com/KindroidAI/Kindroid-discord.git
   cd Kindroid-discord
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy and configure .env:

   ```bash
   cp .env.example .env
   ```

4. Fill in your KINDROID_API_KEY, KINDROID_INFER_URL, and bot tokens (BOT_TOKEN_n).
   Provide SHARED_AI_CODE_n for each bot's AI persona.

5. Run in development mode:

   ```bash
   npm run dev
   ```

   For production:

   ```bash
   npm run build
   npm start
   ```

## Configuration

Use environment variables to configure your bots. The .env.example file shows usage:

- KINDROID_INFER_URL: The Kindroid AI API endpoint, and should not change
- KINDROID_API_KEY: Your Kindroid AI API key
- SHARED_AI_CODE_n: The share code to identify which AI persona to use for the n-th bot
- BOT_TOKEN_n: Discord bot token for the n-th bot
- ENABLE_FILTER_n: (Optional) true or false to enable NSFW filtering for the n-th bot

You can create as many bots as you want by incrementing the number (\_1, \_2, \_3, etc.).

## Optional persistent memory

Memory is disabled by default. Manual memory supplements the latest Discord conversation;
it does not replace recent messages or write to Kindroid's global persona memory.
Optional automatic extraction creates pending candidates only. There is no automatic
activation, autonomous posting, or embeddings. Category mappings deliberately share
memories between eligible channels in that resolved category, for the same kin/storyline.

1. Connect your Railway PostgreSQL service through `DATABASE_URL` (prefer the project's private connection).
2. Set a unique `KIN_ID_N` for every configured bot, such as `maya-villa` and `theo-villa`.
   Keep this identity with its character when changing numbered bot settings. The database
   also binds it to the Discord bot ID. Reassigning an identity requires an explicit audited production rebind.
3. Set `MEMORY_ADMIN_USER_IDS` to a comma-separated list of trusted Discord user IDs.
   Everyone else is denied **all** memory commands, including reading. The allowlisted users
   administer all configured contexts they can invoke commands in; use a small trusted list.
4. Set `MEMORY_CONTEXTS` to a JSON array. In Railway's variable editor, enter raw JSON
   without wrapping shell quotes:

   ```json
   [{"kinId":"maya-villa","storyline":"villa-season-1","guildId":"123456789012345678","channelId":"234567890123456789"},
    {"kinId":"theo-villa","storyline":"villa-season-1","guildId":"123456789012345678","channelId":"234567890123456789"}]
   ```

5. Run `npm run migrate` in the service environment with `DATABASE_URL`, or configure it
   as the Railway pre-deploy command when you choose to deploy. The migration is
   transactional and recorded in `memory_schema_migrations`; re-running it is safe.
   It applies `001_memory`, `002_category_candidates`, and `003_memory_governance` in order. Migration 002
   preserves existing records as exact-channel manual memories, including inactive records,
   and adds candidate statuses and category context keys. Run it before starting this version.
   Migration 003 adds privacy/knowledge metadata, revision history, audit records and archive recovery.
   See [the production guide](docs/memory-production.md) for legacy defaults, privacy review and rollback precautions.
   The application never automatically migrates a production database.
6. Set `MEMORY_ENABLED=true` and restart the bot when ready. Startup registers `/memory`
   for each bot application in its configured guilds, without replacing other commands.
   Each application must be installed with `bot` and `applications.commands` scopes.
   Enable Discord's Message Content Intent and retain normal channel/history permissions.

Use Discord Developer Mode's **Copy ID** for users, servers, and channels. If several bots
offer `/memory`, select the correct bot application in Discord's command picker.
Every operation is limited to that application's kin and the invoking channel's configured
storyline and server. Known memory IDs do not grant access outside that scope.
Threads require their own explicit mappings. DMs and unconfigured channels have no memory.
Changing a channel's storyline stops retrieving the old storyline's records; it does not
delete them. Never combine villa, personal, or alternate-story conversations in one channel.

### Commands

All responses are private/ephemeral and suppress mentions. Commands do not create public
chat messages. Manually record important facts rather than trivial exchanges.

- `/memory add content:... category:promise tags:theo,recoupling importance:3`
- `/memory list page:1` — ten records per page, including inactive records.
- `/memory show id:...` — inspect content, category, tags, scope, and timestamps.
- `/memory edit id:... content:... active:false` — omitted fields keep their current values.
- `/memory delete id:... confirm:true` — archives one scoped record with recovery history.

Categories: `relationship`, `conflict`, `preference`, `promise`, `villa_event`,
`challenge_outcome`, `personal_fact`, `emotional_shift`. Summaries have a 1,000-character maximum. Tags are
comma-separated, at most ten, each up to 40 characters. Importance is 1–5 (default 3).
Importance 5 makes a note eligible even without a keyword match; other records need a
substring/tag match against the triggering message and latest five conversation messages.
Privacy/knowledge/time-eligible active memories are ranked by pinning, importance, authority, then update time, limited to five, and
fitted into a 2,000-character notes budget. Whole notes that do not fit are skipped.

The outgoing request prepends a clearly labeled application-generated continuity entry.
Recent history and its cache are not modified, and the note is never posted to Discord.
Treat this as prompting through Kindroid's existing conversation format: verify behavior
with a dedicated test channel before enabling production continuity. Only records allowed
in the current channel enter the request; there is no broader fallback search.

Database connection/query timeouts cause memory retrieval to fall back to recent context.
Memory commands report a private failure without SQL, credentials, or memory contents in
logs. If a write fails, inspect before retrying because the database may have committed it.
Disabling memory leaves ordinary bot behavior available and retains stored records.
Enable PostgreSQL backups and test restoration. Deleting a memory does not delete source
Discord messages, old replies, or backups. Keep one running bot process: existing request
queues do not coordinate multiple replicas.

Run `npm run build`, `npm run lint`, and `npm test` locally. The original focused tests check
query scope predicates, command authorization, bounds, and failure fallback. Extension tests
use in-memory embedded PostgreSQL (PGlite, a development dependency) to execute both SQL
migrations and check real scoped storage/approval transactions. Tests never connect to Railway.

### Category mappings

Existing `channelId` mappings keep their exact-channel behavior. A new mapping can use
`categoryId` instead, with exactly one location field in each object:

```json
[{"kinId":"maya-villa","storyline":"villa-season-1","guildId":"SERVER_ID","categoryId":"CATEGORY_ID"},
 {"kinId":"maya-villa","storyline":"private-scene","guildId":"SERVER_ID","channelId":"PRIVATE_CHANNEL_ID","visibility":"private"}]
```

Replace the placeholders with numeric Discord IDs. An exact channel mapping always wins
for writes and administration. Exact private/confessional replies and snapshots additionally
inherit the unique public base for that same kin/storyline/server. The different-storyline
example above intentionally stays isolated. Public exact channels never inherit other scopes.
See the [layered retrieval configuration](docs/memory-production.md#layered-public-knowledge)
for a shared Villa plus private/confessional setup; missing/ambiguous bases remain local-only.
Category fallback requires permissions synchronized with that category. Channels with their
own permissions (including private overrides) need an exact mapping. This is deliberately
restrictive: a private/confessional channel must not contribute to a wider category pool.
Threads never inherit category memory; their audience/access can differ from the parent.
Use Discord Developer Mode and right-click a category to copy its ID. Sharing is per kin,
storyline, guild, context type, and context ID; public events are not copied to every kin.

### Automatic candidates (off by default)

Set `MEMORY_AUTO_ENABLED=true` only when ready to review candidates, and set
`MEMORY_AUTO_CHANNEL_IDS` to a comma-separated list of exact channel IDs. The default is
`false` with an empty allowlist. Both gates are required; category configuration alone never
opts a channel into extraction. Do not include admin/production channels unless intentional.
An explicitly mapped/allowlisted thread is eligible, but DMs are never eligible.

After a successful normal reply (all chunks sent), the bot schedules a two-message batch:
the triggering Discord message and that kin's reply. It does not scan all channel history or
unattended messages, and it never posts candidates into public chat. A bounded background
worker processes one batch at a time with up to 20 waiting batches (excess batches are
skipped). Extraction/database failures are contained and cannot hold up normal bot replies.
The worker shares the small database pool; under load it can consume one connection.

The first extractor is intentionally conservative and rule-based, in English: no additional
AI/API calls, API fees, or inference rate-limit usage. It looks for explicit continuity signals
in promises, relationship changes, conflicts, strong preferences, villa/challenge events,
character personal facts, and emotional shifts. It ignores ordinary greetings, flirting,
kisses/hugs, questions, and explicitly marked jokes unless they contain an actual continuity
signal. It can miss subtle developments and can propose false positives; this is a review
tool, not a semantic fact checker. Confidence is a heuristic, not a calibrated probability.

Candidate summaries quote the attributed source statement. Suspicion remains suspicion,
and kin-generated dialogue remains an unverified reported statement. Personal-fact extraction
is limited to the kin's response, rather than automatically storing real users' personal facts.
Each candidate stores its 1–10 importance score, confidence, subjects (kin ID and speaker ID),
source channel/message IDs, and source-message timestamp as `occurred_at`. That timestamp
is evidence time, not an inferred date for events described as "yesterday".

- Scores 1–4 are discarded; scores 5–10 are always **pending**, never active.
- `/memory pending page:1` lists IDs and previews. `/memory show id:...` displays the full
  content, category, score, confidence, subjects, kin/storyline/context, timestamp and sources.
- `/memory approve id:...` activates a pending candidate in this resolved context only.
- `/memory approve id:... supersedes:OLD_UUID` explicitly replaces an active current-state
  memory in the same scope, atomically. The old record stays `superseded` and inactive for
  dated history; no extractor performs supersession on its own.
- `/memory reject id:...` retains the record as `rejected` for history and duplicate suppression.
  It is never retrieved. Archiving retains duplicate suppression and useful provenance.
- `/memory auto-status`, `/memory auto-on`, `/memory auto-off` inspect/set a persistent
  extraction override for the resolved context. In a category this controls the category;
  only individually allowlisted channels can run. The global environment master must still
  be true. `auto-on` does not enable automatic activation or override the channel allowlist.

Every command requires `MEMORY_ADMIN_USER_IDS` and responds privately. Editing a pending,
rejected, or superseded record cannot activate it; approval is the only pending-to-active path.
No future auto-save toggle exists in this version. Manual `/memory add` still creates an
active memory, and its established priority remains 1–5. Candidate scores remain separate:
approved candidates receive retrieval priority `min(4, ceil(score/2))`, so they are not pinned
merely for scoring highly. An admin can edit an approved note's priority to 5 to pin it.

Deduplication is scoped and serialized with a context-row lock. It compares normalized
wording and high word overlap against active, pending, rejected, and archived notes; negation,
uncertainty markers, and differing numbers prevent that approximate match. It is not vector
or semantic search and may miss paraphrases. New dated events should include their date
in the summary when distinguishing them matters. Pending/rejected/superseded/archived notes are
excluded from both database retrieval and the outgoing-request filter.

### Production privacy, history and reconciliation

Mappings accept an optional `visibility` (`public`, `private`, `confessional`, `production`).
Existing mappings default to public within their original scopes. New extracted candidates
default to private unless an explicitly narrower context is configured; approval does not
promote visibility. Review existing confidential records before enabling the new version.

Memory metadata distinguishes who knows a statement, when they learned it, event versus
current state, attribution/uncertainty, identity versus continuity, source authority, expiration,
and pinning. Production-only notes never enter ordinary kin prompts. Conflict keys permit
review of contradictory active states rather than silently selecting the newer statement.

New private admin commands: `/memory history`, `restore`, `retcon`, `merge`, `conflicts`, and
`snapshot`. Add/edit accept governance metadata. Delete now archives; revisions preserve
original candidates and every edit. Pending candidates still need explicit approval.

`npm run memory:tools -- REQUEST.json OUTPUT.json` supports scoped bulk export, dry-run
Kindroid reconciliation, transactional pending import, canonical snapshots, audit, retention,
approved aliases, source discrepancy flags, and controlled stable-kin rebinding. It makes no
additional API calls. Vendor exports require manual conversion into the documented JSON
format; authoritative imports never silently overwrite canon.

Full configuration examples, normalized import format, privacy boundaries, legacy migration
defaults, recovery steps and intentional limitations are in [the production guide](docs/memory-production.md).

## Error Handling

- Failed bot initialization is logged; other bots still initialize
- Conversation fetch failures are caught and logged
- API call errors log diagnostic info and return a friendly user message
- SIGINT or SIGTERM triggers a graceful shutdown of all bots

## Contributing

1. Fork this repository
2. Create your feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add some amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License

This project is licensed under the MIT License.
