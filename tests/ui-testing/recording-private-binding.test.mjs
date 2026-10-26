import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactStore, RecordingService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { artifact, scope } from '../support/ui-artifacts.mjs';

async function fixture(t, toolBudget = 20) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'recording-private-binding-')));
  t.after(() => rm(root, {recursive:true,force:true}));
  const workspace=join(root,'work'), authority=join(root,'host');
  await mkdir(workspace,{mode:0o700}); await mkdir(authority,{mode:0o700});
  const store=new ArtifactStore(workspace),service=new RecordingService(workspace);
  const put=async(path,bytes)=>{await mkdir(dirname(join(workspace,path)),{recursive:true});await writeFile(join(workspace,path),bytes);return {path,sha256:sha256(bytes)};};
  const source=await put('requirements.md','Synthetic fixture heading is visible.');
  const s=scope();s.data.budget.max_tool_calls=toolBudget;s.data.base_url='http://127.0.0.1:18983/';s.data.sources[0].ref=source;
  const scopeRef=await store.put(s), inventoryRef=await store.put(artifact('inventory',{scope_ref:scopeRef,features:[],unexplored:['synthetic only']}));
  const seed=await put('tests/seed.spec.ts','export {};');
  const initial=await put('initial.json','{"state":"new synthetic context"}');
  const rules=await put('rules.json','{"cleanup":"close synthetic context"}');
  const reference='PI_UI_DATA_SPACE_'+randomUUID().replaceAll('-','').toUpperCase();
  t.after(()=>{delete process.env[reference];});
  const statePath=join(authority,'state.json'), secret='synthetic-only-'+randomUUID();
  const state={cookies:[],origins:[{origin:'http://127.0.0.1:18983',localStorage:[{name:'token',value:secret}]}],pi_ui_private:{version:1,reference,workspace,origin:'http://127.0.0.1:18983',baseUrl:s.data.base_url,expiresAt:new Date(Date.now()+60000).toISOString()}};
  await writeFile(statePath,JSON.stringify(state),{mode:0o600});process.env[reference]=statePath;
  const environment={schema_version:'1.0',environment_id:s.data.environment_id,deployment_version:'synthetic-v1',base_url:s.data.base_url,role:s.data.role,identity:{selector:'h1',text:'Fixture'},initial_state:{selector:'h1',text:'Fixture'},isolation:'context',timeout_ms:1000,auth:{kind:'storage-state-env',reference}};
  const environmentRef=await put('environment.json',JSON.stringify(environment));
  const config={id:'private-binding',scope_ref:scopeRef,inventory_ref:inventoryRef,initial_state_ref:initial,data_rules_ref:rules,seed_ref:seed,output_file:'tests/generated.spec.ts',backend:'mcp__fixture__',project:'chromium',max_steps:10,max_duration_ms:60000,max_no_progress:3,test_data:[],private_recording:{environment_ref:environmentRef,input_refs:[seed]}};
  const call={operation_id:'setup',tool:'generator_setup_page',input:{seedFile:seed.path,project:'chromium'},intent:'Observe synthetic fixture'};
  return {workspace,store,service,put,config,call,state,statePath,environment,secret};
}
const okay=async()=>({content:[{type:'text',text:'synthetic'}]});

test('private recording freezes public references and exposes a verified host context without secret/path',async t=>{
 const f=await fixture(t), ref=await f.service.start(f.config), context=await f.service.privateContext(ref);
 assert.deepEqual(context,{environment:f.environment,environmentRef:f.config.private_recording.environment_ref,inputRefs:f.config.private_recording.input_refs});
 const bytes=await readFile(join(f.workspace,ref.path),'utf8');
 assert.equal(bytes.includes(f.secret),false);assert.equal(bytes.includes(f.statePath),false);
 assert.deepEqual(JSON.parse(bytes).private_recording,f.config.private_recording);
 await f.service.call(ref,f.call,okay);
});

test('old anonymous recording remains compatible and has no private host context',async t=>{
 const f=await fixture(t);delete f.config.private_recording;
 const ref=await f.service.start(f.config);assert.equal(await f.service.privateContext(ref),undefined);
 await f.service.call(ref,f.call,okay);
});

test('private environment must match scope identity, role and URL, and use managed isolated state',async t=>{
 const f=await fixture(t);
 for(const change of [{environment_id:'other'},{role:'other'},{base_url:'http://127.0.0.1:18984/'},{isolation:'shared'},{auth:{kind:'none'}}]) {
  const environment_ref=await f.put('env-'+randomUUID()+'.json',JSON.stringify({...f.environment,...change}));
  await assert.rejects(f.service.start({...f.config,private_recording:{...f.config.private_recording,environment_ref}}),/私密录制/);
 }
});

test('private input set must bind the seed, forbid duplicates, and reject changed hashes',async t=>{
 const f=await fixture(t),other=await f.put('other.ts','export {};');
 for(const refs of [[other],[f.config.seed_ref,f.config.seed_ref]])
  await assert.rejects(f.service.start({...f.config,private_recording:{...f.config.private_recording,input_refs:refs}}),/私密录制/);
 await assert.rejects(f.service.start({...f.config,private_recording:{...f.config.private_recording,input_refs:[{...f.config.seed_ref,sha256:'a'.repeat(64)}]}}));
});

test('expired managed state prevents new dispatch but status, owned close and partial finish remain possible',async t=>{
 const f=await fixture(t),ref=await f.service.start(f.config);let calls=0;
 const execute=async()=>{calls++;return okay();};
 await f.service.call(ref,f.call,execute);
 await writeFile(f.statePath,JSON.stringify({...f.state,pi_ui_private:{...f.state.pi_ui_private,expiresAt:'2000-01-01T00:00:00.000Z'}}));
 await assert.rejects(f.service.privateContext(ref));
 await assert.rejects(f.service.call(ref,{...f.call,operation_id:'snapshot',tool:'browser_snapshot',input:{}},execute));
 assert.equal(calls,1);assert.equal((await f.service.status(ref)).events.length,1);
 await f.service.call(ref,{...f.call,operation_id:'close',tool:'browser_close',input:{}},execute);assert.equal(calls,2);
 const completion={initial_state_rebuildable:false,replaceable_data:false,stable_locators:false,assertion_sources:false,cleanup_owned:true};
 const finished=await f.service.finish(ref,{inventory_ref:f.config.inventory_ref,initial_state:'expired',completion,gaps:['private authentication expired'],goal_reached:false});
 assert.equal((await f.store.load(finished)).data.status,'partial');
});


test('explicit capture protocol freezes the host contract and reserves all helpers plus one cleanup',async t=>{
 const f=await fixture(t,17);
 const config={...f.config,max_steps:8,backend:'mcp__ui_playwright_test__',private_recording:{...f.config.private_recording,capture:'chromium-single-page-v1'}};
 const ref=await f.service.start(config), context=await f.service.privateContext(ref);
 assert.deepEqual(context.capture,{protocol:'chromium-single-page-v1',seedRef:config.seed_ref,project:config.project,
   outputFile:config.output_file,maxSteps:8,maxToolCalls:17,reservedToolCalls:17});
 const saved=JSON.parse(await readFile(join(f.workspace,ref.path),'utf8'));
 assert.equal(saved.private_recording.capture,'chromium-single-page-v1');
 assert.equal(JSON.stringify(context).includes(f.secret),false);
 assert.equal(JSON.stringify(context).includes(f.statePath),false);
});

test('capture rejects insufficient scope budget, more than eight captures and unmanaged backend before session creation',async t=>{
 for(const [budget,steps,backend] of [[8,4,'mcp__ui_playwright_test__'],[100,9,'mcp__ui_playwright_test__'],[20,4,'mcp__fixture__']]){
  const f=await fixture(t,budget);
  await assert.rejects(f.service.start({...f.config,max_steps:steps,backend,
    private_recording:{...f.config.private_recording,capture:'chromium-single-page-v1'}}),/采集协议/);
  await assert.rejects(readFile(join(f.workspace,'qa/ui/recordings/private-binding/session.json')), {code:'ENOENT'});
 }
});

test('capture cleanup can run once after step exhaustion; replay is cached and later dispatches are blocked',async t=>{
 const f=await fixture(t,3), config={...f.config,max_steps:1,backend:'mcp__ui_playwright_test__',
   private_recording:{...f.config.private_recording,capture:'chromium-single-page-v1'}};
 const ref=await f.service.start(config);let dispatched=0;
 const execute=async()=>{dispatched++;return okay();};
 await f.service.call(ref,f.call,execute);
 await assert.rejects(f.service.call(ref,{...f.call,operation_id:'over-budget',tool:'browser_snapshot',input:{}},execute),/step-budget/);
 const close={...f.call,operation_id:'close',tool:'browser_close',input:{}};
 await f.service.call(ref,close,execute);
 await f.service.call(ref,close,execute);
 await assert.rejects(f.service.call(ref,{...close,operation_id:'close-again'},execute),/清理已请求/);
 assert.equal(dispatched,2);
 assert.equal((await f.service.status(ref)).stopped,'step-budget');
 const finished=await f.service.finish(ref,{inventory_ref:config.inventory_ref,initial_state:'budget exhausted',
   completion:{initial_state_rebuildable:false,replaceable_data:false,stable_locators:false,assertion_sources:false,cleanup_owned:true},
   gaps:['exploration-budget-exhausted'],goal_reached:false});
 const artifact=await f.store.load(finished);
 assert.equal(artifact.data.status,'partial');
 assert.ok(artifact.data.gaps.includes('exploration-budget-exhausted'));
 assert.ok(artifact.data.gaps.includes('step-budget'));
 assert.equal(artifact.data.gaps.includes('browser-context-closed'),false);
});

test('unknown capture protocols are rejected without altering legacy private sessions',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.service.start({...f.config,private_recording:{...f.config.private_recording,capture:'future-unverified'}}));
 const ref=await f.service.start(f.config);
 assert.equal((await f.service.privateContext(ref)).capture,undefined);
});


test('capture setup failure retains the error and still permits one owned browser cleanup',async t=>{
 const f=await fixture(t,3), config={...f.config,max_steps:1,backend:'mcp__ui_playwright_test__',
   private_recording:{...f.config.private_recording,capture:'chromium-single-page-v1'}};
 const ref=await f.service.start(config);let dispatched=0;
 const execute=async(tool)=>{dispatched++;return tool.endsWith('generator_setup_page')
   ? {isError:true,content:[{type:'text',text:'Synthetic initialization failed after launch'}]} : okay();};
 await f.service.call(ref,f.call,execute);
 await assert.rejects(f.service.call(ref,{...f.call,operation_id:'unsafe-next',tool:'browser_snapshot',input:{}},execute));
 await f.service.call(ref,{...f.call,operation_id:'close',tool:'browser_close',input:{}},execute);
 const finished=await f.service.finish(ref,{inventory_ref:config.inventory_ref,initial_state:'setup failed',
   completion:{initial_state_rebuildable:false,replaceable_data:false,stable_locators:false,assertion_sources:false,cleanup_owned:true},
   gaps:['initialization-not-ready'],goal_reached:false});
 const artifact=await f.store.load(finished);
 assert.equal(dispatched,2);assert.equal(artifact.data.status,'partial');
 assert.ok(artifact.data.gaps.includes('tool-error-or-cancelled'));
 assert.ok(artifact.data.gaps.includes('initialization-not-ready'));
 assert.equal(artifact.data.gaps.includes('browser-cleanup-not-confirmed'),false);
});
