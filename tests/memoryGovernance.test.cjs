const test=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {MemoryStore,MemoryEditConflict}=require('../dist/memoryStore');
const {MemoryProduction,bundleScope}=require('../dist/memoryProduction');
const {metadataFor,privacyEligible,authority}=require('../dist/memoryPolicy');
const {extractCandidates}=require('../dist/memoryExtraction');
const {supplementConversation}=require('../dist/memoryContext');
const {handleMemoryCommand,memoryCommandDefinition}=require('../dist/memoryCommands');
const {migrateDatabase}=require('../dist/database');
const scope={kinId:'vincent-villa',storyline:'villa-s1',guildId:'111111111111111111',channelId:'222222222222222222',discordBotId:'333333333333333333'};
const admin='444444444444444444';
const input={content:'Vincent promised Dee a conversation.',category:'promise',importance:3,tags:['promise']};
const candidate={...input,importance:8,confidence:0.6,subjects:[scope.kinId],sourceChannelId:scope.channelId,occurredAt:'2026-10-01T00:00:00Z',sourceMessageIds:['555555555555555555']};
const past='2026-01-01T00:00:00Z';
let pg,db,store,production;
test.before(async()=>{
 pg=await PGlite.create();
 // PGlite has one backend. Schedule whole client transactions exclusively, not individual
 // statements, so concurrent callers cannot accidentally share one backend transaction.
 let tail=Promise.resolve();
 const acquire=async()=>{let release;const next=new Promise(r=>release=r);const previous=tail;tail=next;await previous;return release;};
 const query=async(sql,values)=>{const r=values?await pg.query(sql,values):(await pg.exec(sql)).at(-1);return{rows:r.rows||[],rowCount:r.affectedRows||r.rows?.length||0};};
 db={query:async(...args)=>{const release=await acquire();try{return await query(...args);}finally{release();}},
  connect:async()=>{const release=await acquire();return{query,release};}};
 await migrateDatabase(db);await migrateDatabase(db);
 store=new MemoryStore(db);production=new MemoryProduction(store);
});
test.beforeEach(async()=>{await pg.exec('TRUNCATE memories,memory_contexts,memory_kins,memory_audit,memory_binding_history CASCADE');});
test.after(async()=>{await pg?.close();});

test('privacy gates precede ranking: pinned private/confessional/production notes never enter public prompts',async()=>{
 for(const visibility of ['public','private','confessional','production'])await store.add(scope,{...input,content:`${visibility} promise`,importance:5,metadata:{visibility,pinned:true}},admin);
 assert.deepEqual((await store.retrieve(scope,['promise'])).map(m=>m.metadata.visibility),['public']);
 assert.deepEqual(new Set((await store.retrieve({...scope,visibility:'private'},['promise'])).map(m=>m.metadata.visibility)),new Set(['public','private']));
 assert.deepEqual(new Set((await store.retrieve({...scope,visibility:'confessional'},['promise'])).map(m=>m.metadata.visibility)),new Set(['public','confessional']));
 assert.deepEqual(await store.retrieve({...scope,visibility:'production'},['promise']),[]);
 const recent=[{username:'Dee',text:'promise',timestamp:past}];
 const malicious=(await store.scan(scope)).filter(m=>m.metadata.visibility!=='public');
 assert.strictEqual(await supplementConversation({retrieve:async()=>malicious},scope,recent,'promise'),recent);
});
test('knowledge ownership and reveal times are explicit, scoped and cannot create retroactive omniscience',async()=>{
 const secret=await store.add({...scope,visibility:'private'},{...input,metadata:{visibility:'private',knownAt:'2099-01-01T00:00:00Z'}},admin);
 assert.deepEqual(await store.retrieve({...scope,visibility:'private'},['promise']),[]);
 assert.equal(privacyEligible({...secret.metadata,knownByKinIds:['dee-villa']},scope.kinId,'private'),false);
 await assert.rejects(store.add(scope,{...input,metadata:{knownByKinIds:['dee-villa']}},admin));
 const recipient={...scope,kinId:'dee-villa',discordBotId:'666666666666666666',visibility:'private'};
 const revealed=await store.add(recipient,{...input,metadata:{visibility:'private',revealOf:secret.id,knownAt:past}},admin);
 assert.equal(revealed.metadata.revealOf,secret.id);
 assert.equal((await store.retrieve(recipient,['promise'])).length,1);
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
 const learned=await store.add(scope,{...input,metadata:{knownAt:'2026-02-01T00:00:00Z'}},admin);
 assert.ok(!(await store.retrieve(scope,['promise'],new Date('2026-01-15T00:00:00Z'))).some(m=>m.id===learned.id));
 assert.ok((await store.retrieve(scope,['promise'],new Date('2026-03-01T00:00:00Z'))).some(m=>m.id===learned.id));
});
test('auto extraction defaults narrow, retains speaker/suspicion/source, and approval never broadens privacy',async()=>{
 const text='Dee thinks Adrian is jealous and suspects he is lying.';
 const extracted=extractCandidates(scope,[{authorId:admin,authorName:'Dee',kind:'user',text,guildId:scope.guildId,channelId:scope.channelId,timestamp:past,messageIds:candidate.sourceMessageIds}])[0];
 const pending=await store.createPending(scope,extracted);
 assert.equal(pending.metadata.statementType,'suspicion');assert.equal(pending.metadata.speakerId,admin);
 assert.equal(pending.metadata.sourceSnapshot,text);assert.equal(pending.metadata.visibility,'private');
 await store.edit(scope,pending.id,{...input,content:'Dee believes Adrian may be jealous.',metadata:{statementType:'belief'}},true,admin);
 const approved=await store.approve(scope,pending.id,admin);
 assert.equal(approved.original_content,pending.content);assert.equal(approved.reviewed_by,admin);
 assert.equal(approved.metadata.visibility,'private');assert.deepEqual(await store.retrieve(scope,['adrian']),[]);
 assert.ok((await store.history(scope,pending.id)).some(r=>r.operation==='edit'));
});
test('events remain historical, states supersede, expired temporary states are filtered without deletion',async()=>{
 const event=await store.add(scope,{...input,content:'Vincent and Naomi coupled on Day 3.',category:'villa_event',metadata:{memoryType:'event'}},admin);
 const state=await store.add(scope,{...input,content:'Vincent is coupled with Naomi.',metadata:{memoryType:'state'}},admin);
 const next=await store.createPending(scope,{...candidate,content:'Vincent is now coupled with Dee.',metadata:{memoryType:'state',visibility:'public'}});
 await assert.rejects(store.approve(scope,next.id,admin,event.id));
 await store.approve(scope,next.id,admin,state.id);
 assert.equal((await store.show(scope,state.id)).status,'superseded');
 assert.equal((await store.show(scope,event.id)).status,'active');
 assert.ok((await store.retrieve(scope,['day'])).some(m=>m.id===event.id));
 const temporary=await store.add(scope,{...input,metadata:{memoryType:'state',expiresAt:past}},admin);
 assert.ok(!(await store.retrieve(scope,['promise'])).some(m=>m.id===temporary.id));
 assert.equal((await store.show(scope,temporary.id)).status,'active');
 await assert.rejects(store.add(scope,{...input,metadata:{memoryType:'event',expiresAt:past}},admin));
});
test('retcons have highest authority, preserve old canon in revisions and can resolve flagged contradictions',async()=>{
 const old=await store.add(scope,{...input,content:'Vincent hates tequila.',category:'preference'},admin);
 const other=await store.add(scope,{...input,content:"Vincent's favorite liquor is tequila.",category:'preference'},admin);
 assert.equal((await store.conflicts(scope)).length,1);assert.deepEqual(await store.retrieve(scope,['tequila']),[]);
 const corrected=await store.retcon(scope,old.id,'Vincent likes tequila.',admin,'Original summary was incorrect; no in-story change.');
 assert.equal(authority(corrected.metadata),4);assert.equal(corrected.original_content,old.content);
 assert.equal((await store.conflicts(scope)).length,0);
 assert.equal((await store.retrieve(scope,['tequila']))[0].id,old.id);
 const history=await store.history(scope,old.id);assert.equal(history[0].operation,'retcon');
 assert.ok(history.some(r=>r.snapshot.content==='Vincent hates tequila.'));
 assert.equal((await store.show(scope,other.id)).status,'active');
});
test('archive and revision restore retain history and do not bypass approval or revive rejected candidates',async()=>{
 const manual=await store.add(scope,input,admin);const original=(await store.history(scope,manual.id))[0];
 await store.edit(scope,manual.id,{...input,content:'Changed promise.'},true,admin);
 await store.delete(scope,manual.id,admin);
 assert.equal(await store.show(scope,manual.id),undefined);
 const restored=await store.restore(scope,manual.id,String(original.id),admin);
 assert.equal(restored.content,input.content);assert.equal(restored.status,'inactive');
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
 const pending=await store.createPending(scope,{...candidate,content:'A distinct promise for later.'});
 const revision=(await store.history(scope,pending.id))[0];await store.reject(scope,pending.id,admin);
 assert.equal((await store.restore(scope,pending.id,String(revision.id),admin)).status,'rejected');
 assert.equal(await store.approve(scope,pending.id,admin),undefined);
 const operations=(await db.query('SELECT operation FROM memory_audit')).rows.map(r=>r.operation);
 for(const op of ['add','edit','archive','restore','reject'])assert.ok(operations.includes(op));
});
test('manual consolidation preserves duplicate records, source links and the later knowledge boundary',async()=>{
 const first=await store.add(scope,{...input,metadata:{knownAt:past}},admin);
 const second=await store.add(scope,{...input,metadata:{knownAt:'2026-02-01T00:00:00Z'}},admin);
 assert.equal(await store.merge(scope,first.id,second.id,admin),true);
 assert.equal((await store.show(scope,first.id)).metadata.knownAt,'2026-02-01T00:00:00.000Z');
 assert.deepEqual((await store.show(scope,first.id)).metadata.mergedFrom,[second.id]);
 assert.equal((await store.show(scope,second.id,true)).status,'archived');
 const privateNote=await store.add(scope,{...input,metadata:{visibility:'private'}},admin);
 await assert.rejects(store.merge(scope,first.id,privateNote.id,admin));
});
function bundle(items,overrides={}){return{version:1,scope:bundleScope(scope),source:'kindroid_export',namespace:'vincent_export',authoritative:false,items,...overrides};}
test('Kindroid reconciliation previews new/unchanged/changed/conflict/obsolete and stages without replacing canon',async()=>{
 const old=await store.add(scope,{...input,metadata:{sourceType:'kindroid_export',importNamespace:'vincent_export',externalId:'birthday',knownAt:past}},admin);
 await store.approve(scope,old.id,admin);
 const same=bundle([{...input,externalId:'birthday'}]);assert.equal((await production.preview(scope,same)).entries[0].action,'unchanged');
 const changed=bundle([{...input,content:'Vincent promised a different conversation.',externalId:'birthday'}],{authoritative:true});
 const preview=await production.preview(scope,changed);assert.equal(preview.entries[0].action,'changed');
 const staged=await production.stage(scope,changed,preview.token,admin);
 assert.equal((await store.show(scope,old.id)).status,'active');
 assert.equal((await store.show(scope,staged[0])).status,'pending');
 assert.equal((await store.show(scope,staged[0])).metadata.authoritative,true);
 assert.equal((await production.preview(scope,changed)).entries[0].action,'duplicate');
 assert.equal((await production.preview(scope,bundle([{...input,content:'Conflicting edit.',externalId:'birthday'}]))).entries[0].action,'conflict');
 assert.ok((await production.preview(scope,bundle([]))).entries.some(e=>e.action==='obsolete'));
 await store.approve(scope,staged[0],admin,old.id);
 assert.equal((await store.show(scope,old.id)).status,'superseded');
});
test('structured export round-trips without duplicate canon and preserves original provenance',async()=>{
 const old=await store.add(scope,input,admin);
 const exported=await production.export(scope);
 assert.match(exported.readable,/Vincent promised/);
 assert.equal(exported.bundle.items[0].original_content,input.content);
 assert.equal((await production.preview(scope,exported.bundle)).entries[0].action,'unchanged');
 const preview=await production.preview(scope,exported.bundle);
 assert.deepEqual(await production.stage(scope,exported.bundle,preview.token,admin),[]);
 assert.equal((await store.scan(scope)).length,1);
 assert.equal((await store.show(scope,old.id)).metadata.sourceType,'manual');
});
test('changed re-import preserves original Discord evidence and source authority lineage',async()=>{
 const old=await store.add(scope,{...input,provenance:{sourceChannelId:scope.channelId,occurredAt:past,
  sourceMessageIds:candidate.sourceMessageIds,subjects:['dee-villa']},metadata:{speakerId:'dee-villa'}},admin);
 const exported=(await production.export(scope)).bundle;
 exported.authoritative=true;exported.items[0].content='Vincent clarified the original promise.';
 const preview=await production.preview(scope,exported);
 const ids=await production.stage(scope,exported,preview.token,admin);
 const imported=await store.show(scope,ids[0]);
 assert.deepEqual(imported.source_message_ids,candidate.sourceMessageIds);
 assert.equal(imported.occurred_at.toISOString(),new Date(past).toISOString());
 assert.equal(imported.metadata.originalSourceType,'manual');assert.equal(imported.metadata.importOriginalContent,old.original_content);
 assert.equal(imported.metadata.sourceCreatedBy,admin);
 assert.deepEqual(imported.subjects,['dee-villa']);
});
test('bulk imports validate scope and dates, reject stale previews, are transactional and default to pending private',async()=>{
 const items=[{...input,externalId:'one'},{...input,content:'Vincent prefers quiet mornings.',externalId:'two',category:'preference'}];
 const proposed=bundle(items);
 const preview=await production.preview(scope,proposed);
 await assert.rejects(production.preview({...scope,storyline:'another'},proposed));
 await assert.rejects(production.preview(scope,bundle([{...input,externalId:'bad',metadata:{knownAt:'not a date'}}])));
 await store.add(scope,{...input,content:'An intervening admin note.'},admin);
 await assert.rejects(production.stage(scope,proposed,preview.token,admin));
 const fresh=await production.preview(scope,proposed);const ids=await production.stage(scope,proposed,fresh.token,admin);
 assert.equal(ids.length,2);for(const id of ids){const m=await store.show(scope,id);assert.equal(m.status,'pending');assert.equal(m.metadata.visibility,'private');}
 const rollback=bundle([{...input,externalId:'rollback-one'},{...input,content:'Another pending item.',externalId:'rollback-two'}],{namespace:'rollback'});
 const next=await production.preview(scope,rollback);const before=(await store.scan(scope)).length;
 const realAdd=MemoryStore.prototype.add;
 MemoryStore.prototype.add=async function(s,i,a){if(i.metadata.externalId==='rollback-two')throw new Error('simulated failure');return realAdd.call(this,s,i,a);};
 try{await assert.rejects(production.stage(scope,rollback,next.token,admin));}finally{MemoryStore.prototype.add=realAdd;}
 assert.equal((await store.scan(scope)).length,before);
});
test('current-canon snapshots exclude pending, archived, superseded, expired and private notes but retain relevant old events',async()=>{
 const active=await store.add(scope,{...input,metadata:{domain:'identity',pinned:true}},admin);
 const event=await store.add(scope,{...input,content:'Day 3 villa challenge result.',category:'challenge_outcome',metadata:{memoryType:'event',knownAt:past}},admin);
 await store.createPending(scope,candidate);
 await store.add(scope,{...input,metadata:{visibility:'private'}},admin);
 await store.add(scope,{...input,metadata:{memoryType:'state',expiresAt:past}},admin);
 const archived=await store.add(scope,input,admin);await store.delete(scope,archived.id,admin);
 assert.deepEqual(new Set((await production.snapshot(scope)).map(m=>m.id)),new Set([active.id,event.id]));
 assert.ok((await store.retrieve(scope,['day','challenge'])).some(m=>m.id===event.id));
});
test('pending retention archives rather than deletes; edited/deleted source flags preserve original evidence',async()=>{
 const pending=await store.createPending(scope,{...candidate,metadata:{sourceSnapshot:'Original source message.'}});
 await db.query("UPDATE memories SET created_at=now()-interval '40 days' WHERE id=$1",[pending.id]);
 assert.equal(await store.archivePending(scope,30,admin),1);
 const archived=await store.show(scope,pending.id,true);assert.equal(archived.status,'archived');assert.equal(archived.original_content,pending.content);
 await store.flagSource(scope,pending.id,'Source deleted; review provenance.',admin);
 assert.equal((await store.show(scope,pending.id,true)).metadata.sourceSnapshot,'Original source message.');
 assert.ok((await store.history(scope,pending.id)).some(r=>r.operation==='source_review'));
 assert.equal(await store.createPending(scope,candidate),undefined);
});
test('stable kin rebind is controlled and audited; approved aliases normalize without ambiguous guessing',async()=>{
 const saved=await store.add(scope,input,admin);
 await store.setAlias(scope,'Dee','dee-villa',admin);
 assert.equal(await store.resolveAlias(scope,'DEE'),'dee-villa');assert.equal(await store.resolveAlias(scope,'D'),undefined);
 assert.equal(await store.resolveAlias({...scope,storyline:'other'},'Dee'),undefined);
 await assert.rejects(store.rebindKin(scope,'wrong','666666666666666666',admin,'bot rebuild'));
 await store.rebindKin(scope,scope.discordBotId,'666666666666666666',admin,'bot rebuild');
 await assert.rejects(store.show(scope,saved.id));
 assert.equal((await store.show({...scope,discordBotId:'666666666666666666'},saved.id)).id,saved.id);
 assert.equal((await db.query('SELECT * FROM memory_binding_history')).rows.length,1);
});
test('new slash commands and metadata edits remain admin-only and ephemeral',async()=>{
 const definition=memoryCommandDefinition().toJSON();assert.ok(definition.options.length<=25);
 for(const command of ['add','edit'])assert.ok(definition.options.find(c=>c.name===command).options.some(o=>o.name==='visibility'));
 const runtime={config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store};
 for(const command of ['history','restore','retcon','merge','conflicts','snapshot']){
  const responses=[];
  await handleMemoryCommand({user:{id:'999999999999999999'},reply:async p=>responses.push(p)},scope.kinId,runtime);
  assert.equal(responses[0].flags,64);
 }
});
test('authorized metadata edits, history and snapshots are private and expose reviewable files',async()=>{
 const memory=await store.add(scope,input,admin);
 const runtime={config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store};
 function interaction(command,values={}){
  const r={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,
   responses:[],deferred:false,replied:false,options:{getSubcommand:()=>command,getString:k=>values[k]??null,getInteger:k=>values[k]??null,getBoolean:k=>values[k]??null}};
  r.reply=async p=>{r.responses.push(p);r.replied=true;};r.deferReply=async p=>{r.responses.push(p);r.deferred=true;};r.editReply=async p=>{r.responses.push(p);};return r;
 }
 for(const [command,values] of [['history',{id:memory.id}],['snapshot',{}],['conflicts',{}],['edit',{id:memory.id,visibility:'private','known-by':scope.kinId,statement:'belief'}]]){
  const invocation=interaction(command,values);await handleMemoryCommand(invocation,scope.kinId,runtime);
  assert.equal(invocation.responses[0].flags,64);
  if(['history','snapshot'].includes(command))assert.ok(invocation.responses.at(-1).files[0].attachment.length);
 }
 assert.equal((await store.show(scope,memory.id)).metadata.visibility,'private');
 assert.equal((await store.show(scope,memory.id)).metadata.statementType,'belief');
 assert.ok((await store.audit(scope)).some(r=>r.operation==='visibility_change'));
});

test('public snapshot followed by private restriction rejects the stale public edit and retains audit history',async()=>{
 const memory=await store.add(scope,input,admin);
 const stale=await store.show(scope,memory.id);assert.equal(stale.metadata.visibility,'public');
 await store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin);
 await assert.rejects(store.edit(scope,memory.id,{...input,content:'Stale text edit.',metadata:stale.metadata},undefined,admin,stale.edit_version),MemoryEditConflict);
 const current=await store.show(scope,memory.id);assert.equal(current.metadata.visibility,'private');assert.equal(current.content,input.content);
 const fresh=await store.edit(scope,memory.id,{...input,content:'Fresh text edit.'},undefined,admin,current.edit_version);
 assert.equal(fresh.metadata.visibility,'private');
 const history=await store.history(scope,memory.id);assert.equal(history.length,3);
 assert.ok((await store.audit(scope)).some(r=>r.operation==='visibility_change'));
 assert.deepEqual(await store.retrieve(scope,['promise']),[]);
});

test('a Discord edit prepared before a privacy change returns a private retry response',async()=>{
 const memory=await store.add(scope,input,admin),responses=[];
 const commandStore=Object.create(store);
 commandStore.show=async(...args)=>{
  const stale=await store.show(...args);
  await store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin);
  return stale;
 };
 const invocation={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,
  deferred:false,replied:false,options:{getSubcommand:()=> 'edit',getString:k=>k==='id'?memory.id:k==='content'?'A stale public edit.':null,getInteger:()=>null,getBoolean:()=>null},
  deferReply:async p=>{responses.push(p);invocation.deferred=true;},editReply:async p=>responses.push(p)};
 await handleMemoryCommand(invocation,scope.kinId,{config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store:commandStore});
 assert.equal(responses[0].flags,64);assert.match(responses.at(-1).content,/Inspect it again and retry/);
 const current=await store.show(scope,memory.id);assert.equal(current.metadata.visibility,'private');assert.equal(current.content,input.content);
});

test('overlapping row-locked edits serialize: a paused public read cannot overwrite the queued private change',async()=>{
 const memory=await store.add(scope,input,admin);
 let resume,captured;const gate=new Promise(r=>resume=r),ready=new Promise(r=>captured=r);const sql=[];
 const pausedDb={query:db.query,connect:async()=>{
  const client=await db.connect();return {release:client.release,query:async(query,values)=>{
   sql.push(query);const result=await client.query(query,values);
   if(query.includes('xmin::text')&&query.includes('FOR UPDATE')){assert.equal(result.rows[0].metadata.visibility,'public');captured();await gate;}
   return result;
  }};
 }};
 const editing=new MemoryStore(pausedDb).edit(scope,memory.id,{...input,content:'Text edit that read public.'},undefined,admin);
 await ready;
 let privateFinished=false;
 const restricting=store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin).then(r=>{privateFinished=true;return r;});
 await new Promise(r=>setImmediate(r));assert.equal(privateFinished,false);
 resume();await editing;await restricting;
 assert.equal((await store.show(scope,memory.id)).metadata.visibility,'private');
 assert.ok(sql[0]==='BEGIN');assert.ok(sql.some(q=>q.includes('memory_contexts')&&q.includes('FOR UPDATE')));
 assert.equal(sql.at(-1),'COMMIT');
});

test('concurrent governance patches preserve each other; competing edits from one version require an explicit retry',async()=>{
 const memory=await store.add(scope,input,admin);
 await Promise.all([
  store.edit(scope,memory.id,{...input,metadata:{visibility:'private'}},undefined,admin),
  store.edit(scope,memory.id,{...input,metadata:{knownByKinIds:[scope.kinId,'dee-villa'],sourceType:'production_override',authoritative:true}},undefined,admin),
 ]);
 const current=await store.show(scope,memory.id);
 assert.equal(current.metadata.visibility,'private');assert.deepEqual(current.metadata.knownByKinIds,[scope.kinId,'dee-villa']);assert.equal(authority(current.metadata),4);
 const results=await Promise.allSettled([
  store.edit(scope,memory.id,{...input,metadata:{pinned:true}},undefined,admin,current.edit_version),
  store.edit(scope,memory.id,{...input,metadata:{domain:'identity'}},undefined,admin,current.edit_version),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.ok(results.find(r=>r.status==='rejected').reason instanceof MemoryEditConflict);
 const after=await store.show(scope,memory.id);assert.equal(after.metadata.visibility,'private');assert.equal(authority(after.metadata),4);
});

test('edit/approve ordering is deterministic and stale pre-approval edits cannot deactivate approved canon',async()=>{
 const pending=await store.createPending(scope,candidate);
 const before=await store.show(scope,pending.id);
 const editedText='Vincent clarified his promise to Dee.';
 await Promise.all([
  store.edit(scope,pending.id,{...input,content:editedText},undefined,admin,before.edit_version),
  store.approve(scope,pending.id,admin),
 ]);
 let current=await store.show(scope,pending.id);assert.equal(current.status,'active');assert.equal(current.content,editedText);assert.equal(current.original_content,pending.content);
 await assert.rejects(store.edit(scope,pending.id,input,false,admin,before.edit_version),MemoryEditConflict);
 const afterApproval=await store.edit(scope,pending.id,{...input,content:editedText},undefined,admin,current.edit_version);
 assert.equal(afterApproval.status,'active');assert.equal(afterApproval.metadata.visibility,'private');
 const next=await store.createPending(scope,{...candidate,content:'A different promise for tomorrow.'});
 const preApprove=await store.show(scope,next.id);
 const order=await Promise.allSettled([store.approve(scope,next.id,admin),store.edit(scope,next.id,input,undefined,admin,preApprove.edit_version)]);
 assert.equal(order[0].status,'fulfilled');assert.ok(order[1].reason instanceof MemoryEditConflict);
 assert.equal((await store.show(scope,next.id)).status,'active');
});

test('stale edits cannot undo retcon authority or overwrite merge governance',async()=>{
 const memory=await store.add(scope,{...input,metadata:{knownAt:past}},admin);const stale=await store.show(scope,memory.id);
 await store.retcon(scope,memory.id,'Vincent clarified the promise.',admin,'Explicit production correction.');
 await assert.rejects(store.edit(scope,memory.id,{...input,metadata:stale.metadata},undefined,admin,stale.edit_version),MemoryEditConflict);
 assert.equal(authority((await store.show(scope,memory.id)).metadata),4);
 const first=await store.add(scope,{...input,metadata:{knownAt:past}},admin),second=await store.add(scope,{...input,metadata:{knownAt:past}},admin);
 const oldKeep=await store.show(scope,first.id),oldDuplicate=await store.show(scope,second.id);
 await store.merge(scope,first.id,second.id,admin);
 await assert.rejects(store.edit(scope,first.id,{...input,metadata:oldKeep.metadata},undefined,admin,oldKeep.edit_version),MemoryEditConflict);
 await assert.rejects(store.edit(scope,second.id,input,undefined,admin,oldDuplicate.edit_version),MemoryEditConflict);
 assert.deepEqual((await store.show(scope,first.id)).metadata.mergedFrom,[second.id]);
 assert.equal((await store.show(scope,second.id,true)).status,'archived');
});

test('same-batch equivalent imports stage once and preserve both external keys and source evidence',async()=>{
 const common={...input,provenance:{sourceChannelId:scope.channelId,occurredAt:past,subjects:['dee-villa'],sourceMessageIds:[]}};
 const proposed=bundle([
  {...common,externalId:'first',provenance:{...common.provenance,sourceMessageIds:['555555555555555555']}},
  {...common,externalId:'second',provenance:{...common.provenance,sourceMessageIds:['666666666666666666']}},
 ]);
 const preview=await production.preview(scope,proposed);assert.deepEqual(preview.entries.map(e=>e.action),['new','duplicate']);assert.equal(preview.entries[1].duplicateOfIndex,0);
 const ids=await production.stage(scope,proposed,preview.token,admin);assert.equal(ids.length,1);
 const saved=await store.show(scope,ids[0]);assert.deepEqual(saved.metadata.importAliases,['second']);
 assert.deepEqual(saved.source_message_ids,['555555555555555555','666666666666666666']);assert.equal(saved.status,'pending');assert.equal(saved.metadata.visibility,'private');
 const repeated=await production.preview(scope,proposed);assert.deepEqual(repeated.entries.map(e=>e.action),['duplicate','duplicate']);
 assert.deepEqual(await production.stage(scope,proposed,repeated.token,admin),[]);
});

test('batch deduplication does not collapse differences in privacy, attribution, belief, or event time',async()=>{
 for(const difference of [{visibility:'private'},{statementType:'suspicion'},{speakerId:'dee-villa'},{knownAt:past}]){
  const proposed=bundle([{...input,externalId:'a',metadata:{visibility:'public'}},{...input,externalId:'b',metadata:{visibility:'public',...difference}}]);
  assert.deepEqual((await production.preview(scope,proposed)).entries.map(e=>e.action),['new','new']);
 }
 const event={...input,metadata:{memoryType:'event'},provenance:{sourceChannelId:scope.channelId,occurredAt:past,sourceMessageIds:[],subjects:[]}};
 assert.deepEqual((await production.preview(scope,bundle([{...event,externalId:'day-one'},{...event,externalId:'day-two',provenance:{...event.provenance,occurredAt:'2026-02-01T00:00:00Z'}}]))).entries.map(e=>e.action),['new','new']);
});

function failingClientDatabase(pattern){return {query:db.query,connect:async()=>{const client=await db.connect();return{release:client.release,query:async(sql,values)=>{if(pattern.test(sql))throw new Error('Injected operation failure');return client.query(sql,values);}};}};}
test('alias mutation and audit are atomic, including failed replacement and first scope registration',async()=>{
 await store.setAlias(scope,'Dee','dee-villa',admin);
 const failing=new MemoryStore(failingClientDatabase(/INSERT INTO memory_audit/));
 await assert.rejects(failing.setAlias(scope,'Dee','other-kin',admin));
 assert.equal(await store.resolveAlias(scope,'Dee'),'dee-villa');assert.equal((await store.audit(scope)).filter(r=>r.operation==='alias').length,1);
 const fresh={...scope,kinId:'new-kin',discordBotId:'777777777777777777'};
 await assert.rejects(failing.setAlias(fresh,'D','dee-villa',admin));
 assert.equal((await db.query('SELECT * FROM memory_kins WHERE id=$1',[fresh.kinId])).rows.length,0);
 assert.equal((await db.query('SELECT * FROM memory_aliases WHERE kin_id=$1',[fresh.kinId])).rows.length,0);
});

test('failed memory creation rolls back its kin/context binding too; public exports explicitly warn about confidential originals',async()=>{
 const failing=new MemoryStore(failingClientDatabase(/INSERT INTO memories/));
 await assert.rejects(failing.add(scope,input,admin));
 assert.equal((await db.query('SELECT * FROM memory_kins')).rows.length,0);assert.equal((await db.query('SELECT * FROM memory_contexts')).rows.length,0);
 const privateMemory=await store.add(scope,{...input,content:'Confidential original promise.',metadata:{visibility:'private'}},admin);
 await store.edit(scope,privateMemory.id,{...input,content:'Public summary.',metadata:{visibility:'public'}},undefined,admin);
 const exported=await production.export(scope,{visibility:'public'});
 assert.match(exported.warning,/NOT PUBLICATION-SAFE/);assert.match(exported.readable,/confidential/i);
 assert.equal(exported.bundle.items[0].original_content,'Confidential original promise.');
});


async function restoredInactive(inputOverride={}) {
 const memory=await store.add(scope,{...input,...inputOverride},admin);
 const original=(await store.history(scope,memory.id))[0];
 await store.edit(scope,memory.id,{...input,content:'Later edited summary.'},undefined,admin);
 return store.restore(scope,memory.id,String(original.id),admin);
}

test('activation restores reviewed inactive canon while preserving private governance and all previous history',async()=>{
 const restored=await restoredInactive({metadata:{visibility:'private',knownAt:past,knownByKinIds:[scope.kinId,'dee-villa'],sourceSnapshot:'Private source evidence.',sourceType:'production_override',authoritative:true},
  provenance:{sourceChannelId:scope.channelId,occurredAt:past,subjects:['dee-villa'],sourceMessageIds:['555555555555555555']}});
 assert.equal(restored.status,'inactive');assert.equal(restored.active,false);
 const previousHistory=await store.history(scope,restored.id),previousAudit=await store.audit(scope);
 const activated=await store.activate(scope,restored.id,admin);
 assert.equal(activated.active,true);assert.equal(activated.status,'active');
 for(const field of ['content','metadata','original_content','kin_id','storyline','guild_id','context_id','context_type','source_channel_id','source_message_ids','subjects','origin_kind','created_by','created_at','occurred_at'])assert.deepEqual(activated[field],restored[field],field);
 assert.equal(activated.metadata.visibility,'private');assert.deepEqual(await store.retrieve(scope,['promise']),[]);
 assert.ok((await store.retrieve({...scope,visibility:'private'},['promise'])).some(m=>m.id===restored.id));
 const history=await store.history(scope,restored.id);assert.equal(history.length,previousHistory.length+1);assert.deepEqual(history.slice(1),previousHistory);
 assert.equal(history[0].operation,'activate');assert.equal(history[0].actor_id,admin);assert.equal(history[0].snapshot.change_type,'activate');assert.equal(history[0].snapshot.active,true);
 const audit=await store.audit(scope);assert.equal(audit.length,previousAudit.length+1);assert.deepEqual(audit.slice(1),previousAudit);
 assert.equal(audit[0].operation,'activate');assert.equal(audit[0].actor_id,admin);assert.equal(audit[0].memory_id,restored.id);
});

test('activation refuses pending/rejected/archived/superseded/already-active records and invalid or foreign IDs',async()=>{
 for(const status of ['pending','rejected','archived','superseded','active']) {
  const memory=await store.add(scope,{...input,content:'Activation guard '+status},admin);
  await db.query('UPDATE memories SET status=$2,active=$3 WHERE id=$1',[memory.id,status,status==='active']);
  const history=await store.history(scope,memory.id),audit=await store.audit(scope);
  assert.equal(await store.activate(scope,memory.id,admin),undefined);
  assert.deepEqual(await store.history(scope,memory.id),history);assert.deepEqual(await store.audit(scope),audit);
  assert.equal((await store.show(scope,memory.id,true)).status,status);
 }
 const inactive=await restoredInactive();
 assert.equal(await store.activate(scope,'not-a-uuid',admin),undefined);
 assert.equal(await store.activate({...scope,storyline:'other-story'},inactive.id,admin),undefined);
 assert.equal((await store.show(scope,inactive.id)).active,false);
});

test('activation blocks prospective conflicts with active canon regardless of visibility and allows resolved equivalents',async()=>{
 const inactive=await restoredInactive({metadata:{visibility:'private',factKey:'vincent-current-partner',assertion:'dee',knownAt:past}});
 const other=await store.add(scope,{...input,content:'Vincent is with Naomi.',metadata:{visibility:'public',factKey:'vincent-current-partner',assertion:'naomi',knownAt:past}},admin);
 const history=await store.history(scope,inactive.id);
 assert.equal(await store.activate(scope,inactive.id,admin),undefined);assert.deepEqual(await store.history(scope,inactive.id),history);
 assert.equal((await store.show(scope,inactive.id)).status,'inactive');
 await store.edit(scope,other.id,{...input,metadata:{assertion:'dee'}},undefined,admin);
 assert.equal((await store.activate(scope,inactive.id,admin)).status,'active');
});

test('activation serializes with metadata edits in both orders and stale edits cannot restore old privacy',async()=>{
 for(const editFirst of [true,false]) {
  const inactive=await restoredInactive(),stale=await store.show(scope,inactive.id);
  const edit=()=>store.edit(scope,inactive.id,{...input,metadata:{visibility:'private',knownByKinIds:[scope.kinId,'dee-villa'],sourceType:'production_override',authoritative:true}},undefined,admin);
  const activate=()=>store.activate(scope,inactive.id,admin);
  await Promise.all(editFirst?[edit(),activate()]:[activate(),edit()]);
  const current=await store.show(scope,inactive.id);
  assert.equal(current.status,'active');assert.equal(current.active,true);assert.equal(current.metadata.visibility,'private');
  assert.deepEqual(current.metadata.knownByKinIds,[scope.kinId,'dee-villa']);assert.equal(authority(current.metadata),4);
  await assert.rejects(store.edit(scope,inactive.id,{...input,metadata:stale.metadata},false,admin,stale.edit_version),MemoryEditConflict);
  assert.deepEqual((await store.show(scope,inactive.id)).metadata,current.metadata);
 }
});

test('concurrent activation runs once and a concurrent conflict-producing edit is observed before activation',async()=>{
 const inactive=await restoredInactive();
 const results=await Promise.all([store.activate(scope,inactive.id,admin),store.activate(scope,inactive.id,admin)]);
 assert.equal(results.filter(Boolean).length,1);assert.equal((await store.history(scope,inactive.id)).filter(r=>r.operation==='activate').length,1);
 const next=await restoredInactive({metadata:{factKey:'activation-race-key',assertion:'one'}});
 const other=await store.add(scope,{...input,metadata:{factKey:'activation-race-key',assertion:'one'}},admin);
 const ordered=await Promise.all([store.edit(scope,other.id,{...input,metadata:{assertion:'two'}},undefined,admin),store.activate(scope,next.id,admin)]);
 assert.equal(ordered[1],undefined);assert.equal((await store.show(scope,next.id)).status,'inactive');
});

test('activation rolls back when its audit trigger fails, retaining inactive state and previous revisions',async()=>{
 const inactive=await restoredInactive(),history=await store.history(scope,inactive.id),audit=await store.audit(scope);
 await pg.exec(`CREATE FUNCTION test_activation_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.operation='activate' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER test_activation_audit_failure BEFORE INSERT ON memory_audit FOR EACH ROW EXECUTE FUNCTION test_activation_audit_failure();`);
 try {await assert.rejects(store.activate(scope,inactive.id,admin));}
 finally {await pg.exec('DROP TRIGGER test_activation_audit_failure ON memory_audit; DROP FUNCTION test_activation_audit_failure();');}
 assert.equal((await store.show(scope,inactive.id)).status,'inactive');assert.deepEqual(await store.history(scope,inactive.id),history);assert.deepEqual(await store.audit(scope),audit);
});

test('activate slash command requires an ID, stays under Discord limits, is admin-only and responds privately',async()=>{
 const definition=memoryCommandDefinition().toJSON();assert.ok(definition.options.length<=25);
 const command=definition.options.find(c=>c.name==='activate');assert.ok(command);assert.equal(command.options[0].name,'id');assert.equal(command.options[0].required,true);
 const inactive=await restoredInactive(),responses=[];
 const runtime={config:{enabled:true,adminUserIds:new Set([admin]),contexts:[scope]},store};
 await handleMemoryCommand({user:{id:'999999999999999999'},reply:async p=>responses.push(p)},scope.kinId,runtime);
 assert.equal(responses[0].flags,64);assert.equal((await store.show(scope,inactive.id)).status,'inactive');
 responses.length=0;
 const invocation={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,deferred:false,replied:false,
  options:{getSubcommand:()=> 'activate',getString:()=>inactive.id},deferReply:async p=>{responses.push(p);invocation.deferred=true;},editReply:async p=>responses.push(p)};
 await handleMemoryCommand(invocation,scope.kinId,runtime);assert.equal(responses[0].flags,64);assert.match(responses.at(-1).content,/Memory activated/);
 assert.equal((await store.show(scope,inactive.id)).status,'active');
 responses.length=0;await handleMemoryCommand(invocation,scope.kinId,runtime);assert.match(responses.at(-1).content,/cannot be activated/);
});


const {resolveMemoryScope,withPublicBase}=require('../dist/memoryConfig');
const {memoryScopeEligible,memoryLayerPrivacyEligible}=require('../dist/memoryLayers');
const villaBaseId='888888888888888888';
const layerConfig={enabled:true,adminUserIds:new Set([admin]),contexts:[
 {kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,categoryId:villaBaseId,visibility:'public'},
 {kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,channelId:scope.channelId,visibility:'private'},
 {kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,channelId:'666666666666666666',visibility:'private'},
 {kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,channelId:'777777777777777777',visibility:'confessional'},
]};
const baseScope={...scope,channelId:'555555555555555555',contextType:'category',contextId:villaBaseId,visibility:'public'};
const privateA=resolveMemoryScope(layerConfig,scope.kinId,scope.discordBotId,scope.guildId,scope.channelId);
const privateB=resolveMemoryScope(layerConfig,scope.kinId,scope.discordBotId,scope.guildId,'666666666666666666');
const confessional=resolveMemoryScope(layerConfig,scope.kinId,scope.discordBotId,scope.guildId,'777777777777777777');
const ids=rows=>rows.map(row=>row.id);

test('one-way layered knowledge: public stays public; private and confessional inherit only public plus their own exact scope',async()=>{
 const shared=await store.add(baseScope,input,admin);
 const a=await store.add(privateA,{...input,content:'Private A promise.'},admin);
 const b=await store.add(privateB,{...input,content:'Private B promise.'},admin);
 const c=await store.add(confessional,{...input,content:'Confessional promise.'},admin);
 assert.deepEqual(ids(await store.retrieve(baseScope,['promise'])),[shared.id]);
 assert.deepEqual(new Set(ids(await store.retrieve(privateA,['promise']))),new Set([shared.id,a.id]));
 assert.deepEqual(new Set(ids(await store.retrieve(privateB,['promise']))),new Set([shared.id,b.id]));
 assert.deepEqual(new Set(ids(await store.retrieve(confessional,['promise']))),new Set([shared.id,c.id]));
 const all=(await db.query('SELECT id,context_id,context_type FROM memories')).rows;assert.equal(all.length,4);
 assert.equal(all.find(row=>row.id===a.id).context_id,privateA.channelId);assert.equal(all.find(row=>row.id===shared.id).context_id,villaBaseId);
 assert.equal(await store.show(privateA,shared.id),undefined);assert.equal(await store.delete(privateA,shared.id,admin),false);
});

test('base derivation is scoped by kin/storyline/guild, fails closed on zero/multiple bases, and supports public exact channels',async()=>{
 assert.equal(privateA.publicBaseStatus,'configured');assert.deepEqual(privateA.publicBase,{contextType:'category',contextId:villaBaseId});
 for(const foreign of [{storyline:'alternate-story'},{kinId:'another-kin'},{guildId:'999999999999999999'}]) {
  const mapping={...layerConfig.contexts[0],...foreign};
  const result=withPublicBase({...layerConfig,contexts:[mapping]},privateA);
  assert.equal(result.publicBaseStatus,'missing');assert.equal(result.publicBase,undefined);
 }
 const exactConfig={...layerConfig,contexts:[{kinId:scope.kinId,storyline:scope.storyline,guildId:scope.guildId,channelId:'555555555555555555',visibility:'public'},...layerConfig.contexts.slice(1)]};
 const exactPrivate=resolveMemoryScope(exactConfig,scope.kinId,scope.discordBotId,scope.guildId,scope.channelId);
 assert.deepEqual(exactPrivate.publicBase,{contextType:'channel',contextId:'555555555555555555'});
 const exactPublic=resolveMemoryScope(exactConfig,scope.kinId,scope.discordBotId,scope.guildId,'555555555555555555');
 const shared=await store.add(exactPublic,input,admin);assert.ok(ids(await store.retrieve(exactPrivate,['promise'])).includes(shared.id));
 const local=await store.add(privateA,{...input,content:'Local promise survives missing base.'},admin);
 for(const contexts of [layerConfig.contexts.slice(1),[...layerConfig.contexts,...exactConfig.contexts.slice(0,1)]]) {
  const result=resolveMemoryScope({...layerConfig,contexts},scope.kinId,scope.discordBotId,scope.guildId,scope.channelId);
  assert.equal(result.publicBaseStatus,contexts.length===3?'missing':'ambiguous');assert.equal(result.publicBase,undefined);
  assert.deepEqual(ids(await store.retrieve(result,['promise'])),[local.id]);
 }
 assert.equal(resolveMemoryScope(layerConfig,scope.kinId,scope.discordBotId,null,scope.channelId),undefined);
 assert.equal(resolveMemoryScope(layerConfig,scope.kinId,scope.discordBotId,scope.guildId,'unmapped-thread',{isThread:true,categoryId:villaBaseId,categoryPermissionsSynced:true}),undefined);
});

test('layer privacy independently rejects private/confessional/production base rows and wrong local knowledge/status/time',async()=>{
 const shared=await store.add(baseScope,input,admin);
 for(const visibility of ['private','confessional','production'])await store.add(baseScope,{...input,content:visibility+' secret promise',importance:5,metadata:{visibility,pinned:true}},admin);
 await store.add(privateA,{...input,content:'Expired promise',metadata:{expiresAt:past}},admin);
 await store.add(privateA,{...input,content:'Future promise',metadata:{knownAt:'2099-01-01T00:00:00Z'}},admin);
 await store.add(privateA,{...input,content:'Wrong visibility promise',metadata:{visibility:'confessional'}},admin);
 const inactive=await store.add(privateA,{...input,content:'Inactive promise'},admin);await store.edit(privateA,inactive.id,{...input,content:'Inactive promise'},false,admin);
 const pending=await store.createPending(privateA,{...candidate,content:'Pending promise'});await store.reject(privateA,pending.id,admin);
 assert.deepEqual(ids(await store.retrieve(privateA,['promise'])),[shared.id]);assert.deepEqual(ids(await production.snapshot(privateA)),[shared.id]);
});

test('merged ranking dedupes logical copies before taking five slots and retains pin/importance/authority order',async()=>{
 const shared=await store.add(baseScope,{...input,importance:5,metadata:{knownAt:past}},admin);
 const localCopy=await store.add(privateA,{...input,importance:5,metadata:{knownAt:past,pinned:true}},admin);
 const authoritative=await store.add(baseScope,{...input,content:'Authority promise.',importance:5,metadata:{sourceType:'production_override',authoritative:true,knownAt:past}},admin);
 for(let i=0;i<6;i++)await store.add(baseScope,{...input,content:'Unique promise '+i,importance:5,metadata:{knownAt:past}},admin);
 const selected=await store.retrieve(privateA,['promise']);assert.equal(selected.length,5);assert.equal(selected[0].id,localCopy.id);assert.equal(selected[1].id,authoritative.id);
 assert.ok(!ids(selected).includes(shared.id));assert.equal((await production.snapshot(privateA)).length,8);
 const eventInput={...input,content:'Vincent won the villa challenge.',metadata:{memoryType:'event',knownAt:past},provenance:{sourceChannelId:baseScope.channelId,occurredAt:past,sourceMessageIds:[],subjects:[]}};
 await store.add(baseScope,eventInput,admin);
 await store.add(privateA,{...eventInput,provenance:{...eventInput.provenance,sourceChannelId:privateA.channelId,occurredAt:'2026-02-01T00:00:00Z'}},admin);
 assert.equal((await production.snapshot(privateA)).filter(m=>m.content===eventInput.content).length,2);
});

test('cross-layer conflicts suppress both eligible assertions privately without letting private conflicts affect public',async()=>{
 const shared=await store.add(baseScope,{...input,content:'Vincent is with Dee.',metadata:{factKey:'current-partner',assertion:'dee',knownAt:past}},admin);
 const local=await store.add(privateA,{...input,content:'Vincent is with Naomi.',metadata:{factKey:'current-partner',assertion:'naomi',knownAt:past}},admin);
 assert.deepEqual(await store.retrieve(privateA,['vincent']),[]);assert.deepEqual(await production.snapshot(privateA),[]);
 assert.equal((await store.conflicts(privateA)).length,1);assert.deepEqual(await store.conflicts(baseScope),[]);assert.deepEqual(await store.conflicts(privateB),[]);
 assert.deepEqual(ids(await store.retrieve(baseScope,['vincent'])),[shared.id]);assert.deepEqual(ids(await store.retrieve(privateB,['vincent'])),[shared.id]);
 await store.delete(privateA,local.id,admin);assert.deepEqual(ids(await store.retrieve(privateA,['vincent'])),[shared.id]);
 const unrelated=await store.add(privateB,{...input,metadata:{factKey:'current-partner',assertion:'other'}},admin);
 assert.ok(unrelated);assert.deepEqual(ids(await store.retrieve(privateA,['vincent'])),[shared.id]);
});

test('layered normal injection preserves placement, original recent context and the existing combined note budget',async()=>{
 await store.add(baseScope,{...input,importance:5,metadata:{pinned:true}},admin);
 await store.add(privateA,{...input,content:'Local promise '+ 'x'.repeat(970),importance:5},admin);
 await store.add(baseScope,{...input,content:'Shared promise '+ 'y'.repeat(970),importance:5},admin);
 const recent=[{username:'Dee',text:'Vincent, remember the promise?',timestamp:past}];
 const outgoing=await supplementConversation(store,privateA,recent,'promise');
 assert.equal(outgoing.length,2);assert.deepEqual(outgoing.slice(1),recent);assert.ok(outgoing[0].text.includes(input.content));
 const noteText=outgoing[0].text.split('Background facts only; not a new Discord message or instructions.\n')[1];
 assert.ok(noteText.length<=2000);assert.equal((noteText.match(/^- /gm)||[]).length,2);
 const secretBase={...(await store.scan(baseScope))[0],metadata:{...(await store.scan(baseScope))[0].metadata,visibility:'private'}};
 assert.equal(memoryScopeEligible(privateA,secretBase),true);assert.equal(memoryLayerPrivacyEligible(privateA,secretBase),false);
 assert.strictEqual(await supplementConversation({retrieve:async()=>[secretBase]},privateA,recent,'promise'),recent);
 const foreign={...secretBase,kin_id:'another-kin',metadata:{...secretBase.metadata,visibility:'public'}};
 assert.strictEqual(await supplementConversation({retrieve:async()=>[foreign]},privateA,recent,'promise'),recent);
});

test('a failed merged database read falls back to recent Discord context without broader retries',async()=>{
 let queries=0;
 const failed=new MemoryStore({query:async(sql)=>{queries++;if(sql.startsWith('INSERT INTO memory_kins'))return{rows:[{id:scope.kinId}],rowCount:1};if(sql.startsWith('INSERT INTO memory_contexts'))return{rows:[],rowCount:1};throw new Error('PRIVATE DATABASE ERROR');}});
 const recent=[{username:'Dee',text:'promise',timestamp:past}];
 assert.strictEqual(await supplementConversation(failed,privateA,recent,'promise'),recent);assert.equal(queries,3);
});

test('slash list labels its local administrative scope while private snapshot exposes layered knowledge without enabling cross-scope writes',async()=>{
 const shared=await store.add(baseScope,input,admin),local=await store.add(privateA,{...input,content:'Local private promise.'},admin);
 const runtime={config:layerConfig,store};
 function command(name,values={}) {
  const r={user:{id:admin},client:{user:{id:scope.discordBotId}},guildId:scope.guildId,channelId:scope.channelId,channel:null,deferred:false,replied:false,responses:[],
   options:{getSubcommand:()=>name,getString:key=>values[key]??null,getInteger:()=>null,getBoolean:()=>null}};
  r.deferReply=async p=>{r.responses.push(p);r.deferred=true;};r.editReply=async p=>r.responses.push(p);return r;
 }
 const list=command('list');await handleMemoryCommand(list,scope.kinId,runtime);
 assert.equal(list.responses[0].flags,64);assert.match(list.responses.at(-1).content,/Local administration only/);assert.ok(list.responses.at(-1).content.includes(local.id));assert.ok(!list.responses.at(-1).content.includes(shared.id));
 const snapshot=command('snapshot');await handleMemoryCommand(snapshot,scope.kinId,runtime);
 const rows=JSON.parse(snapshot.responses.at(-1).files[0].attachment.toString());assert.deepEqual(new Set(ids(rows)),new Set([shared.id,local.id]));
 const readable=snapshot.responses.at(-1).files[1].attachment.toString();assert.ok(readable.includes('category:'+villaBaseId));assert.ok(readable.includes('channel:'+scope.channelId));
 const edit=command('edit',{id:shared.id,content:'Must not overwrite inherited knowledge'});await handleMemoryCommand(edit,scope.kinId,runtime);
 assert.match(edit.responses.at(-1).content,/not found/);assert.equal((await store.show(baseScope,shared.id)).content,input.content);
});


test('layered reads exclude every non-active workflow status and do not let ineligible assertions suppress eligible canon',async()=>{
 const shared=await store.add(baseScope,{...input,metadata:{factKey:'safe-promise',assertion:'yes',knownAt:past}},admin);
 for(const layer of [baseScope,privateA])for(const status of ['inactive','pending','rejected','archived','superseded']) {
  const row=await store.add(layer,{...input,content:layer.contextId+' '+status+' promise',metadata:{factKey:'safe-promise',assertion:'no',knownAt:past}},admin);
  await db.query('UPDATE memories SET status=$2,active=false WHERE id=$1',[row.id,status]);
 }
 for(const metadata of [{visibility:'private'},{visibility:'production'},{knownAt:'2099-01-01T00:00:00Z'},{expiresAt:past}]) {
  await store.add(baseScope,{...input,content:'Ineligible conflicting promise '+JSON.stringify(metadata),metadata:{factKey:'safe-promise',assertion:'no',knownAt:past,...metadata}},admin);
 }
 assert.deepEqual(ids(await store.retrieve(privateA,['promise'])),[shared.id]);assert.deepEqual(ids(await production.snapshot(privateA)),[shared.id]);
});

test('equivalent objective facts dedupe across layers despite different creation times; attributed reports remain separate',async()=>{
 const common={...input,metadata:{memoryType:'fact',statementType:'fact',knownAt:past},provenance:{sourceChannelId:baseScope.channelId,occurredAt:past,sourceMessageIds:[],subjects:[]}};
 await store.add(baseScope,common,admin);
 await store.add(privateA,{...common,provenance:{...common.provenance,sourceChannelId:privateA.channelId,occurredAt:'2026-02-01T00:00:00Z'}},admin);
 assert.equal((await store.retrieve(privateA,['promise'])).length,1);
 const report={...common,content:'Dee reported the promise.',metadata:{...common.metadata,statementType:'reported_speech',speakerId:'dee-villa'}};
 await store.add(baseScope,report,admin);
 await store.add(privateA,{...report,provenance:{...report.provenance,sourceChannelId:privateA.channelId,occurredAt:'2026-02-01T00:00:00Z'}},admin);
 assert.equal((await production.snapshot(privateA)).length,3);
});
