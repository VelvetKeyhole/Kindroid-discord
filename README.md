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

Memory is manual and disabled by default. It supplements the latest Discord conversation;
it does not replace recent messages or write to Kindroid's global persona memory.
There is no automatic extraction, autonomous posting, embeddings, or cross-channel sharing.

1. Connect your Railway PostgreSQL service through `DATABASE_URL` (prefer the project's private connection).
2. Set a unique `KIN_ID_N` for every configured bot, such as `maya-villa` and `theo-villa`.
   Keep this identity with its character when changing numbered bot settings. The database
   also binds it to the Discord bot ID. Reassigning an identity to another bot is rejected.
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
   transactional and recorded once in `memory_schema_migrations`; re-running it is safe.
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
- `/memory delete id:... confirm:true` — permanently deletes one scoped record.

Categories: `relationship`, `conflict`, `preference`, `promise`, `villa_event`,
`challenge_outcome`, `personal_fact`. Summaries have a 1,000-character maximum. Tags are
comma-separated, at most ten, each up to 40 characters. Importance is 1–5 (default 3).
Importance 5 makes a note eligible even without a keyword match; other records need a
substring/tag match against the triggering message and latest five conversation messages.
Eligible active memories are ordered by importance then update time, limited to five, and
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

Run `npm run build`, `npm run lint`, and `npm test` locally. The focused tests use a database
double to check actual query scope predicates, command authorization, bounds, and failure
fallback. They do not connect to Railway or verify a live PostgreSQL migration.

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
