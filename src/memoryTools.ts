import dotenv from 'dotenv';
import { readFile, writeFile } from 'node:fs/promises';
import { createDatabase } from './database';
import { loadMemoryConfig, MemoryScope, resolvedContext } from './memoryConfig';
import { MemoryStore } from './memoryStore';
import { MemoryBundle, MemoryProduction, readableCanon, exportSafetyWarning } from './memoryProduction';
import { BotConfig } from './types';

// Local production administration only. JSON results are written to explicit files, never logs.
export async function runMemoryTool(requestPath: string, outputPath: string): Promise<void> {
  dotenv.config();
  const request = JSON.parse(await readFile(requestPath,'utf8')) as {
    actorId: string; scope: MemoryScope; operation: string; bundle?: MemoryBundle; token?: string;
    filter?: { page?: number; status?: string; visibility?: string; from?: string; until?: string };
    days?: number; alias?: string; subjectId?: string; oldBotId?: string; newBotId?: string; reason?: string; id?: string;
  };
  const bots = Object.keys(process.env).filter(key=>/^KIN_ID_\d+$/.test(key)).map(key=>({ kinId:process.env[key] } as BotConfig));
  const config = loadMemoryConfig(bots);
  if (!config.enabled || !config.adminUserIds.has(request.actorId) || !request.scope) throw new Error('Unauthorized production request');
  const context = resolvedContext(request.scope);
  const mapping = config.contexts.find(c=>c.kinId===request.scope.kinId && c.storyline===request.scope.storyline && c.guildId===request.scope.guildId &&
    (context.type==='channel' ? c.channelId===context.id : c.categoryId===context.id));
  if (!mapping) throw new Error('Unconfigured production scope');
  const scope = { ...request.scope,visibility:mapping.visibility ?? 'public' };
  const database = createDatabase();
  try {
    const store = new MemoryStore(database), production = new MemoryProduction(store);
    let result: unknown;
    switch (request.operation) {
      case 'export': result=await production.export(scope,request.filter); break;
      case 'preview': if (!request.bundle) throw new Error('Missing bundle'); result=await production.preview(scope,request.bundle); break;
      case 'stage': if (!request.bundle || !request.token) throw new Error('Missing preview'); result=await production.stage(scope,request.bundle,request.token,request.actorId); break;
      case 'snapshot': { const memories=await production.snapshot(scope); result={warning:exportSafetyWarning,memories,readable:readableCanon(scope,memories)}; break; }
      case 'audit': result=await store.audit(scope); break;
      case 'retention': result={archived:await store.archivePending(scope,request.days ?? 30,request.actorId)}; break;
      case 'alias': await store.setAlias(scope,request.alias ?? '',request.subjectId ?? '',request.actorId); result={updated:true}; break;
      case 'source-review': await store.flagSource(scope,request.id ?? '',request.reason ?? '',request.actorId); result={flagged:true}; break;
      case 'rebind': await store.rebindKin(scope,request.oldBotId ?? '',request.newBotId ?? '',request.actorId,request.reason ?? ''); result={updated:true}; break;
      default: throw new Error('Unknown production operation');
    }
    await writeFile(outputPath,JSON.stringify(result,null,2),{encoding:'utf8',flag:'wx'});
  } finally { await database.end(); }
}
if (require.main===module) {
  const [, , requestPath, outputPath] = process.argv;
  if (!requestPath || !outputPath || requestPath===outputPath) { console.error('Usage: node dist/memoryTools.js REQUEST.json OUTPUT.json'); process.exitCode=1; }
  else void runMemoryTool(requestPath,outputPath).catch(()=>{console.error('Memory production operation failed; inspect configuration/database and preview again. No private details logged.');process.exitCode=1;});
}
