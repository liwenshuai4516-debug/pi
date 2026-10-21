import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RecordingService, ArtifactStore, UiDataScope, sha256, validateArtifact } from '../../packages/ui-testing/dist/index.js';
import { artifact, scope } from '../support/ui-artifacts.mjs';
import { setupUiFixture, repoRoot, textContent } from '../support/ui-fixture.mjs';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { until } from '../support/fixture.mjs';
const completion = { initial_state_rebuildable: true, replaceable_data: true, stable_locators: true, assertion_sources: true, cleanup_owned: true };

async function setup(t, options = {}) {
  const fixture = await setupUiFixture();
  t.after(()=>fixture.close());
  const store = new ArtifactStore(fixture.project), service = new RecordingService(fixture.project);
  const source = {path:'requirements.md',sha256:sha256('Saved Name persists after reload.')};
  await writeFile(join(fixture.project,source.path),'Saved Name persists after reload.');
  const frontend=await readFile(join(repoRoot,'tests/support/ui-fixture.mjs'),'utf8');
  const frontendRef={path:'fixture-source.mjs',sha256:sha256(frontend)};
  await writeFile(join(fixture.project,frontendRef.path),frontend);
  const s=scope();s.data.base_url=fixture.url;s.data.role='anonymous';s.data.sources[0].ref=source;s.data.budget.max_tool_calls=30;
  const scopeRef=await store.put(s);
  const inventory=artifact('inventory',{scope_ref:scopeRef,features:[{module_id:'names',feature_id:'save',name:'Save Name',
    entry:'/',role:'anonymous',actions:['Save Name and reload'],scenarios:[{scenario_id:'save-reload',title:'Name persists after reload'}],
    coverage:'discovered',discovery:'source',source_refs:[source,frontendRef],source_locations:[{ref:frontendRef,symbol:'setupUiFixture',line:frontend.split('\n').findIndex(line=>line.includes('export async function setupUiFixture'))+1}],
    priority:'P0',states:['initial','saved','reloaded'],gaps:['browser not observed yet']}],unexplored:['other roles and modules']});
  const inventoryRef=await store.put(inventory);
  const initial=await store.putFile('qa/ui/recordings/recording-1/initial-state.json',JSON.stringify({page:'/',role:'anonymous',state:'fresh context; empty saved list'}));
  const rules=await store.putFile('qa/ui/recordings/recording-1/data-rules.json',JSON.stringify({method:'isolated-context-owned-key',cleanup:'only owned key; close context',version:'1'}));
  const seed=await readFile(join(fixture.project,'tests/seed.spec.ts'));
  const config={id:'recording-1',scope_ref:scopeRef,inventory_ref:inventoryRef,initial_state_ref:initial,data_rules_ref:rules,
    seed_ref:{path:'tests/seed.spec.ts',sha256:sha256(seed)},output_file:'tests/recorded.spec.ts',backend:'mcp__playwright_test__',project:'chromium',
    max_steps:20,max_duration_ms:120000,max_no_progress:3,test_data:['public-owned-name'],...options};
  return {fixture,store,service,inventory,inventoryRef,config};
}
const okay = message => ({content:[{type:'text',text:message}],isError:false});
function recordingProtocol(fixture, respond) {
  fixture.state.respond=async body=>{const result=await respond(body);
    return result.tool==='ui_discover_record'?{...result,args:{request:result.args}}:result;};
}


test('UI-05: source-only discovery persists provenance without recording browser coverage',async t=>{
  const {store,inventory,config}=await setup(t);
  assert.equal((await store.load(config.inventory_ref)).data.features[0].discovery,'source');
  const invalid=structuredClone(inventory);invalid.data.features[0].coverage='explored';
  assert.throws(()=>validateArtifact(invalid),/仅源码/);
  const duplicated=structuredClone(inventory);duplicated.data.features.push(structuredClone(duplicated.data.features[0]));
  assert.throws(()=>validateArtifact(duplicated),/重复/);
  const noBrowser=await store.load(config.scope_ref);delete noBrowser.data.base_url;noBrowser.id='source-only';
  const scopeRef=await store.put(noBrowser);const another=structuredClone(inventory);another.id='source-only-inventory';another.data.scope_ref=scopeRef;
  const inventoryRef=await store.put(another);
  await assert.rejects(new RecordingService(store.projectRoot).start({...config,scope_ref:scopeRef,inventory_ref:inventoryRef}),/仅源码/);
});

test('UI-05: operations deduplicate, unknown effects block replay, and budgets retain partial evidence',async t=>{
  const {service,store,config}=await setup(t,{max_steps:2});
  const session=await service.start(config);let calls=0;
  const execute=async()=>{calls++;return okay('snapshot');};
  const first={operation_id:'setup',tool:'generator_setup_page',input:{seedFile:config.seed_ref.path,project:config.project,plan:'Save owned Name'},intent:'Initialize isolated page'};
  await service.call(session,first,execute);await service.call(session,first,execute);assert.equal(calls,1);
  await assert.rejects(service.call(session,{...first,input:{...first.input,plan:'changed'}},execute),/不能更换/);
  await service.call(session,{operation_id:'snapshot',tool:'browser_snapshot',input:{},intent:'Inspect initial state'},execute);
  await assert.rejects(service.call(session,{operation_id:'next',tool:'browser_snapshot',input:{},intent:'Inspect again'},execute),/step-budget/);
  // 清理不受动作预算阻止，且本身也保留真实调用记录。
  await service.call(session,{operation_id:'close',tool:'browser_close',input:{},intent:'Cleanup owned context'},execute);
  const partial=await service.finish(session,{inventory_ref:config.inventory_ref,initial_state:'fresh context',completion:{...completion,assertion_sources:false},gaps:['blocked by budget'],goal_reached:false});
  assert.equal((await store.load(partial)).data.status,'partial');
  await assert.rejects(service.call(session,{operation_id:'after',tool:'browser_snapshot',input:{},intent:'After finalization'},execute),/登记结束/);
  const unknown=await setup(t,{id:'recording-unknown',max_steps:4});
  const unknownSession=await unknown.service.start(unknown.config);
  await unknown.store.putFile('qa/ui/recordings/recording-unknown/events/uncertain/request.json',JSON.stringify({...first,operation_id:'uncertain',created_at:new Date().toISOString()}));
  await assert.rejects(unknown.service.call(unknownSession,{...first,operation_id:'uncertain'},execute),/不明/);
  assert.equal((await unknown.service.status(unknownSession)).stopped,'unknown-operation-needs-reconciliation');
});

test('UI-05: repeated unchanged snapshots stop; private inputs and foreign navigation are refused',async t=>{
  const {service,config}=await setup(t,{max_no_progress:2});const session=await service.start(config);
  await service.call(session,{operation_id:'setup',tool:'generator_setup_page',input:{seedFile:config.seed_ref.path,project:config.project},intent:'Initialize'},async()=>okay('Initial'));
  await assert.rejects(service.call(session,{operation_id:'secret',tool:'browser_type',input:{text:'unapproved-secret'},intent:'Type'},async()=>okay('bad')),/公开合成/);
  await assert.rejects(service.call(session,{operation_id:'foreign',tool:'browser_navigate',input:{url:'https://example.com'},intent:'Navigate'},async()=>okay('bad')),/范围外/);
  for(let i=0;i<2;i++) await service.call(session,{operation_id:'s'+i,tool:'browser_snapshot',input:{},intent:'Observe'},async()=>okay(`textbox Name [ref=e${i}]`));
  assert.equal((await service.status(session)).stopped,'no-progress');
  await assert.rejects(service.call(session,{operation_id:'s3',tool:'browser_snapshot',input:{},intent:'Again'},async()=>okay('bad')),/no-progress/);
});

test('UI-05: real Pi Skill and nested MCP record UI actions, clean data, persist portable draft and observations', {timeout:90000},async t=>{
  const {fixture,service,store,config,inventory}=await setup(t);
  const fixtureUrl=pathToFileURL(join(repoRoot,'packages/ui-testing/dist/fixtures.js')).href;
  await writeFile(join(fixture.project,'playwright.config.mjs'),`export default {testDir:'./tests',timeout:15000,workers:1,use:{headless:true,baseURL:${JSON.stringify(fixture.url)}},projects:[{name:'chromium',use:{browserName:'chromium'}}]};`);
  const env={schema_version:'1.0',environment_id:'test',deployment_version:'fixture-v1',base_url:fixture.url,role:'anonymous',
    identity:{selector:'h1',text:'Names'},initial_state:{selector:'button',text:'Save'},auth:{kind:'none'},isolation:'context',timeout_ms:5000};
  const keyPath=join(fixture.project,'seed-key.json');
  await writeFile(join(fixture.project,'tests/seed.spec.ts'),`import {test} from ${JSON.stringify(fixtureUrl)};
import {writeFile} from 'node:fs/promises';
test.use(${JSON.stringify({uiEnvironment:env,uiOwner:{task_id:'recording-task',kind:'recording',id:'recording-1'},uiProjectRoot:fixture.project})});
test('seed',async({uiData,page})=>{const row=await uiData.prepare({creation_method:'ui-seed-owned-key',fixture_version:'1',ttl_ms:60000,
 cleanup_method:'owned-key',create:async key=>key,cleanup:async key=>{await page.evaluate(key=>{const rows=JSON.parse(localStorage.getItem('names')||'[]');localStorage.setItem('names',JSON.stringify(rows.filter(value=>value!==key)));},key);}});
 await writeFile(${JSON.stringify(keyPath)},row.business_key);});`);
  config.seed_ref.sha256=sha256(await readFile(join(fixture.project,'tests/seed.spec.ts')));config.test_data=[];
  const host=new AgentHost(()=>{},()=>{},fixture.agentDir);t.after(()=>host.dispose());
  await new PluginManager(fixture.agentDir,fixture.project).install(join(repoRoot,'packages/ui-testing'),'package');
  const view=await host.create(fixture.project,true);
  await until(async()=>(await host.listMcp(view.id)).servers.some(s=>s.state==='connected'));
  assert.ok(view.skills.some(s=>s.name==='ui-discover-record'));
  let round=0,session,key,observation,finalInventoryRef,recordingRef;
  const generated=`import {test,expect} from 'playwright/test';
test('Name persists',async({page})=>{const key='qa-'+crypto.randomUUID();await page.goto('/');
 await page.getByRole('textbox',{name:'Name'}).fill(key);await page.getByRole('button',{name:'Save'}).click();
 await expect(page.getByRole('listitem')).toHaveText([key]);await page.reload();await expect(page.getByRole('listitem')).toHaveText([key]);});`;
  recordingProtocol(fixture,async body=>{
    const previous=body.messages.filter(m=>m.role==='tool').at(-1);
    const response=previous?JSON.parse(textContent(previous.content)):undefined;
    if(response?.status==='blocked' || response?.output?.isError)assert.fail(JSON.stringify(response));
    const action=(tool,input,intent)=>({tool:'ui_discover_record',args:{operation:'action',session_ref:session,operation_id:'step-'+round,tool,input,intent}});
    switch(round++){
      case 0:return {tool:'ui_discover_record',args:{operation:'start',configuration:config}};
      case 1:session=response.artifact_refs[0];return action('generator_setup_page',{seedFile:config.seed_ref.path,project:'chromium',plan:'Save owned Name and verify persistence'},'Initialize declared seed');
      case 2:{key=await readFile(keyPath,'utf8');const snapshot=textContent(response.output.content);const actual=snapshot.match(/textbox "Name".*?\[ref=([^\]]+)\]/)?.[1];assert.ok(actual,snapshot);
        return action('browser_type',{element:'Name textbox',target:actual,text:key,intent:'Enter owned key'},'Enter owned Name');}
      case 3:return action('browser_snapshot',{},'Refresh refs after typing');
      case 4:{const snapshot=textContent(response.output.content),target=snapshot.match(/button "Save".*?\[ref=([^\]]+)\]/)?.[1];assert.ok(target,snapshot);
        return action('browser_click',{element:'Save button',target,intent:'Save owned Name'},'Save owned Name');}
      case 5:return action('browser_snapshot',{},'Observe saved list');
      case 6:{assert.match(textContent(response.output.content),new RegExp(key));observation=response.artifact_refs[0];
        const next=structuredClone(inventory);next.id='inventory-observed';const feature=next.data.features[0];feature.source_refs.push(observation);feature.discovery='both';feature.coverage='explored';feature.gaps=[];
        return {tool:'ui_discover_record',args:{operation:'inventory',inventory:next}};}
      case 7:finalInventoryRef=response.artifact_refs[0];return action('generator_read_log',{},'Preserve native action journal');
      case 8:assert.match(textContent(response.output.content),/getByRole/);return action('generator_write_test',{fileName:config.output_file,code:generated},'Save parameterized draft from real actions');
      case 9:return action('browser_close',{intent:'Close seed and clean owned data'},'Close seed and clean owned data');
      case 10:return {tool:'ui_discover_record',args:{operation:'finish',session_ref:session,inventory_ref:finalInventoryRef,initial_state:'fresh anonymous context with empty localStorage',completion,gaps:[],goal_reached:true}};
      default:recordingRef=response.artifact_refs[0];return {text:'Recorded draft saved. Independent design review is still required.'};
    }
  });
  await host.send(view.id,'/skill:ui-discover-record Record the isolated Save Name feature; source R1 requires reload persistence.',[],[]);
  if(fixture.state.responseError)throw fixture.state.responseError;
  assert.equal(round,12);assert.match(fixture.state.instructions.at(-1),/ui_discover_record/);
  const saved=await new ArtifactStore(fixture.project).load(recordingRef);
  assert.equal(saved.data.status,'complete');assert.equal(saved.data.steps.length,8);
  assert.ok(saved.data.data_refs.some(ref=>ref.path.endsWith('/cleanup-result.json')),'recording teardown must persist lifecycle result');
  const cleanupRefs=saved.data.data_refs.filter(ref=>ref.path.endsWith('/cleanup-result.json'));
  for(const ref of cleanupRefs){const data=JSON.parse(await readFile(join(fixture.project,ref.path),'utf8'));assert.equal(data.cleanup_state,'cleaned');}
  assert.equal((await service.status(session)).events.length,8);
  await assert.rejects(service.call(session,{operation_id:'late',tool:'browser_snapshot',input:{},intent:'Late'},async()=>okay('no')),/登记结束/);
  const replay=await promisify(execFile)(process.execPath,[join(repoRoot,'node_modules/playwright/cli.js'),'test','recorded.spec.ts','--reporter=json'],{cwd:fixture.project,timeout:30000});
  assert.equal(JSON.parse(replay.stdout).stats.expected,1,'draft replay is design validation, not formal execution');
});

test('UI-05: actual Pi source read yields a persisted unrecorded draft without browser actions', {timeout:30000},async t=>{
  const {fixture,store,inventory,config}=await setup(t);
  await mkdir(join(fixture.project,'src'));
  const code="export const routes = [{ path: '/names', title: 'Names', fields: [{label:'Name',required:true}], actions:['Save'] }];";
  await writeFile(join(fixture.project,'src/routes.ts'),code);
  await writeFile(join(fixture.agentDir,'SYSTEM.md'),'Read relevant source for a UI design-only draft. Do not operate a browser or claim runtime coverage.');
  const scopeOnly=await store.load(config.scope_ref);scopeOnly.id='source-scope';delete scopeOnly.data.base_url;
  const scopeRef=await store.put(scopeOnly);
  const sourceRef={path:'src/routes.ts',sha256:sha256(code)};
  const candidate=structuredClone(inventory);candidate.id='source-draft';candidate.data.scope_ref=scopeRef;
  const feature=candidate.data.features[0];feature.source_refs.push(sourceRef);feature.entry='/names';
  feature.source_locations=[{ref:sourceRef,symbol:'routes',line:1}];feature.gaps=['selectors and route reachability unverified'];
  const host=new AgentHost(()=>{},()=>{},fixture.agentDir);t.after(()=>host.dispose());
  await new PluginManager(fixture.agentDir,fixture.project).install(join(repoRoot,'packages/ui-testing'),'package');
  const view=await host.create(fixture.project,true),calls=[];
  host.entries.get(view.id).agent.subscribe(event=>{if(event.type==='tool_execution_start')calls.push(event.toolName);});
  let round=0,saved;
  recordingProtocol(fixture,body=>{
    const previous=body.messages.filter(m=>m.role==='tool').at(-1);
    if(round++===0)return {tool:'read',args:{path:'src/routes.ts'}};
    if(round===2){
      assert.match(textContent(previous.content),/path: '\/names'/);
      return {tool:'ui_discover_record',args:{operation:'inventory',inventory:candidate,drafts:[{name:'save.spec.ts',content:
        "// Source-only candidate: selectors/runtime state remain unverified; R1 declares persistence.\nimport {test,expect} from 'playwright/test';\ntest('save candidate',async({page})=>{const key='qa-'+crypto.randomUUID();await page.goto('/names');await page.getByLabel('Name').fill(key);await page.getByRole('button',{name:'Save'}).click();await page.reload();await expect(page.getByRole('listitem')).toHaveText([key]);});\n"}]}};
    }
    saved=JSON.parse(textContent(previous.content));return {text:'Source-only draft saved, not browser-recorded or design-approved.'};
  });
  await host.send(view.id,'/skill:ui-discover-record Analyze src/routes.ts only and save a design-only draft.',[],[]);
  if(fixture.state.responseError)throw fixture.state.responseError;
  assert.equal(saved.status,'completed');assert.equal(saved.output.browser_recorded,false);
  const result=await new ArtifactStore(fixture.project).load(saved.artifact_refs[0]);
  assert.equal(result.data.features[0].coverage,'discovered');assert.equal(result.data.features[0].discovery,'source');
  assert.equal(result.data.draft_refs.length,1);
  assert.ok(result.data.features[0].source_locations.some(s=>s.ref.path==='src/routes.ts'));
  assert.equal(calls.some(name=>name.startsWith('mcp__')),false);
  await host.dispose();
});

test('UI-05: elapsed deadline cancels the delegated operation and retains unknown outcome',async t=>{
  const {service,config,store}=await setup(t,{max_duration_ms:100});
  const ref=await service.start(config);
  const outcome=await service.call(ref,{operation_id:'timeout',tool:'generator_setup_page',input:{seedFile:config.seed_ref.path,project:config.project},intent:'Initialize'},
    async(_tool,_input,signal)=>new Promise(resolve=>{
      const timer=setTimeout(()=>resolve(okay('too late')),1000);
      signal.addEventListener('abort',()=>{clearTimeout(timer);resolve(okay('backend returned during cancellation'));},{once:true});
    }));
  assert.equal(outcome.isError,true);assert.equal(outcome.unknown,true);
  const state=await service.status(ref);assert.equal(state.stopped,'tool-error-or-cancelled');
  const observed=JSON.parse(await readFile(join(store.projectRoot,outcome.observation_ref.path),'utf8'));
  assert.equal(observed.unknown,true);
});

test('UI-05: fixed recorded data, temporary refs and personal paths cannot become complete recordings',async t=>{
  const {service,config,fixture,store}=await setup(t);
  const ref=await service.start(config),code="// /Users/recorder/work\nconst value='public-owned-name';page.locator('aria-ref=e1');";
  const execute=async(tool,input)=>{
    if(tool.endsWith('__generator_write_test'))await writeFile(join(fixture.project,config.output_file),input.code);
    return okay('native operation result');
  };
  const actions=[['generator_setup_page',{seedFile:config.seed_ref.path,project:config.project}],['generator_read_log',{}],
    ['generator_write_test',{fileName:config.output_file,code}],['browser_close',{}]];
  for(const [i,[tool,input]] of actions.entries())await service.call(ref,{operation_id:'a'+i,tool,input,intent:tool},execute);
  const env=JSON.parse(await readFile(join(repoRoot,'packages/ui-testing/examples/environment.json'),'utf8'));
  const owned=new UiDataScope(store,{task_id:'task-1',kind:'recording',id:config.id},env);
  await owned.prepare({creation_method:'fixture',fixture_version:'1',ttl_ms:60000,cleanup_method:'owned-key',
    create:async key=>key,cleanup:async()=>{throw new Error('known cleanup failure');}});
  await owned.cleanup();
  const result=await service.finish(ref,{inventory_ref:config.inventory_ref,initial_state:'new context',goal_reached:true,completion,gaps:[]});
  const saved=await store.load(result);
  assert.equal(saved.data.status,'partial');
  assert.ok(saved.data.gaps.includes('script-has-temporary-ref-or-personal-path'));
  assert.ok(saved.data.gaps.includes('script-has-fixed-recorded-data'));
  assert.ok(saved.data.gaps.includes('recording-data-cleanup-incomplete'));
});

test('UI-05: a fresh Agent can inspect persisted recording but cannot resume browser clicks', {timeout:30000},async t=>{
  const {fixture,service,config}=await setup(t);
  const session=await service.start(config);
  const host=new AgentHost(()=>{},()=>{},fixture.agentDir);t.after(()=>host.dispose());
  await new PluginManager(fixture.agentDir,fixture.project).install(join(repoRoot,'packages/ui-testing'),'package');
  const view=await host.create(fixture.project,true);
  let round=0;const outputs=[];
  recordingProtocol(fixture,body=>{
    if(round++===0)return {tool:'ui_discover_record',args:{operation:'status',session_ref:session}};
    const previous=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1)?.content));outputs.push(previous);
    if(round===2)return {tool:'ui_discover_record',args:{operation:'action',session_ref:session,operation_id:'resume',tool:'browser_click',input:{target:'e1',intent:'Resume'},intent:'Resume old click'}};
    return {text:'Persisted evidence available; live browser state is not a reliable checkpoint.'};
  });
  await host.send(view.id,'Inspect old recording and check whether live clicks can resume.',[],[]);
  if(fixture.state.responseError)throw fixture.state.responseError;
  assert.equal(outputs[0].status,'completed');assert.equal(outputs[1].status,'blocked');
  assert.match(outputs[1].errors[0].message,/重启后只读/);
  assert.equal((await service.status(session)).events.length,0);
  await host.dispose();
});
