const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('../dist/memoryStore');
const { supplementConversation } = require('../dist/memoryContext');
const { resolveMemoryScope, loadMemoryConfig } = require('../dist/memoryConfig');
const { handleMemoryCommand, memoryCommandDefinition } = require('../dist/memoryCommands');
const { MessageFlags } = require('discord.js');
const { metadataFor, privacyEligible } = require('../dist/memoryPolicy');
const { createMemoryDiagnostic, logMemoryDiagnostic } = require('../dist/memoryDiagnostics');

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
  async connect() { return {query:this.query.bind(this),release(){}}; }
  async query(sql, values) {
    if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rows:[],rowCount:0};
    if (sql.startsWith('SELECT auto_enabled FROM memory_contexts')) return {rows:[{auto_enabled:null}],rowCount:1};
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
      const [kin_id, storyline, guild_id, context_id, context_type, id, content, category, tags, importance, user, source_channel_id] = values;
      const record = { kin_id, storyline, guild_id, context_id, context_type, id, content, category, tags, importance, active: true, status: 'active', origin_kind: 'manual',
        metadata:JSON.parse(values[12]),original_content:content,edit_version:'1',
        source_channel_id, occurred_at: new Date(), source_message_ids: [], subjects: [], candidate_importance: null, confidence: null,
        created_by: user, updated_by: user, created_at: new Date(), updated_at: new Date() };
      this.records.push(record);
      return { rows: [{ ...record }], rowCount: 1 };
    }
    assert.match(sql, /WHERE kin_id = \$1 AND storyline = \$2 AND guild_id = \$3 AND context_id = \$4 AND context_type = \$5/);
    assert.equal(values.slice(0, 5).every(Boolean), true);
    let rows = this.records.filter(m => m.kin_id === values[0] && m.storyline === values[1] && m.guild_id === values[2] && m.context_id === values[3] && m.context_type === values[4]);
    if (sql.includes('AND id')) rows = rows.filter(m => m.id === values[5]);
    if (sql.includes("status <> 'archived'")) rows=rows.filter(m=>m.status!=='archived');
    if (sql.includes('active = true')) {
      assert.match(sql, /LIMIT 5/);
      assert.match(sql, /status = 'active'/);
      rows = rows.filter(m => privacyEligible(m.metadata,values[0],values[6]) && m.active && m.status === 'active' && (m.importance === 5 || values[5].some(term => m.content.toLowerCase().includes(term) || m.tags.includes(term))))
        .sort((a, b) => b.importance - a.importance).slice(0, 5);
    }
    if (sql.startsWith('UPDATE')) {
      if (sql.includes("status='archived'")) {
        rows.forEach(m=>Object.assign(m,{status:'archived',active:false}));
        return {rows:rows.map(m=>({...m})),rowCount:rows.length};
      }
      assert.match(sql, /updated_by=\$12/);
      rows.forEach(m => Object.assign(m, { content: values[6], category: values[7], tags: values[8], importance: values[9], active: values[10], status: values[10] ? 'active' : 'inactive', updated_by: values[11],metadata:JSON.parse(values[12]),edit_version:String(Number(m.edit_version)+1) }));
    }
    if (sql.startsWith('DELETE')) this.records = this.records.filter(m => !rows.includes(m));
    if (sql.includes('OFFSET')) rows = rows.slice(values[5], values[5] + 10);
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
  const base = { ...input, metadata:metadataFor(scope.kinId), kin_id: scope.kinId, storyline: scope.storyline, guild_id: scope.guildId, context_id: scope.channelId, context_type: 'channel', active: true, status: 'active' };
  const rows = [
    { ...base, kin_id: 'priya' }, { ...base, storyline: 'personal' },
    { ...base, context_id: 'another-channel' }, { ...base, guild_id: 'another-guild' }, { ...base, active: false },
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
  assert.equal(db.records.length, 1);
  assert.equal(db.records[0].status, 'archived');
  for (const current of commands) assert.equal(current.responses[0].flags, MessageFlags.Ephemeral);
  assert.deepEqual(memoryCommandDefinition().toJSON().options.slice(0, 5).map(o => o.name), ['add', 'list', 'show', 'edit', 'delete']);
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


async function captureMemoryDiagnostics(enabled, work) {
  const prior=process.env.MEMORY_DEBUG_ENABLED, originalInfo=console.info, originalWarn=console.warn, logs=[];
  process.env.MEMORY_DEBUG_ENABLED=enabled;
  console.info=line=>logs.push(line);console.warn=()=>{};
  try { await work(logs); } finally {
    console.info=originalInfo;console.warn=originalWarn;
    if(prior===undefined)delete process.env.MEMORY_DEBUG_ENABLED;else process.env.MEMORY_DEBUG_ENABLED=prior;
  }
}
const diagnosticScope={kinId:'vincent-villa',storyline:'villa-season-1',guildId:'111111111111111111',channelId:'1548814112673370272',discordBotId:'333333333333333333',visibility:'private'};
const diagnosticId='21e4ad40-d5d6-4cfb-9b44-d238223887be';
function diagnosticRow(overrides={}) {
  return {...input,id:diagnosticId,content:'CONFIDENTIAL_MEMORY_TEXT',kin_id:diagnosticScope.kinId,storyline:diagnosticScope.storyline,guild_id:diagnosticScope.guildId,
    context_id:diagnosticScope.channelId,context_type:'channel',active:true,status:'active',
    metadata:metadataFor(diagnosticScope.kinId,{visibility:'private',knownAt:'2026-01-01T00:00:00Z',sourceSnapshot:'CONFIDENTIAL_SOURCE_TEXT'}),...overrides};
}
function parseDiagnostic(logs){assert.equal(logs.length,1);assert.match(logs[0],/^\[MEMORY_DIAG\] /);return JSON.parse(logs[0].slice('[MEMORY_DIAG] '.length));}

test('memory diagnostics disabled produces no logs and leaves normal supplementation unchanged',async()=>{
  await captureMemoryDiagnostics('false',async logs=>{
    const diagnostic=createMemoryDiagnostic(diagnosticScope.kinId);assert.equal(diagnostic,undefined);
    const outgoing=await supplementConversation({retrieve:async()=>[diagnosticRow()]},diagnosticScope,recent,'test',diagnostic);
    logMemoryDiagnostic(diagnostic,outgoing);assert.equal(logs.length,0);assert.match(outgoing[0].text,/CONFIDENTIAL_MEMORY_TEXT/);
  });
});

test('enabled diagnostics correlate the actual outgoing block and log no memory/message/source/credential text',async()=>{
  await captureMemoryDiagnostics('true',async logs=>{
    const messages=[{username:'CONFIDENTIAL_NAME',text:'CONFIDENTIAL_MESSAGE_TEXT',timestamp:'2026-10-04T12:00:00Z'}];
    const rows=[diagnosticRow()],store={retrieve:async()=>rows};
    const plain=await supplementConversation(store,diagnosticScope,messages,'SECRET_TRIGGER_TEXT');
    const diagnostic=createMemoryDiagnostic(diagnosticScope.kinId);
    const outgoing=await supplementConversation(store,diagnosticScope,messages,'SECRET_TRIGGER_TEXT',diagnostic);
    assert.deepEqual(outgoing,plain);assert.deepEqual(outgoing.slice(1),messages);
    logMemoryDiagnostic(diagnostic,outgoing);const entry=parseDiagnostic(logs);
    assert.match(entry.requestId,/^[a-f0-9]{12}$/);assert.equal(entry.kinId,diagnosticScope.kinId);assert.equal(entry.storyline,diagnosticScope.storyline);
    assert.equal(entry.contextType,'channel');assert.equal(entry.contextId,diagnosticScope.channelId);assert.equal(entry.visibility,'private');
    assert.equal(entry.candidateCount,1);assert.deepEqual(entry.returnedMemoryUuids,[diagnosticId]);assert.equal(entry.testMemoryReturned,true);
    assert.equal(entry.memories[0].included,true);assert.equal(entry.memories[0].exclusionReason,null);assert.equal(entry.injectedMemoryCount,1);
    assert.equal(entry.continuityNoteCharacters,outgoing[0].text.length);assert.equal(entry.continuityBlockExists,true);assert.equal(entry.continuityBlockIndex,0);assert.equal(entry.outgoingConversationEntries,2);
    for(const forbidden of ['CONFIDENTIAL_','SECRET_TRIGGER_TEXT','DATABASE_URL','sourceSnapshot','share_code','Authorization','discordBotId'])assert.ok(!logs[0].includes(forbidden));
    logs.length=0;logMemoryDiagnostic(diagnostic,[messages[0],...outgoing]);assert.equal(parseDiagnostic(logs).continuityBlockIndex,1);
    console.info=()=>{throw new Error('logger unavailable');};assert.doesNotThrow(()=>logMemoryDiagnostic(diagnostic,outgoing));
  });
});

test('diagnostics explain returned-row status, scope, privacy, time and budget exclusions without changing filtering',async()=>{
  await captureMemoryDiagnostics('true',async logs=>{
    const privateMeta=diagnosticRow().metadata;
    const rows=[diagnosticRow(),diagnosticRow({id:'00000000-0000-4000-8000-000000000001',active:false,status:'inactive'}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000002',kin_id:'other-kin'}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000003',metadata:{...privateMeta,visibility:'production'}}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000004',metadata:{...privateMeta,knownAt:'2099-01-01T00:00:00Z'}}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000005',metadata:{...privateMeta,expiresAt:'2026-01-02T00:00:00Z'}}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000006',content:'x'.repeat(1000)}),
      diagnosticRow({id:'00000000-0000-4000-8000-000000000007',content:'y'.repeat(1000)})];
    const diagnostic=createMemoryDiagnostic(diagnosticScope.kinId),store={retrieve:async()=>rows};
    const outgoing=await supplementConversation(store,diagnosticScope,recent,'test',diagnostic);
    assert.deepEqual(outgoing,await supplementConversation(store,diagnosticScope,recent,'test'));
    logMemoryDiagnostic(diagnostic,outgoing);const entry=parseDiagnostic(logs);
    assert.deepEqual(entry.memories.map(m=>m.exclusionReason),[null,'status','scope','visibility','future knowledge','expired',null,'note budget']);
    assert.equal(entry.injectedMemoryCount,2);assert.equal(entry.memories[1].activeStatusEligible,false);assert.equal(entry.memories[2].scopeEligible,false);
    assert.equal(entry.memories[3].visibilityEligible,false);
    logs.length=0;const limitDiagnostic=createMemoryDiagnostic(diagnosticScope.kinId);
    const limited=await supplementConversation({retrieve:async()=>Array.from({length:6},(_,i)=>diagnosticRow({id:'00000000-0000-4000-8000-00000000000'+i}))},diagnosticScope,recent,'test',limitDiagnostic);
    logMemoryDiagnostic(limitDiagnostic,limited);assert.equal(parseDiagnostic(logs).memories[5].exclusionReason,'record limit');
  });
});

test('diagnostics distinguish empty, failed and skipped retrieval and preserve safe database fallback',async()=>{
  await captureMemoryDiagnostics('true',async logs=>{
    for(const [store,scopeValue,outcome,count] of [
      [{retrieve:async()=>[]},diagnosticScope,'returned',0],
      [{retrieve:async()=>{throw new Error('SECRET_DATABASE_URL_PASSWORD');}},diagnosticScope,'failed',null],
      [undefined,undefined,'not attempted',null],
    ]) {
      logs.length=0;const diagnostic=createMemoryDiagnostic(diagnosticScope.kinId);
      const outgoing=await supplementConversation(store,scopeValue,recent,'SECRET_MESSAGE',diagnostic);
      assert.strictEqual(outgoing,recent);logMemoryDiagnostic(diagnostic,outgoing);
      const entry=parseDiagnostic(logs);assert.equal(entry.retrievalOutcome,outcome);assert.equal(entry.candidateCount,count);
      assert.equal(entry.continuityBlockExists,false);assert.equal(entry.continuityBlockIndex,null);assert.equal(entry.injectedMemoryCount,0);
      assert.equal(entry.continuityNoteCharacters,0);assert.ok(!logs[0].includes('SECRET_'));
    }
  });
});
