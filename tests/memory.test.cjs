const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../dist/memoryStore');
const { supplementConversation } = require('../dist/memoryContext');
const { resolveMemoryScope, loadMemoryConfig } = require('../dist/memoryConfig');
const { handleMemoryCommand, memoryCommandDefinition } = require('../dist/memoryCommands');
const { MessageFlags } = require('discord.js');

const scope = { kinId: 'maya', storyline: 'villa-1', guildId: '11111111111111111', channelId: '22222222222222222', discordBotId: '33333333333333333' };
const admin = '44444444444444444';
const input = { content: 'Theo promised Maya a conversation before recoupling.', category: 'promise', tags: ['theo', 'recoupling'], importance: 3 };
const config = { enabled: true, adminUserIds: new Set([admin]), contexts: [{ ...scope }] };
const recent = [{ username: 'Maya', text: 'What did Theo promise?', timestamp: '2026-10-01T00:00:00.000Z' }];

// A scoped database double validates the actual SQL/parameters emitted by MemoryStore.
// It is not a substitute for running the migration against PostgreSQL.
class ScopedDatabase {
  records = [];
  kins = new Map();
  async query(sql, values) {
    if (sql.startsWith('INSERT INTO memory_kins')) {
      assert.match(sql, /WHERE memory_kins.discord_bot_id = EXCLUDED.discord_bot_id/);
      const bound = this.kins.get(values[0]);
      if (bound && bound !== values[1]) return { rows: [], rowCount: 0 };
      if (!bound && [...this.kins.values()].includes(values[1])) throw new Error('unique bot binding');
      this.kins.set(values[0], values[1]);
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO memory_contexts')) return { rows: [], rowCount: 1 };
    if (sql.startsWith('INSERT INTO memories')) {
      const [kin_id, storyline, guild_id, channel_id, id, content, category, tags, importance, user] = values;
      const record = { kin_id, storyline, guild_id, channel_id, id, content, category, tags, importance, active: true,
        created_by: user, updated_by: user, created_at: new Date(), updated_at: new Date() };
      this.records.push(record);
      return { rows: [{ ...record }], rowCount: 1 };
    }
    assert.match(sql, /WHERE kin_id = \$1 AND storyline = \$2 AND guild_id = \$3 AND channel_id = \$4/);
    assert.equal(values.slice(0, 4).every(Boolean), true);
    let rows = this.records.filter(m => m.kin_id === values[0] && m.storyline === values[1] &&
      m.guild_id === values[2] && m.channel_id === values[3]);
    if (sql.includes('AND id')) rows = rows.filter(m => m.id === values[4]);
    if (sql.includes('active = true')) {
      assert.match(sql, /LIMIT 5/);
      rows = rows.filter(m => m.active && (m.importance === 5 || values[4].some(term => m.content.toLowerCase().includes(term) || m.tags.includes(term))))
        .sort((a, b) => b.importance - a.importance).slice(0, 5);
    }
    if (sql.startsWith('UPDATE')) {
      assert.match(sql, /updated_by=\$11/);
      rows.forEach(m => Object.assign(m, { content: values[5], category: values[6], tags: values[7], importance: values[8], active: values[9], updated_by: values[10] }));
    }
    if (sql.startsWith('DELETE')) this.records = this.records.filter(m => !rows.includes(m));
    if (sql.includes('OFFSET')) rows = rows.slice(values[4], values[4] + 10);
    return { rows: rows.map(m => ({ ...m })), rowCount: rows.length };
  }
}

test('all CRUD operations isolate kin, storyline, guild and channel, even with a known UUID', async () => {
  const store = new MemoryStore(new ScopedDatabase());
  const saved = await store.add(scope, input, admin);
  assert.equal((await store.show(scope, saved.id)).content, input.content);
  for (const foreign of [
    { ...scope, kinId: 'priya', discordBotId: '55555555555555555' },
    { ...scope, storyline: 'personal' },
    { ...scope, guildId: '66666666666666666' },
    { ...scope, channelId: '77777777777777777' },
  ]) {
    assert.deepEqual(await store.list(foreign), []);
    assert.equal(await store.show(foreign, saved.id), undefined);
    assert.equal(await store.edit(foreign, saved.id, { ...input, content: 'foreign overwrite' }, false, admin), undefined);
    assert.equal(await store.delete(foreign, saved.id), false);
    assert.deepEqual(await store.retrieve(foreign, ['theo']), []);
  }
  assert.equal((await store.show(scope, saved.id)).content, input.content);
  const changed = await store.edit(scope, saved.id, { ...input, content: 'Promise fulfilled.' }, false, admin);
  assert.equal(changed.active, false);
  assert.deepEqual(await store.retrieve(scope, ['promise']), []);
  assert.equal(await store.delete(scope, saved.id), true);
  assert.equal(await store.show(scope, saved.id), undefined);
});

test('stable kin IDs cannot bind to another bot and incomplete scopes are rejected', async () => {
  const store = new MemoryStore(new ScopedDatabase());
  await store.add(scope, input, admin);
  await assert.rejects(store.list({ ...scope, discordBotId: '88888888888888888' }));
  await assert.rejects(store.list({ ...scope, channelId: '' }));
});

test('retrieval selects relevant active notes, caps results and leaves recent context untouched', async () => {
  const store = new MemoryStore(new ScopedDatabase());
  for (let i = 0; i < 8; i++) await store.add(scope, { ...input, content: `Theo promise ${i}` }, admin);
  await store.add(scope, { ...input, content: 'Coffee preference', tags: ['coffee'] }, admin);
  const before = JSON.stringify(recent);
  const supplemented = await supplementConversation(store, scope, recent, 'Theo promise');
  assert.equal(supplemented.length, recent.length + 1);
  assert.match(supplemented[0].username, /application-generated/);
  assert.equal((supplemented[0].text.match(/^- /gm) || []).length, 5);
  assert.ok(!supplemented[0].text.includes('Coffee'));
  assert.deepEqual(supplemented.slice(1), recent);
  assert.equal(JSON.stringify(recent), before);
  const db = new ScopedDatabase();
  const bounded = new MemoryStore(db);
  for (let i = 0; i < 5; i++) await bounded.add(scope, { ...input, content: 'Theo ' + 'x'.repeat(990) }, admin);
  const result = await supplementConversation(bounded, scope, recent, 'Theo');
  assert.ok(result[0].text.length < 2250);
});

test('unexpected foreign or inactive records are never injected', async () => {
  const base = { ...input, kin_id: scope.kinId, storyline: scope.storyline, guild_id: scope.guildId, channel_id: scope.channelId, active: true };
  const rows = [
    { ...base, kin_id: 'priya' }, { ...base, storyline: 'personal' },
    { ...base, channel_id: 'another-channel' }, { ...base, guild_id: 'another-guild' }, { ...base, active: false },
  ];
  const result = await supplementConversation({ retrieve: async () => rows }, scope, recent, 'Theo');
  assert.strictEqual(result, recent);
});

test('database failure returns exact original recent context and never logs private details', async () => {
  const store = new MemoryStore({ query: async () => { throw new Error('PRIVATE CONTENT credentials DATABASE_URL'); } });
  const warnings = [];
  const original = console.warn;
  console.warn = message => warnings.push(message);
  try {
    assert.strictEqual(await supplementConversation(store, scope, recent, 'Theo'), recent);
    assert.ok(warnings.length);
    assert.ok(!warnings.join('').includes('PRIVATE CONTENT'));
  } finally { console.warn = original; }
});

test('DMs, unconfigured channels, stories and disabled memory never access the database', async () => {
  let calls = 0;
  const store = { retrieve: async () => { calls++; throw new Error('must not query'); } };
  for (const resolved of [
    resolveMemoryScope(config, scope.kinId, scope.discordBotId, null, scope.channelId),
    resolveMemoryScope(config, scope.kinId, scope.discordBotId, scope.guildId, 'unknown'),
    resolveMemoryScope(config, 'unknown', scope.discordBotId, scope.guildId, scope.channelId),
    resolveMemoryScope({ ...config, enabled: false }, scope.kinId, scope.discordBotId, scope.guildId, scope.channelId),
  ]) assert.strictEqual(await supplementConversation(store, resolved, recent, 'Theo'), recent);
  assert.equal(calls, 0);
});

function interaction(command, values = {}, user = admin, guildId = scope.guildId, channelId = scope.channelId) {
  const responses = [];
  const result = {
    user: { id: user }, client: { user: { id: scope.discordBotId } }, guildId, channelId,
    deferred: false, replied: false, responses,
    options: { getSubcommand: () => command, getString: key => values[key] ?? null,
      getInteger: key => values[key] ?? null, getBoolean: key => values[key] ?? null },
    reply: async payload => { result.replied = true; responses.push(payload); },
    deferReply: async payload => { result.deferred = true; responses.push(payload); },
    editReply: async payload => { responses.push(payload); },
  };
  return result;
}

test('unauthorized and unconfigured command invocations are private and do not access storage', async () => {
  let calls = 0;
  const runtime = { config, store: { list: async () => { calls++; throw new Error('must not query'); } } };
  for (const command of ['add', 'list', 'show', 'edit', 'delete']) {
    const denied = interaction(command, {}, '99999999999999999');
    await handleMemoryCommand(denied, scope.kinId, runtime);
    assert.equal(denied.responses[0].flags, MessageFlags.Ephemeral);
  }
  const unknown = interaction('list', {}, admin, scope.guildId, 'unknown');
  await handleMemoryCommand(unknown, scope.kinId, runtime);
  assert.equal(unknown.responses[0].flags, MessageFlags.Ephemeral);
  assert.equal(calls, 0);
});

test('manual slash-command CRUD is ephemeral, scoped, and deletion requires confirmation', async () => {
  const db = new ScopedDatabase();
  const runtime = { config, store: new MemoryStore(db) };
  const add = interaction('add', { content: input.content, category: input.category, tags: 'theo, recoupling' });
  await handleMemoryCommand(add, scope.kinId, runtime);
  assert.equal(db.records.length, 1);
  const id = db.records[0].id;
  const commands = [add];
  for (const [name, values] of [
    ['list', {}], ['show', { id }], ['edit', { id, content: 'Theo kept his promise.', active: false }],
    ['delete', { id, confirm: false }],
  ]) {
    const current = interaction(name, values);
    await handleMemoryCommand(current, scope.kinId, runtime);
    commands.push(current);
  }
  assert.equal(db.records[0].content, 'Theo kept his promise.');
  assert.equal(db.records[0].active, false);
  assert.equal(db.records.length, 1);
  const remove = interaction('delete', { id, confirm: true });
  await handleMemoryCommand(remove, scope.kinId, runtime);
  commands.push(remove);
  assert.equal(db.records.length, 0);
  for (const current of commands) assert.equal(current.responses[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(memoryCommandDefinition().toJSON().options.map(o => o.name), ['add', 'list', 'show', 'edit', 'delete']);
});

test('command database errors remain private and expose no SQL or credentials', async () => {
  const current = interaction('list');
  await handleMemoryCommand(current, scope.kinId, { config, store: { list: async () => { throw new Error('secret SQL credentials'); } } });
  assert.equal(current.responses[0].flags, MessageFlags.Ephemeral);
  assert.ok(current.responses.at(-1).content.includes('failed'));
  assert.ok(!current.responses.at(-1).content.includes('secret'));
});

test('configuration requires stable unique kin IDs and unambiguous channel/story bindings', () => {
  const original = { ...process.env };
  try {
    process.env.MEMORY_ENABLED = 'true';
    process.env.DATABASE_URL = 'postgres://example.invalid/test';
    process.env.MEMORY_ADMIN_USER_IDS = admin;
    process.env.MEMORY_CONTEXTS = JSON.stringify(config.contexts);
    const bots = [{ kinId: scope.kinId }];
    assert.equal(loadMemoryConfig(bots).contexts.length, 1);
    assert.throws(() => loadMemoryConfig([{}]));
    assert.throws(() => loadMemoryConfig([...bots, ...bots]));
    process.env.MEMORY_CONTEXTS = JSON.stringify([...config.contexts, { ...scope, storyline: 'alternate' }]);
    assert.throws(() => loadMemoryConfig(bots));
    process.env.MEMORY_CONTEXTS = JSON.stringify([{ ...scope, kinId: 'unknown' }]);
    assert.throws(() => loadMemoryConfig(bots));
    process.env.MEMORY_ENABLED = 'false';
    delete process.env.DATABASE_URL;
    assert.equal(loadMemoryConfig([{}]).enabled, false);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});
