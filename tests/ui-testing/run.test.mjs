import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UiRunService, RuntimeAdmissionService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { prepareDiagnostic, decision } from '../support/ui-design-fixture.mjs';
import { artifact } from '../support/ui-artifacts.mjs';
import { until } from '../support/fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';
import { repoRoot, textContent } from '../support/ui-fixture.mjs';

async function ready(t,options){
  const d=await prepareDiagnostic(t,options),{f,assetRef,reviewed,specRef}=d;
  const diagnostic=await new RuntimeAdmissionService(f.root,f.authority).diagnose(assetRef,reviewed.review_ref,specRef,'ready-for-formal-run');
  assert.equal(diagnostic.runtime_ready,true,JSON.stringify(diagnostic.rounds));
  const original=await f.store.load(f.taskRef);
  await f.store.put(artifact('task',{...original.data,intent:'execute',stage:'execute',completed_stages:['design-review'],
    input_sha256:sha256('formal-run'),asset_refs:[assetRef],run_ids:[]},'formal-task'));
  const request={task_id:'formal-task',request_id:'first',asset_ref:assetRef,review_ref:reviewed.review_ref,
    environment_ref:d.spec.environment_ref,config_ref:d.config,timeout_ms:15000};
  return {...d,request,service:new UiRunService(f.root,f.authority)};
}
async function summary(f,result){
  const ref=result.run.data.output_refs.find(r=>r.path.endsWith('/execution-summary.json'));
  return JSON.parse(await readFile(join(f.root,ref.path),'utf8'));
}

test('UI-07: formal execution freezes one new run, captures native attempts and deduplicates after restart',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t);
  const result=await service.start(request);
  assert.equal(result.replayed,false);assert.equal(result.run.data.state,'finished');
  assert.equal(result.run.data.plan.length,1);assert.equal(result.run.data.exit_code,0);
  const execution=await summary(f,result);assert.equal(execution.formal_run,true);assert.equal(execution.status,'completed');
  const attemptRef=result.run.data.output_refs.find(r=>r.path.includes('/attempts/'));
  assert.ok(attemptRef);const attempt=JSON.parse(await readFile(join(f.root,attemptRef.path),'utf8'));
  assert.equal(attempt.case_id,'C1');assert.equal(attempt.native_status,'passed');assert.equal(attempt.attempt,0);
  assert.equal(attempt.instance_id,result.run.data.plan[0].instance_id);
  assert.ok(attempt.steps.some(s=>s.title.startsWith('A1 ')));
  const before=f.fixture.state.browserRequests;
  const replay=await new UiRunService(f.root,f.authority).start({...request});
  assert.equal(replay.replayed,true);assert.deepEqual(replay.run_ref,result.run_ref);
  assert.equal(f.fixture.state.browserRequests,before,'same request must not create a context or execute again');
  await assert.rejects(service.start({...request,timeout_ms:20000}),/不能改变输入/);
  const second=await service.start({...request,request_id:'second-new-run'});
  assert.notEqual(second.run.id,result.run.id);assert.equal(second.run.data.exit_code,0);
  assert.deepEqual(second.run.data.plan,result.run.data.plan,'new context replays the same frozen case selection');
  assert.deepEqual((await service.status(request.task_id,request.request_id)).run_ref,result.run_ref);
});

test('UI-07: real product failure retains original exit code, assertion steps, screenshot and trace',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t,{targetFault:true});
  const result=await service.start(request);
  assert.equal(result.run.data.exit_code,1);assert.equal(result.run.data.state,'finished');
  assert.equal((await summary(f,result)).status,'completed','collection completion does not mean the product passed');
  assert.ok(result.run.data.output_refs.some(r=>r.path.endsWith('trace.zip')));
  assert.ok(result.run.data.output_refs.some(r=>r.path.endsWith('.png')));
  const attemptRef=result.run.data.output_refs.find(r=>r.path.includes('/attempts/'));
  const attempt=JSON.parse(await readFile(join(f.root,attemptRef.path),'utf8'));
  assert.equal(attempt.native_status,'failed');assert.equal(attempt.case_id,'C1');
  assert.ok(attempt.steps.some(s=>s.title.startsWith('A1 ')&&s.error));
});

test('UI-07: untrusted approval prevents reservation and browser activity',{timeout:30000},async t=>{
  const {f,assetRef,reviewed,config,spec}=await prepareDiagnostic(t);
  const service=new UiRunService(f.root,f.authority),before=f.fixture.state.browserRequests;
  await assert.rejects(service.start({task_id:'not-started',request_id:'no-runtime',asset_ref:assetRef,
    review_ref:reviewed.review_ref,environment_ref:spec.environment_ref,config_ref:config,timeout_ms:15000}),/运行就绪证明/);
  assert.equal(f.fixture.state.browserRequests,before);
  assert.equal((await f.store.reindex()).records.filter(r=>r.kind==='run').length,0);
});

test('UI-07: expired identity blocks business execution and retains preflight evidence',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t);
  const environment=JSON.parse(await readFile(join(f.root,request.environment_ref.path),'utf8'));
  const ref=await f.store.putFile('qa/ui/scopes/scope-1/expired-identity.json',JSON.stringify({
    ...environment,identity:{selector:'h1',text:'Signed-in admin'},
  }));
  const result=await service.start({...request,environment_ref:ref});
  const execution=await summary(f,result);
  assert.equal(execution.status,'blocked');assert.equal(execution.business_started,false);
  assert.equal(result.run.data.state,'finished');assert.equal(result.run.data.pid,undefined);
  assert.equal(result.run.data.output_refs.some(r=>r.path.endsWith('/process.json')),false);
  const preflightRef=result.run.data.output_refs.find(r=>r.path.endsWith('/preflight.json'));
  const preflight=JSON.parse(await readFile(join(f.root,preflightRef.path),'utf8'));
  assert.equal(preflight.check,'identity');assert.equal(preflight.status,'blocked');
});

test('UI-07: native process startup failure remains blocked with its actual exit and output',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t),previous=process.env.NODE_OPTIONS;
  t.after(()=>{if(previous===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=previous;});
  process.env.NODE_OPTIONS='--pi-ui-fixture-invalid-node-option';
  const result=await service.start(request);
  assert.equal(result.run.data.state,'finished');assert.notEqual(result.run.data.exit_code,0);
  const execution=await summary(f,result);assert.equal(execution.status,'blocked');
  assert.ok(execution.collection_problems.length);
  const processRef=result.run.data.output_refs.find(r=>r.path.endsWith('/process.json'));
  const observed=JSON.parse(await readFile(join(f.root,processRef.path),'utf8'));
  assert.match(observed.stderr,/pi-ui-fixture-invalid-node-option/);
  assert.equal(result.run.data.output_refs.some(r=>r.path.includes('/attempts/')),false);
});

test('UI-07: cancellation retains interrupted run and refuses a fresh request without reconciliation',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t),abort=new AbortController();
  const running=service.start(request,abort.signal);
  await until(async()=>{try{return (await service.status(request.task_id,request.request_id)).run.data.state==='running';}catch{return false;}});
  await assert.rejects(new UiRunService(f.root,f.authority).start(request),/资源已有任务占用/);
  abort.abort();
  const result=await running;
  assert.equal(result.run.data.state,'interrupted');assert.equal((await summary(f,result)).status,'cancelled');
  assert.ok(result.run.data.output_refs.some(r=>r.path.endsWith('/process-started.json')));
  const before=f.fixture.state.browserRequests;
  const replay=await service.start(request);assert.equal(replay.replayed,true);
  await assert.rejects(service.start({...request,request_id:'new-id-after-cancel'}),/不能重复启动/);
  assert.equal(f.fixture.state.browserRequests,before,'unknown run cannot be replayed under a new id');
});

test('UI-07: native global timeout preserves actual timeout and leaves the run for reconciliation',{timeout:60000},async t=>{
  const {f,service,request}=await ready(t,{globalSetupSource:
    "export default async function(){if(process.env.PI_UI_RUN_FIXTURE_HANG==='1')await new Promise(()=>{});}"});
  const previous=process.env.PI_UI_RUN_FIXTURE_HANG;
  t.after(()=>{if(previous===undefined)delete process.env.PI_UI_RUN_FIXTURE_HANG;else process.env.PI_UI_RUN_FIXTURE_HANG=previous;});
  process.env.PI_UI_RUN_FIXTURE_HANG='1';
  const result=await service.start({...request,timeout_ms:1000});
  const execution=await summary(f,result);
  assert.equal(execution.status,'unknown');assert.equal(result.run.data.state,'interrupted');
  const ref=result.run.data.output_refs.find(r=>r.path.endsWith('/report.json'));
  const native=JSON.parse(await readFile(join(f.root,ref.path),'utf8'));
  assert.match(JSON.stringify(native.errors),/timed?\s*out|timeout/i);
  await assert.rejects(service.start({...request,request_id:'after-timeout'}),/不能重复启动/);
});

test('UI-07: Pi Skill drives real review, diagnostic and formal execution; fresh Agent only queries the run',{timeout:60000},async t=>{
  const {f,assetRef,specRef,spec,config}=await prepareDiagnostic(t);
  const task=await f.store.load(f.taskRef);
  await f.store.put(artifact('task',{...task.data,intent:'execute',stage:'execute',completed_stages:['design-review'],
    asset_refs:[assetRef],run_ids:[],input_sha256:sha256('actual-tool-run')},'actual-execute'));
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  let host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);t.after(()=>host.dispose());
  const view=await host.create(f.root,true);assert.ok(view.skills.some(s=>s.name==='ui-test-run'));
  let calls=0,reviewRef,result;
  f.fixture.state.respond=body=>{
    if(body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试设计评估者'))){
      const user=body.messages.find(m=>m.role==='user');
      return {text:JSON.stringify(decision(JSON.parse(typeof user.content==='string'?user.content:textContent(user.content))))};
    }
    if(calls++===0)return {tool:'ui_design_review',args:{task_ref:f.taskRef,asset_ref:assetRef,request_id:'actual-run-review'}};
    const previous=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));
    if(calls===2){reviewRef=previous.output.review_ref;return {tool:'ui_design_diagnose',args:{request:{operation:'diagnose',
      asset_ref:assetRef,review_ref:reviewRef,spec_ref:specRef,request_id:'actual-run-diagnostic'}}};}
    if(calls===3){assert.equal(previous.output.runtime_ready,true);return {tool:'ui_test_run',args:{request:{operation:'start',input:{
      task_id:'actual-execute',request_id:'actual-formal',asset_ref:assetRef,review_ref:reviewRef,
      environment_ref:spec.environment_ref,config_ref:config,timeout_ms:15000}}}};}
    result=previous;return {text:'The formal run is saved; this response does not replace result analysis.'};
  };
  await host.send(view.id,'/skill:ui-test-run Execute the approved asset in a new formal run after review and diagnostics.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(result.status,'completed');assert.equal(result.output.run.data.exit_code,0);
  assert.equal(result.output.replayed,false);const ref=result.output.run_ref;
  await host.dispose();host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);
  const reopened=await host.create(f.root,true),before=f.fixture.state.browserRequests;let queries=0,status;
  f.fixture.state.respond=body=>{
    if(queries++===0)return {tool:'ui_test_run',args:{request:{operation:'status',task_id:'actual-execute',request_id:'actual-formal'}}};
    status=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));return {text:'Stored execution only.'};
  };
  await host.send(reopened.id,'Query the existing run only; do not execute.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.deepEqual(status.output.run_ref,ref);assert.equal(status.output.replayed,true);
  assert.equal(f.fixture.state.browserRequests,before);
});
