const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { MemoryStore, substantiallyMatches } = require('../dist/memoryStore');
const { resolveMemoryScope, loadMemoryConfig } = require('../dist/memoryConfig');
const { supplementConversation } = require('../dist/memoryContext');
const { extractCandidates, MemoryExtractionWorker } = require('../dist/memoryExtraction');
const { handleMemoryCommand } = require('../dist/memoryCommands');
const { migrateDatabase } = require('../dist/database');
const { MessageFlags } = require('discord.js');

const scope = { kinId: 'vincent-villa', storyline: 'villa-season-1', guildId: '111111111111111111', channelId: '222222222222222222', discordBotId: '333333333333333333' };
const categoryId = '555555555555555555';
const admin = '444444444444444444';
const input = { content: 'Vincent promised Dee a conversation before recoupling.', category: 'promise', importance: 3, tags: ['dee'] };
const recent = [{ username: 'Dee', text: 'Vincent promised a conversation.', timestamp: '2026-10-04T00:00:00.000Z' }];
const config = { enabled: true, adminUserIds: new Set([admin]), autoEnabled: true, autoChannelIds: new Set([scope.channelId]), contexts: [{ ...scope }] };
function batch(text = input.content, channelId = scope.channelId, kind = 'user') {
  return [{ authorId: admin, authorName: 'Dee', kind, text, guildId: scope.guildId, channelId,
    timestamp: '2026-10-04T00:00:00.000Z', messageIds: ['666666666666666666'] }];
}
function candidate(overrides = {}) {
  return { content: input.content, category: 'promise', importance: 8, confidence: 0.8,
    subjects: [scope.kinId, admin], sourceChannelId: scope.channelId,
    occurredAt: '2026-10-04T00:00:00.000Z', sourceMessageIds: ['666666666666666666'], ...overrides };
}

let pg, database, store, migratedLegacy;
test.before(async () => {
  pg = await PGlite.create();
  database = {
    query: async (sql, values) => {
      const result = values ? await pg.query(sql, values) : (await pg.exec(sql)).at(-1);
      return { rows: result.rows || [], rowCount: result.affectedRows || result.rows?.length || 0 };
    },
    connect: async () => ({ query: database.query, release() {} }),
  };
  await pg.exec(fs.readFileSync('migrations/001_memory.sql', 'utf8'));
  await pg.exec(`INSERT INTO memory_kins(id,discord_bot_id) VALUES ('legacy','777777777777777777');
    INSERT INTO memory_contexts VALUES ('legacy','villa','111111111111111111','222222222222222222');
    INSERT INTO memories(id,kin_id,storyline,guild_id,channel_id,content,category,active,created_by,updated_by)
    VALUES ('00000000-0000-4000-8000-000000000001','legacy','villa','111111111111111111','222222222222222222','Legacy promise','promise',true,'admin','admin'),
    ('00000000-0000-4000-8000-000000000002','legacy','villa','111111111111111111','222222222222222222','Inactive legacy event','villa_event',false,'admin','admin');
    CREATE TABLE memory_schema_migrations(id text PRIMARY KEY,applied_at timestamptz DEFAULT now());
    INSERT INTO memory_schema_migrations(id) VALUES ('001_memory');`);
  await migrateDatabase(database);
  migratedLegacy = (await database.query('SELECT * FROM memories ORDER BY id')).rows;
  await migrateDatabase(database);
  assert.equal((await database.query('SELECT * FROM memory_schema_migrations')).rows.length, 3);
  store = new MemoryStore(database);
});
test.beforeEach(async () => { await pg.exec('TRUNCATE memories,memory_contexts,memory_kins,memory_binding_history,memory_audit CASCADE'); });
test.after(async () => { await pg?.close(); });

test('real PostgreSQL migration preserves active/inactive manual memories and is repeatable', () => {
  assert.equal(migratedLegacy.length, 2);
  assert.equal(migratedLegacy[0].status, 'active');
  assert.equal(migratedLegacy[1].status, 'inactive');
  assert.equal(migratedLegacy[0].context_type, 'channel');
  assert.equal(migratedLegacy[0].context_id, scope.channelId);
  assert.equal(migratedLegacy[0].origin_kind, 'manual');
});

test('channel mappings remain compatible, synced categories work and exact mappings override categories', () => {
  const mapped = { ...config, contexts: [
    { kinId: scope.kinId, guildId: scope.guildId, storyline: 'category-story', categoryId },
    { ...scope },
  ] };
  const options = { categoryId, categoryPermissionsSynced: true };
  const exact = resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, scope.guildId, scope.channelId, options);
  assert.equal(exact.contextType, 'channel');
  assert.equal(exact.storyline, scope.storyline);
  const category = resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, scope.guildId, '888888888888888888', options);
  assert.equal(category.contextType, 'category');
  assert.equal(category.contextId, categoryId);
  assert.equal(category.storyline, 'category-story');
  assert.equal(resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, scope.guildId, 'unknown'), undefined);
  assert.equal(resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, null, scope.channelId, options), undefined);
  assert.equal(resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, scope.guildId, 'private', { ...options, categoryPermissionsSynced: false }), undefined);
  assert.equal(resolveMemoryScope(mapped, scope.kinId, scope.discordBotId, scope.guildId, 'thread', { ...options, isThread: true }), undefined);
});

test('category memories share only within their resolved category, not exact/private contexts or other kins/stories/guilds', async () => {
  const category = { ...scope, contextType: 'category', contextId: categoryId };
  const saved = await store.add(category, input, admin);
  assert.equal((await store.retrieve({ ...category, channelId: '888888888888888888' }, ['promised'])).length, 1);
  for (const foreign of [scope, { ...category, contextId: '999999999999999999' },
    { ...category, storyline: 'personal' }, { ...category, guildId: '999999999999999999' },
    { ...category, kinId: 'dee-villa', discordBotId: '777777777777777777' }]) {
    assert.equal(await store.show(foreign, saved.id), undefined);
    assert.deepEqual(await store.retrieve(foreign, ['promised']), []);
    assert.equal(await store.delete(foreign, saved.id), false);
  }
  const privateScope = { ...scope, channelId: '999999999999999999' };
  await store.add(privateScope, { ...input, content: 'Private confession about a promise.' }, admin);
  assert.equal((await store.retrieve(category, ['private'])).length, 0);
});

test('importance 1–4 is discarded; 5–10 always stays pending until explicit approval', async () => {
  assert.equal(await store.createPending(scope, candidate({ importance: 4 })), undefined);
  for (let score = 5; score <= 10; score++) {
    const saved = await store.createPending(scope, candidate({ importance: score, content: `Unique promise number ${score}` }));
    assert.equal(saved.status, 'pending');
    assert.equal(saved.active, false);
    assert.equal(saved.candidate_importance, score);
    assert.equal(saved.source_channel_id, scope.channelId);
    assert.equal(saved.source_message_ids.length, 1);
  }
  assert.deepEqual(await store.retrieve(scope, ['promise']), []);
  const pending = (await store.list(scope, 1, true))[0];
  await store.edit(scope, pending.id, { ...input, content: pending.content }, true, admin);
  assert.equal((await store.show(scope, pending.id)).status, 'pending');
  assert.equal((await store.approve(scope, pending.id, admin)).status, 'active');
  assert.deepEqual(await store.retrieve(scope, ['promise']), []);
  assert.equal((await store.retrieve({ ...scope,visibility:'private' }, ['promise'])).length, 1);
});

test('rejected candidates remain nonretrievable and cannot be activated through edit/approve', async () => {
  const pending = await store.createPending(scope, candidate());
  assert.equal(await store.reject(scope, pending.id, admin), true);
  assert.equal((await store.show(scope, pending.id)).status, 'rejected');
  assert.equal(await store.approve(scope, pending.id, admin), undefined);
  await store.edit(scope, pending.id, input, true, admin);
  assert.deepEqual(await store.retrieve(scope, ['promised']), []);
  assert.equal(await store.createPending(scope, candidate()), undefined);
});

test('scoped deduplication covers active, pending and rejected wording without collapsing negation', async () => {
  await store.add(scope, input, admin);
  assert.equal(await store.createPending(scope, candidate({ content: `Reported statement by Dee: "${input.content}"` })), undefined);
  const different = candidate({ content: 'Vincent never promised Dee a conversation before recoupling.' });
  assert.ok(await store.createPending(scope, different));
  assert.equal(await store.createPending(scope, different), undefined);
  assert.equal(substantiallyMatches('Vincent promised Dee a private conversation before recoupling tonight', 'Vincent promised Dee a private conversation before recoupling tonight.'), true);
  const other = { ...scope, channelId: '999999999999999999' };
  assert.ok(await store.createPending(other, { ...candidate(), sourceChannelId: other.channelId }));
  await assert.rejects(store.createPending(scope, candidate({ sourceChannelId: other.channelId })));
});

test('identical first-person statements from different speakers remain separate candidates', async () => {
  const statement = candidate({ content: 'Reported statement by Dee: "I promise to stay loyal in the villa."' });
  assert.ok(await store.createPending(scope, statement));
  assert.ok(await store.createPending(scope, { ...statement,
    content: 'Reported statement by Vincent: "I promise to stay loyal in the villa."',
    subjects: [scope.kinId, scope.discordBotId] }));
  assert.equal(await store.createPending(scope, statement), undefined);
});

test('supersession is explicit, atomic, scoped and preserves dated history', async () => {
  const old = await store.add(scope, input, admin);
  const next = await store.createPending(scope, candidate({ content: 'Vincent fulfilled his promise to Dee.' }));
  const foreignScope = { ...scope, channelId: '999999999999999999' };
  const foreign = await store.add(foreignScope, input, admin);
  await assert.rejects(store.approve(scope, next.id, admin, foreign.id));
  assert.equal((await store.show(scope, next.id)).status, 'pending');
  assert.equal((await store.show(scope, old.id)).status, 'active');
  const approved = await store.approve(scope, next.id, admin, old.id);
  assert.equal(approved.supersedes_id, old.id);
  const historical = await store.show(scope, old.id);
  assert.equal(historical.status, 'superseded');
  assert.equal(historical.active, false);
  assert.ok(historical.occurred_at);
  assert.equal((await store.retrieve({ ...scope,visibility:'private' }, ['promise'])).length, 1);
});

test('extractor preserves ambiguous wording, attributes AI output, and ignores routine chatter', async () => {
  assert.deepEqual(extractCandidates(scope, batch('Hello! Nice to see you. *kisses and hugs* You look cute.')), []);
  assert.deepEqual(extractCandidates(scope, batch('I promise you a kiss, just kidding.')), []);
  assert.deepEqual(extractCandidates(scope, batch('Will you promise to choose me?')), []);
  assert.deepEqual(extractCandidates(scope, batch('My birthday is in February.')), []);
  assert.equal(extractCandidates(scope, batch('My birthday is in February.', scope.channelId, 'kin'))[0].category, 'personal_fact');
  assert.deepEqual(extractCandidates(scope, batch(input.content, '999999999999999999')), []);
  const ambiguous = extractCandidates(scope, batch('Dee suspects Vincent is lying about the challenge.'));
  assert.equal(ambiguous.length, 1);
  assert.match(ambiguous[0].content, /Dee suspects Vincent is lying/);
  assert.ok(ambiguous[0].confidence < 0.8);
  assert.equal((await store.createPending(scope, ambiguous[0])).status, 'pending');
  const generated = extractCandidates(scope, batch('I promise to choose Dee at recoupling.', scope.channelId, 'kin'));
  assert.match(generated[0].content, /Reported statement/);
  assert.equal((await store.createPending(scope, generated[0])).active, false);
});

test('auto master-off, missing allowlist, scope-off and unconfigured locations prevent extraction', async () => {
  let calls = 0;
  const fake = { autoSetting: async () => { calls++; return false; }, createPending: async () => { throw new Error('must not save'); } };
  for (const cfg of [{ ...config, autoEnabled: false }, { ...config, autoChannelIds: new Set() }]) {
    const worker = new MemoryExtractionWorker(cfg, fake);
    worker.schedule(scope, batch());
    await worker.whenIdle();
  }
  assert.equal(calls, 0);
  const worker = new MemoryExtractionWorker(config, fake);
  worker.schedule(undefined, batch());
  worker.schedule(scope, batch());
  await worker.whenIdle();
  assert.equal(calls, 1);
  await store.setAutoSetting(scope, false);
  assert.equal(await store.createPending(scope, candidate()), undefined);
});

test('background extraction does not wait on normal replies and contains database failures', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started = false;
  const worker = new MemoryExtractionWorker(config, {
    autoSetting: async () => { started = true; await gate; throw new Error('private database failure'); },
    createPending: async () => { throw new Error('must not save'); },
  });
  worker.schedule(scope, batch());
  assert.equal(started, false);
  const normalReply = await Promise.resolve('reply delivered');
  assert.equal(normalReply, 'reply delivered');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, true);
  release();
  await worker.whenIdle();
  const failure = new MemoryStore({ query: async () => { throw new Error('private'); } });
  assert.strictEqual(await supplementConversation(failure, scope, recent, 'promise'), recent);
});

function interaction(command, values = {}, userId = admin) {
  const responses = [];
  const value = { user: { id: userId }, client: { user: { id: scope.discordBotId } }, guildId: scope.guildId,
    channelId: scope.channelId, channel: null, deferred: false, replied: false, responses,
    options: { getSubcommand: () => command, getString: name => values[name] ?? null,
      getInteger: name => values[name] ?? null, getBoolean: name => values[name] ?? null },
    reply: async payload => { responses.push(payload); value.replied = true; },
    deferReply: async payload => { responses.push(payload); value.deferred = true; },
    editReply: async payload => { responses.push(payload); } };
  return value;
}

test('new review/auto controls are admin-only, ephemeral, informative and preserve manual CRUD', async () => {
  const runtime = { config, store };
  for (const command of ['pending','approve','reject','auto-status','auto-on','auto-off']) {
    const denied = interaction(command, {}, '999999999999999999');
    await handleMemoryCommand(denied, scope.kinId, runtime);
    assert.equal(denied.responses[0].flags, MessageFlags.Ephemeral);
    assert.equal(denied.deferred, false);
  }
  const pending = await store.createPending(scope, candidate());
  for (const [command, args] of [['pending', {}], ['show', { id: pending.id }], ['auto-status', {}], ['auto-off', {}], ['auto-on', {}], ['approve', { id: pending.id }]]) {
    const current = interaction(command, args);
    await handleMemoryCommand(current, scope.kinId, runtime);
    assert.equal(current.responses[0].flags, MessageFlags.Ephemeral);
    if (command === 'show') {
      const shown=JSON.parse(current.responses.at(-1).files[0].attachment.toString());
      for (const key of ['candidate_importance','confidence','subjects','context_id','occurred_at','source_message_ids','metadata']) assert.ok(key in shown);
    }
  }
  assert.equal((await store.show(scope, pending.id)).status, 'active');
  const add = interaction('add', { content: 'Dee prefers quiet mornings.', category: 'preference' });
  await handleMemoryCommand(add, scope.kinId, runtime);
  const manual = (await store.list(scope)).find(m => m.origin_kind === 'manual');
  assert.ok(manual);
  await handleMemoryCommand(interaction('edit', { id: manual.id, active: false }), scope.kinId, runtime);
  assert.equal((await store.show(scope, manual.id)).active, false);
  await handleMemoryCommand(interaction('delete', { id: manual.id, confirm: true }), scope.kinId, runtime);
  assert.equal(await store.show(scope, manual.id), undefined);
});

test('configuration accepts category options, rejects mixed scopes, and defaults extraction off', () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, { MEMORY_ENABLED: 'true', DATABASE_URL: 'placeholder', MEMORY_ADMIN_USER_IDS: admin });
    delete process.env.MEMORY_AUTO_ENABLED;
    delete process.env.MEMORY_AUTO_CHANNEL_IDS;
    const mapping = { kinId: scope.kinId, storyline: scope.storyline, guildId: scope.guildId, categoryId };
    process.env.MEMORY_CONTEXTS = JSON.stringify([mapping]);
    const loaded = loadMemoryConfig([{ kinId: scope.kinId }]);
    assert.equal(loaded.autoEnabled, false);
    assert.equal(loaded.autoChannelIds.size, 0);
    assert.equal(loaded.contexts[0].categoryId, categoryId);
    process.env.MEMORY_CONTEXTS = JSON.stringify([{ ...mapping, channelId: scope.channelId }]);
    assert.throws(() => loadMemoryConfig([{ kinId: scope.kinId }]));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
