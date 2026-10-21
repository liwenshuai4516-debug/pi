import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { collectResults, reconcileRun, sha256, validateArtifact, verifyResults } from '../../packages/ui-testing/dist/index.js';
import { setup } from '../support/ui-design-fixture.mjs';
import { ready } from '../support/ui-run-fixture.mjs';
import { artifact } from '../support/ui-artifacts.mjs';

async function sample(t,{statuses=['passed'],missingStep=false,extra=false,expected='passed',preflight='completed',attachments=[],omit=false,receiptOwner,exitCode}={}){
  const f=await setup(t),base='qa/ui/runs/sample-run';
  const sameRunAttachment=receiptOwner ? await f.store.putFile(`${base}/output/screenshot.png`,'protocol fixture for attachment ownership only') : undefined;
  if(sameRunAttachment)attachments=[...attachments,{name:'screenshot',path:join(f.root,sameRunAttachment.path)}];
  const original=await f.store.load(f.taskRef);
  await f.store.put(artifact('task',{...original.data,asset_refs:[f.assetRef],run_ids:[],intent:'execute'},'sample-task'));
  const report={errors:[],suites:[{specs:[{title:'C1 Name persists',file:join(f.root,f.scriptRef.path),tests:[{
    projectName:'chromium',expectedStatus:expected,results:statuses.map((status,retry)=>({status,retry,
      steps:missingStep?[]:[{title:'A1 Name persists after reload',...(status==='failed'?{error:{message:'expect list to persist'}}:{})}],
      errors:status==='failed'?[{message:'expect list to persist'}]:[],attachments,
    })),
  }]}]}]};
  if(extra)report.suites[0].specs.push({...structuredClone(report.suites[0].specs[0]),title:'Unplanned test'});
  if(omit)report.suites=[];
  const raw=await f.store.putFile(`${base}/report.json`,JSON.stringify(report));
  const pre=await f.store.putFile(`${base}/preflight.json`,JSON.stringify({status:preflight}));
  const sum=await f.store.putFile(`${base}/execution-summary.json`,JSON.stringify({status:'completed',formal_run:true}));
  const outputs=[raw,pre,sum];
  if(sameRunAttachment){
    outputs.push(sameRunAttachment,await f.store.putFile(`${base}/attempts/synthetic-receipt.json`,JSON.stringify({
      run_id:'sample-run',instance_id:receiptOwner,case_id:'C1',attempt:0,native_status:statuses[0],raw_ref:raw,
      steps:report.suites[0].specs[0].tests[0].results[0].steps,attachments,evidence_refs:[sameRunAttachment],
    })));
  }
  const run=artifact('run',{task_id:'sample-task',request_id:'sample',asset_ref:f.assetRef,environment_id:'test',deployment_version:'fixture',role:'tester',
    plan:[{instance_id:'I1',case_id:'C1',revision:'v1',data_row_id:'default',browser_project:'chromium'}],state:'pending',
    command:['synthetic-reporter-fixture'],process_token:sha256('sample'),output_refs:outputs},'sample-run');
  const reservation=await f.store.reserveRun(run);
  const runRef=await f.store.finishRun(reservation.ref,exitCode===undefined?(statuses.includes('failed')?1:0):exitCode,outputs,exitCode===null);
  return {f,runRef,raw,base};
}

test('UI-08: attempts never increase denominator; retry success remains flaky and zero denominator is null',async t=>{
  const {f,runRef}=await sample(t,{statuses:['failed','passed']});
  const result=await reconcileRun(f.root,runRef);
  assert.equal(result.data.planned_count,1);assert.equal(result.data.counts.flaky,1);
  assert.equal(result.data.counts.passed,0);assert.equal(result.data.instances[0].attempts.length,2);
  assert.equal(result.details.stable_pass_rate,0);
  const skipped=await sample(t,{statuses:['skipped']});
  const zero=await reconcileRun(skipped.f.root,skipped.runRef);
  assert.equal(zero.data.counts.skipped,1);assert.equal(zero.details.stable_pass_rate,null);
  const interrupted=await sample(t,{statuses:['interrupted'],exitCode:null});
  const cancelled=await reconcileRun(interrupted.f.root,interrupted.runRef);
  assert.equal(cancelled.data.counts.cancelled,1);assert.equal(cancelled.details.complete,false);
  assert.ok(cancelled.details.issues.some(i=>i.rule==='R1'&&i.reason.includes('中断')));
});

test('UI-08: passed without reached assertions, unplanned instances and expected failures cannot become stable passes',async t=>{
  const missing=await sample(t,{missingStep:true,extra:true});
  const result=await reconcileRun(missing.f.root,missing.runRef);
  assert.equal(result.data.counts.unknown,1);assert.equal(result.details.unplanned.length,1);
  assert.ok(result.details.issues.some(i=>i.rule==='R2'));
  const expected=await sample(t,{statuses:['failed'],expected:'failed'});
  const failed=await reconcileRun(expected.f.root,expected.runRef);
  assert.equal(failed.data.counts.failed,1);assert.equal(failed.data.counts.passed,0);
});

test('UI-08: schema rejects arithmetic changes and duplicate instance identities',async t=>{
  const {f,runRef}=await sample(t);const result=await collectResults(f.root,runRef,'r1');
  const stored=await f.store.load(result.results_ref);
  stored.data.counts.passed=2;assert.throws(()=>validateArtifact(stored),/互斥实例/);
  stored.data.counts.passed=1;stored.data.instances.push(stored.data.instances[0]);
  assert.throws(()=>validateArtifact(stored),/重复/);
  const forged=await f.store.load(result.results_ref);forged.id='forged-balanced-counts';
  forged.data.instances[0].status='failed';forged.data.counts.passed=0;forged.data.counts.failed=1;
  const forgedRef=await f.store.put(forged);
  await assert.rejects(verifyResults(f.root,forgedRef),/统计或证据状态/);
});

test('UI-08: missing planned result retains denominator; foreign native attachments cannot establish complete evidence',async t=>{
  const missing=await sample(t,{omit:true});const absent=await reconcileRun(missing.f.root,missing.runRef);
  assert.equal(absent.data.planned_count,1);assert.equal(absent.data.counts.unknown,1);
  assert.ok(absent.details.issues.some(i=>i.rule==='R1'&&i.instance_id==='I1'));
  const foreign=await sample(t,{attachments:[{name:'screenshot',path:'qa/ui/runs/another/output/screenshot.png'}]});
  const mixed=await reconcileRun(foreign.f.root,foreign.runRef);
  assert.equal(mixed.data.counts.passed,1,'a foreign attachment does not rewrite the native outcome');
  assert.equal(mixed.data.instances[0].evidence_state,'missing');
  assert.ok(mixed.details.issues.some(i=>i.rule==='R3'&&i.reason.includes('截图/trace')));
  assert.equal(mixed.details.complete,false);
  const wrongOwner=await sample(t,{receiptOwner:'I2'});const swapped=await reconcileRun(wrongOwner.f.root,wrongOwner.runRef);
  assert.equal(swapped.data.instances[0].evidence_state,'missing');
  assert.ok(swapped.details.issues.some(i=>i.reason.includes('run/case/attempt')));
  assert.equal(swapped.data.instances[0].attempts[0].evidence_refs.some(r=>r.path.endsWith('screenshot.png')),false);
});

test('UI-08: real successful and failed runs reconcile; missing trace preserves failure and marks evidence gap',{timeout:60000},async t=>{
  const healthy=await ready(t);const successful=await healthy.service.start(healthy.request);
  const passed=await collectResults(healthy.f.root,successful.run_ref,'real-success');
  assert.equal(passed.data.counts.passed,1);assert.equal(passed.details.stable_pass_rate,1);
  assert.equal(passed.details.complete,true,JSON.stringify(passed.details));
  assert.equal(passed.details.design.decision,'approved');assert.equal(passed.details.design.approved_count,1);
  const {f,service,request}=await ready(t,{targetFault:true});const run=await service.start(request);
  const result=await collectResults(f.root,run.run_ref,'real-failure');
  assert.equal(result.data.counts.failed,1);assert.equal(result.details.complete,true,JSON.stringify(result.details));
  const before=f.fixture.state.browserRequests;
  assert.deepEqual((await collectResults(f.root,run.run_ref,'real-failure')).results_ref,result.results_ref);
  assert.equal(f.fixture.state.browserRequests,before,'analysis must not run a browser');
  const trace=run.run.data.output_refs.find(r=>r.path.endsWith('/trace.zip'));await rm(join(f.root,trace.path));
  const incomplete=await collectResults(f.root,run.run_ref,'missing-trace');
  assert.equal(incomplete.data.counts.failed,1);assert.equal(incomplete.data.instances[0].evidence_state,'missing');
  assert.equal(incomplete.details.complete,false);
  const saved=await f.store.load(incomplete.results_ref);assert.equal(saved.data.counts.failed,1);
});
