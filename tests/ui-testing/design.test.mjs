import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import { assetDigest, checkDesign, designEvidence, DesignReviewService, RuntimeAdmissionService, runDesignDiagnostics, checkDiagnosticReport, sha256 } from '../../packages/ui-testing/dist/index.js';
import { designReview } from '../support/ui-artifacts.mjs';
import { copyLiveModel, textContent, repoRoot } from '../support/ui-fixture.mjs';
import { until } from '../support/fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';

import { validCode, response, setup, decision, prepareDiagnostic } from '../support/ui-design-fixture.mjs';

test('UI-06: native diagnostic service preserves positive and negative reports without granting execution readiness', {timeout:60000},async t=>{
  const {f,base,config,environment,spec,specRef,asset,assetRef,reviewed}=await prepareDiagnostic(t);
  const scriptBefore=await readFile(join(f.root,f.scriptRef.path));
  const validation=await runDesignDiagnostics(f.root,assetRef,reviewed.review_ref,specRef);
  assert.equal(validation.status,'validated');assert.equal(validation.formal_run,false);assert.equal(validation.rounds.length,2);
  assert.deepEqual(validation.rounds.flatMap(r=>r.problems),[]);
  const saved=JSON.parse(await readFile(join(f.root,validation.summary_ref.path),'utf8'));
  assert.equal(saved.purpose,'design-validation');assert.deepEqual(saved.asset_ref,assetRef);
  assert.equal(saved.rounds[1].id,'discard-persistence');
  assert.ok(saved.rounds[1].evidence_refs.some(r=>r.path.endsWith('trace.zip')));
  const negative=JSON.parse(await readFile(join(f.root,saved.rounds[1].report_ref.path),'utf8'));
  assert.ok(JSON.stringify(negative).includes('toHaveText'));
  assert.deepEqual(checkDiagnosticReport(f.root,asset,negative,['A1']),[]);
  const nativeTests=report=>report.suites.flatMap(function walk(s){return [...s.specs.flatMap(spec=>spec.tests),...(s.suites??[]).flatMap(walk)];});
  const setupFailure=structuredClone(negative);nativeTests(setupFailure)[0].results[0].steps=[];
  assert.ok(checkDiagnosticReport(f.root,asset,setupFailure,['A1']).some(p=>p.includes('expect')));
  const timeout=structuredClone(negative);nativeTests(timeout)[0].results[0].status='timedOut';
  assert.ok(checkDiagnosticReport(f.root,asset,timeout,['A1']).length);
  const unexpectedPass=structuredClone(negative);nativeTests(unexpectedPass)[0].results[0].status='passed';
  assert.ok(checkDiagnosticReport(f.root,asset,unexpectedPass,['A1']).length);
  const expectedFailure=structuredClone(negative);nativeTests(expectedFailure)[0].expectedStatus='failed';
  assert.ok(checkDiagnosticReport(f.root,asset,expectedFailure,['A1']).length);
  const retried=structuredClone(negative);nativeTests(retried)[0].results.push(nativeTests(retried)[0].results[0]);
  assert.ok(checkDiagnosticReport(f.root,asset,retried,['A1']).length);
  const withLifecycle=record=>{
    const report=structuredClone(negative);
    nativeTests(report)[0].results[0].attachments.push({name:'ui-data-lifecycle',body:Buffer.from(JSON.stringify({
      residual:['owned-1'],records:[{business_key:'owned-1',...record}],
    })).toString('base64')});return report;
  };
  assert.ok(checkDiagnosticReport(f.root,asset,withLifecycle({cleanup_state:'failed'}),['A1']).some(p=>p.includes('清理')));
  assert.deepEqual(checkDiagnosticReport(f.root,asset,withLifecycle({cleanup_state:'retained',cleanup_reason:'Explicit fixture retention agreement'}),['A1']),[]);
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/运行就绪/,
    'raw diagnostic evidence is not a trusted runtime admission receipt');
  await assert.rejects(runDesignDiagnostics(f.root,f.assetRef,reviewed.review_ref,specRef),/纳入获批修订/);
  const unavailable=await f.store.putFile(`${base}/unreachable.json`,JSON.stringify(environment('http://127.0.0.1:1')));
  const unavailableSpec=await f.store.putFile(`${base}/unreachable-plan.json`,JSON.stringify({...spec,probes:[{...spec.probes[0],environment_ref:unavailable}]}));
  const other=structuredClone(asset);other.id='names-unreachable';other.data.files.push(unavailable,unavailableSpec);other.data.content_sha256=assetDigest(other);
  const otherRef=await f.store.put(other),otherReview=await f.service.assess(f.taskRef,otherRef,'unreachable-review',response);
  const blocked=await runDesignDiagnostics(f.root,otherRef,otherReview.review_ref,unavailableSpec);
  assert.equal(blocked.status,'blocked');assert.equal(blocked.rounds.length,2);
  assert.equal(blocked.rounds[1].process_ref,undefined,'preflight failure must stop before candidate business actions');
  assert.ok(blocked.rounds[1].problems.some(p=>p.includes('site')));
  assert.deepEqual(await readFile(join(f.root,f.scriptRef.path)),scriptBefore,'diagnostics must not weaken or rewrite the candidate');
});

test('UI-06: TypeScript and binding checks accept a complete source-grounded candidate',async t=>{
  const f=await setup(t),check=await checkDesign(f.root,f.assetRef);
  assert.deepEqual(check.issues,[]);assert.deepEqual(check.coverage.missing,[]);
  assert.ok(check.dependencies.some(d=>d.name==='playwright'&&d.version==='1.62.1'));
  const evidence=await designEvidence(f.root,f.assetRef);
  assert.ok(evidence.some(f=>f.ref.path==='requirements.md'));
  assert.ok(evidence.some(file=>file.ref.path===f.scriptRef.path));
  await assert.rejects(designEvidence(f.root,f.assetRef,1),/超过预算/);
});

test('UI-06: trusted runtime admission deduplicates actions, survives restart and rejects altered evidence or rules', {timeout:60000},async t=>{
  const {f,assetRef,reviewed,specRef}=await prepareDiagnostic(t),runtime=new RuntimeAdmissionService(f.root,f.authority);
  const running=runtime.diagnose(assetRef,reviewed.review_ref,specRef,'trusted-diagnostic');
  await until(async()=>{try{return (await runtime.status('trusted-diagnostic')).started;}catch{return false;}});
  await assert.rejects(new RuntimeAdmissionService(f.root,f.authority).diagnose(assetRef,reviewed.review_ref,specRef,'concurrent'),/已有诊断/);
  const result=await running;assert.equal(result.runtime_ready,true);
  await new DesignReviewService(f.root,f.authority).gate(assetRef,reviewed.review_ref);
  const requests=f.fixture.state.browserRequests;
  const duplicate=await new RuntimeAdmissionService(f.root,f.authority).diagnose(assetRef,reviewed.review_ref,specRef,'trusted-diagnostic');
  assert.deepEqual(duplicate.summary_ref,result.summary_ref);assert.equal(duplicate.runtime_ready,true);
  assert.equal(f.fixture.state.browserRequests,requests,'request replay must not start browser actions');
  const interrupted=join(f.authority,'runtime/requests/interrupted-other-module.json');
  const oldRequest={request_id:'interrupted-other',asset_ref:assetRef,review_ref:reviewed.review_ref,spec_ref:specRef,
    module_ids:['unrelated-module'],state:'unknown',started:true};
  await writeFile(interrupted,JSON.stringify(oldRequest));
  await f.service.gate(assetRef,reviewed.review_ref);
  assert.equal((await runtime.status('trusted-diagnostic')).runtime_ready,true,'unrelated module must not invalidate this receipt');
  await writeFile(interrupted,JSON.stringify({...oldRequest,module_ids:['names']}));
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/未核对诊断/);
  await writeFile(interrupted,JSON.stringify({...oldRequest,module_ids:undefined}));
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/未核对诊断/,'legacy unknown scope must remain blocked');
  await writeFile(interrupted,JSON.stringify({...oldRequest,state:'completed'}));
  await assert.rejects(runtime.diagnose(assetRef,reviewed.review_ref,{...specRef,sha256:'a'.repeat(64)},'trusted-diagnostic'),/不能改变输入/);
  const trace=result.rounds[1].evidence_refs.find(r=>r.path.endsWith('trace.zip'));
  const traceBytes=await readFile(join(f.root,trace.path));await writeFile(join(f.root,trace.path),'changed evidence');
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/摘要不匹配/);
  assert.equal((await runtime.status('trusted-diagnostic')).runtime_ready,false);
  await writeFile(join(f.root,trace.path),traceBytes);
  const accepted=join(f.authority,'runtime','accepted'),[filename]=await readdir(accepted),receiptPath=join(accepted,filename);
  const receipt=await readFile(receiptPath,'utf8');
  await writeFile(receiptPath,JSON.stringify({...JSON.parse(receipt),rules_version:'old-rules'}));
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/规则已变化/);
  await writeFile(receiptPath,receipt);
  await f.service.gate(assetRef,reviewed.review_ref);
});

test('UI-06: diagnostic cancellation remains unknown and cannot be bypassed with a new request id', {timeout:60000},async t=>{
  const {f,assetRef,reviewed,specRef}=await prepareDiagnostic(t),runtime=new RuntimeAdmissionService(f.root,f.authority),abort=new AbortController();
  const running=runtime.diagnose(assetRef,reviewed.review_ref,specRef,'cancelled-diagnostic',abort.signal);
  const diagnosticRoot=join(f.root,'qa/ui/assets/names-diagnostic/revisions/v1/diagnostics');
  await until(async()=>{
    try { return (await Promise.all((await readdir(diagnosticRoot)).map(async dir=>{
      try {await readFile(join(diagnosticRoot,dir,'positive','playwright.config.mjs'));return true;}catch{return false;}
    }))).some(Boolean); }catch{return false;}
  });
  abort.abort();
  const result=await running;assert.equal(result.status,'cancelled');assert.equal(result.runtime_ready,false);
  const status=await runtime.status('cancelled-diagnostic');assert.equal(status.state,'unknown');assert.ok(status.input_ref);
  const requests=f.fixture.state.browserRequests;
  await assert.rejects(runtime.diagnose(assetRef,reviewed.review_ref,specRef,'another-request'),/结果不明/);
  await assert.rejects(runtime.diagnose(assetRef,reviewed.review_ref,specRef,'cancelled-diagnostic'),/未确认完成/);
  await assert.rejects(f.service.gate(assetRef,reviewed.review_ref),/未核对诊断/);
  assert.equal(f.fixture.state.browserRequests,requests);
});

test('UI-06: healthy control permits readiness when the current application has a real business defect', {timeout:60000},async t=>{
  const {f,assetRef,reviewed,specRef}=await prepareDiagnostic(t,{targetFault:true});
  const result=await new RuntimeAdmissionService(f.root,f.authority).diagnose(assetRef,reviewed.review_ref,specRef,'faulty-product');
  assert.equal(result.runtime_ready,true);assert.ok(result.target_preflight_ref);
  const input=JSON.parse(await readFile(join(f.root,result.input_ref.path),'utf8'));
  assert.notEqual(input.environments[0].base_url,input.control.base_url,'the healthy control is separate from the faulty test target');
  await f.service.gate(assetRef,reviewed.review_ref);
});

test('UI-06: empty/tautological assertions, mapping loss, syntax errors and missing primary scenarios are blocked',async t=>{
  const f=await setup(t);
  const constant=await f.make('constant',validCode.replace("expect(page.getByRole('listitem')).toHaveText([key])","expect(true).toBe(true)"));
  assert.ok((await checkDesign(f.root,constant.assetRef)).issues.some(i=>i.rule==='D4'));
  const empty=await f.make('empty',validCode.replace("await expect(page.getByRole('listitem')).toHaveText([key]);",''));
  assert.ok((await checkDesign(f.root,empty.assetRef)).issues.some(i=>i.rule==='D4'&&i.assertion_id==='A1'));
  const broken=await f.make('broken',validCode+'\nconst = ;');
  assert.ok((await checkDesign(f.root,broken.assetRef)).issues.some(i=>i.rule==='D3'));
  const missing=await f.make('missing',validCode,c=>c.data.cases[0].scenario_id='another-scenario');
  assert.ok((await checkDesign(f.root,missing.assetRef)).issues.some(i=>i.rule==='D1'));
  const skip=await f.make('skip',validCode.replace("test('C1", "test.skip('C1"));
  assert.ok((await checkDesign(f.root,skip.assetRef)).issues.some(i=>i.rule==='D6'));
  const textRef=await f.store.putFile('qa/ui/assets/names/revisions/text/script.txt',validCode);
  const textAsset=structuredClone(f.asset);textAsset.id='names-text';
  textAsset.data.files=textAsset.data.files.map(r=>r.path===f.scriptRef.path?textRef:r);
  textAsset.data.bindings[0].script_ref=textRef;textAsset.data.content_sha256=assetDigest(textAsset);
  assert.ok((await checkDesign(f.root,await f.store.put(textAsset))).issues.some(i=>i.rule==='D3'&&i.reason.includes('可解析')));
});

test('UI-06: trusted design approval survives restart; forged approval and stale files cannot pass gate',async t=>{
  const f=await setup(t);let calls=0;
  const reviewed=await f.service.assess(f.taskRef,f.assetRef,'request-1',async input=>{calls++;return response(input);});
  assert.equal(reviewed.decision,'approved');
  await new DesignReviewService(f.root,f.authority).gate(f.assetRef,reviewed.review_ref,false);
  const duplicate=await f.service.assess(f.taskRef,f.assetRef,'request-1',async()=>{throw new Error('must not call twice');});
  assert.deepEqual(duplicate,reviewed);assert.equal(calls,1);
  await assert.rejects(f.service.gate(f.assetRef,reviewed.review_ref),/运行就绪/);
  const fake=designReview();fake.id='forged';fake.data.subject_ref=f.assetRef;fake.data.subject_sha256=f.assetRef.sha256;
  fake.data.raw_ref=await f.store.putFile('qa/ui/assets/names/revisions/v1/reviews/forged/raw.json','{}');
  const fakeRef=await f.store.put(fake);
  await assert.rejects(f.service.gate(f.assetRef,fakeRef,false),/独立评估调用路径/);
  await writeFile(join(f.root,f.scriptRef.path),validCode+'// changed');
  await assert.rejects(f.service.gate(f.assetRef,reviewed.review_ref,false),/摘要不匹配/);
});

test('UI-06: model approval cannot override deterministic blockers or invent evidence quotations',async t=>{
  const f=await setup(t);
  const bad=await f.make('bad',validCode.replace("expect(page.getByRole('listitem')).toHaveText([key])","expect(true).toBe(true)"));
  const review=await f.service.assess(f.taskRef,bad.assetRef,'bad-request',response);
  assert.equal(review.decision,'revise');
  const saved=await f.store.load(review.review_ref);
  assert.ok(saved.data.issues.some(i=>i.rule==='D4'&&i.blocking));
  assert.equal(saved.data.checks.find(c=>c.rule==='D4').verdict,'fail');
  const good=await f.make('fixed');
  await assert.rejects(f.service.assess(f.taskRef,good.assetRef,'wrong-quote',async input=>{
    const d=decision(input);d.checks[0].evidence[0].quote='fabricated quotation that is not in the original evidence';
    return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  }),/不存在的引文/);
  const raw=(await f.store.reindex()).records.filter(r=>r.kind==='design-review');
  assert.equal(raw.length,1,'invalid response must not create another approval');
});

test('UI-06: evidence anchors restore exact citations and invalid responses return preserved evidence references',async t=>{
  const f=await setup(t);
  const reviewed=await f.service.assess(f.taskRef,f.assetRef,'anchor-good',async input=>{
    const d=decision(input),source=input.evidence.find(e=>e.ref.path==='requirements.md');
    d.checks.forEach(c=>{c.evidence=[{anchor_id:source.anchors[0].anchor_id}];});
    return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  });
  const saved=await f.store.load(reviewed.review_ref);
  for(const c of saved.data.checks){assert.equal(c.evidence[0].ref.path,'requirements.md');assert.equal(c.evidence[0].quote,'R1: Saved Name persists after reload.');}
  let refs;
  await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'anchor-bad',async input=>{
    const d=decision(input);d.checks[0].evidence=[{anchor_id:'E9999L9999'}];
    return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  }),error=>{assert.match(error.message,/不存在的原文片段/);refs=error.artifact_refs;assert.equal(refs.length,3);return true;});
  for(const ref of refs)assert.equal(sha256(await readFile(join(f.root,ref.path))),ref.sha256);
  await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'anchor-bad',()=>{throw new Error('must not repeat model call');}),
    error=>{assert.deepEqual(error.artifact_refs,refs);return true;});
});

test('UI-06: rejected failed checks retain their original evidence as blocking issues',async t=>{
  const f=await setup(t);
  const reviewed=await f.service.assess(f.taskRef,f.assetRef,'failed-check-only',async input=>{
    const d=decision(input,'revise');d.issues=[];
    d.checks[1].reason='The expected value needs an independently verified requirement.';
    return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  });
  assert.equal(reviewed.decision,'revise');
  const saved=await f.store.load(reviewed.review_ref);
  const issue=saved.data.issues.find(i=>i.rule==='D2'&&i.blocking);
  assert.equal(issue.reason,saved.data.checks[1].reason);
  assert.deepEqual(issue.evidence_refs,saved.data.checks[1].evidence.map(e=>e.ref));
  await assert.rejects(f.service.gate(f.assetRef,reviewed.review_ref,false),/批准/);
  await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'contradictory-approval',async input=>{
    const d=decision(input);d.checks[1].verdict='fail';
    return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  }),/失败规则没有对应阻断问题/);
});

test('UI-06: no improvement stops after two rejected evaluations; a third completed rejection never auto-approves',async t=>{
  const f=await setup(t);
  const reject=async input=>({raw:JSON.stringify(decision(input,'revise',input.previous?'none':'first')),provider:'fixture',model:'protocol'});
  assert.equal((await f.service.assess(f.taskRef,f.assetRef,'a',reject)).decision,'revise');
  assert.equal((await f.service.assess(f.taskRef,f.assetRef,'b',reject)).decision,'blocked');
  await assert.rejects(f.service.assess(f.taskRef,f.assetRef,'c',reject),/上一轮已阻塞/);
  const another=await setup(t);
  for(let i=1;i<=3;i++){
    const c=i===1?another:await another.make(`v${i}`,validCode+`\n// adversarial provider claims improvement ${i}`);
    const result=await another.service.assess(another.taskRef,c.assetRef,`request-${i}`,async input=>({raw:JSON.stringify(decision(input,'revise')),provider:'fixture',model:'protocol'}));
    assert.equal(result.decision,'revise');
  }
  await assert.rejects(another.service.assess(another.taskRef,another.assetRef,'request-4',response),/预算已耗尽/);
});

test('UI-06: a rejected assertion is corrected in a new revision and independently reassessed',async t=>{
  const f=await setup(t);
  const bad=await f.make('loop-bad',validCode.replace("expect(page.getByRole('listitem')).toHaveText([key])","expect(true).toBe(true)"));
  const first=await f.service.assess(f.taskRef,bad.assetRef,'loop-first',response);
  assert.equal(first.decision,'revise');
  const fixed=await f.make('loop-fixed');
  const second=await f.service.assess(f.taskRef,fixed.assetRef,'loop-second',response);
  assert.equal(second.decision,'approved');assert.equal(second.round,2);
  const original=await f.store.load(first.review_ref),next=await f.store.load(second.review_ref);
  assert.deepEqual(next.data.previous_review_ref,first.review_ref);
  assert.notEqual(original.data.reviewer.context_id,next.data.reviewer.context_id);
  assert.equal(original.data.decision,'revise');
  assert.equal(next.data.improvement,'improved');
  await f.service.gate(fixed.assetRef,second.review_ref,false);
  await assert.rejects(f.service.gate(bad.assetRef,second.review_ref,false),/当前摘要/);
});

test('UI-06: actual Pi review tool starts a separate Agent with no tools or generator conversation', {timeout:60000},async t=>{
  const f=await setup(t),host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);t.after(()=>host.dispose());
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  const view=await host.create(f.root,true);assert.ok(view.skills.some(s=>s.name==='ui-design-review'));
  let generatorCalls=0,reviewCalls=0,result;
  f.fixture.state.respond=body=>{
    const independent=body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试设计评估者'));
    if(independent){
      reviewCalls++;assert.equal(body.tools?.length??0,0);
      assert.equal(body.messages.filter(m=>m.role==='user').length,1);
      const user=body.messages.find(m=>m.role==='user');const input=JSON.parse(typeof user.content==='string'?user.content:textContent(user.content));
      assert.equal(JSON.stringify(input).includes('GENERATOR_PRIVATE_CONVERSATION_MARKER'),false);
      return {text:JSON.stringify(decision(input))};
    }
    if(generatorCalls++===0)return {tool:'ui_design_review',args:{task_ref:f.taskRef,asset_ref:f.assetRef,request_id:'actual-pi-review'}};
    result=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));return {text:'Independent design review saved. Runtime checks are still required.'};
  };
  await host.send(view.id,'/skill:ui-design-review GENERATOR_PRIVATE_CONVERSATION_MARKER Review the stored candidate.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(reviewCalls,1);assert.equal(result.status,'completed');assert.equal(result.output.decision,'approved');
  const saved=await f.store.load(result.artifact_refs[0]);assert.equal(saved.data.reviewer.isolation,'separate-agent');
  const input=JSON.parse(await readFile(join(f.root,saved.data.input_ref.path),'utf8'));
  assert.equal(input.system_prompt.startsWith('你是独立 UI 测试设计评估者'),true);
  await host.dispose();
});

test('UI-06: actual Pi review and diagnostic tools register readiness and a new Agent can inspect it without replay', {timeout:60000},async t=>{
  const {f,assetRef,specRef}=await prepareDiagnostic(t);
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  let host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);t.after(()=>host.dispose());
  const view=await host.create(f.root,true);let calls=0,reviewRef,diagnostic;
  f.fixture.state.respond=body=>{
    if(body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试设计评估者'))){
      const user=body.messages.find(m=>m.role==='user');return {text:JSON.stringify(decision(JSON.parse(typeof user.content==='string'?user.content:textContent(user.content))))};
    }
    if(calls++===0)return {tool:'ui_design_review',args:{task_ref:f.taskRef,asset_ref:assetRef,request_id:'tool-review'}};
    const previous=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));
    if(calls===2){reviewRef=previous.output.review_ref;return {tool:'ui_design_diagnose',args:{request:{operation:'diagnose',
      asset_ref:assetRef,review_ref:reviewRef,spec_ref:specRef,request_id:'tool-diagnostic'}}};}
    diagnostic=previous;return {text:'Design and controlled diagnostics passed. No formal run has been executed.'};
  };
  await host.send(view.id,'/skill:ui-design-review Review and diagnose the isolated candidate; do not run formal regression.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(diagnostic.status,'completed');assert.equal(diagnostic.output.runtime_ready,true);
  assert.equal(diagnostic.output.formal_run,false);
  await host.dispose();host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);
  const reopened=await host.create(f.root,true),requests=f.fixture.state.browserRequests;let statusCalls=0,status;
  f.fixture.state.respond=body=>{
    if(statusCalls++===0)return {tool:'ui_design_diagnose',args:{request:{operation:'status',request_id:'tool-diagnostic'}}};
    status=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));return {text:'Stored readiness was verified without browser replay.'};
  };
  await host.send(reopened.id,'Inspect the existing tool-diagnostic request only.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(status.output.runtime_ready,true);assert.equal(status.output.state,'completed');
  assert.equal(f.fixture.state.browserRequests,requests);
});

test('UI-06: composite observed values and reusable local assertion helpers remain valid',async t=>{
  const f=await setup(t);
  const composite=await f.make('composite',validCode.replace("expect(page.getByRole('listitem')).toHaveText([key])","expect([await page.getByRole('listitem').allTextContents()]).toEqual([[key]])"));
  assert.deepEqual((await checkDesign(f.root,composite.assetRef)).issues,[]);
  const helperRef=await f.store.putFile('qa/ui/assets/names/revisions/helper/verify.ts',
    "import {expect,type Page} from 'playwright/test';export async function verifySaved(page:Page,key:string){await expect(page.getByRole('listitem')).toHaveText([key]);}");
  const helper=await f.make('helper',"import {verifySaved} from './verify.js';\n"+validCode.replace("await expect(page.getByRole('listitem')).toHaveText([key]);","await verifySaved(page,key);"));
  const asset=structuredClone(helper.asset);asset.id='names-helper';asset.data.files.push(helperRef);asset.data.content_sha256=assetDigest(asset);
  const ref=await f.store.put(asset);
  assert.deepEqual((await checkDesign(f.root,ref)).issues,[]);
  const unbound=await checkDesign(f.root,helper.assetRef);
  assert.ok(unbound.issues.some(i=>i.rule==='D10'&&i.reason.includes('verify.ts')),'shared helper must be bound to content digest');
  const badHelper=await f.store.putFile('qa/ui/assets/names/revisions/bad-helper/verify.ts',
    "import {expect} from 'playwright/test';export async function verifySaved(_page:unknown,_key:string){await expect(true).toBe(true);}");
  const bad=await f.make('bad-helper',"import {verifySaved} from './verify.js';\n"+validCode.replace("await expect(page.getByRole('listitem')).toHaveText([key]);","await verifySaved(page,key);"));
  const badAsset=structuredClone(bad.asset);badAsset.id='names-bad-helper';badAsset.data.files.push(badHelper);badAsset.data.content_sha256=assetDigest(badAsset);
  const badRef=await f.store.put(badAsset);
  assert.ok((await checkDesign(f.root,badRef)).issues.some(i=>i.rule==='D4'&&i.evidence_refs.some(r=>r.path===badHelper.path)));
  const config=await f.store.putFile('qa/ui/assets/names/revisions/config/base.config.mjs',"import settings from './settings.js';export default settings;");
  const settings=await f.store.putFile('qa/ui/assets/names/revisions/config/settings.js','export default {timeout:10000};');
  const configAsset=structuredClone(f.asset);configAsset.id='names-config';configAsset.data.files.push(config);configAsset.data.content_sha256=assetDigest(configAsset);
  assert.ok((await checkDesign(f.root,await f.store.put(configAsset))).issues.some(i=>i.rule==='D10'&&i.reason.includes('settings.js')));
  configAsset.id='names-config-complete';configAsset.data.files.push(settings);configAsset.data.content_sha256=assetDigest(configAsset);
  assert.deepEqual((await checkDesign(f.root,await f.store.put(configAsset))).issues,[]);
});

test('UI-06: compiler configuration and inherited options are frozen with the asset',async t=>{
  const f=await setup(t);
  const rootConfig='{"extends":"./tsconfig.base.json"}',baseConfig='{"compilerOptions":{"target":"ES2022"}}';
  await writeFile(join(f.root,'tsconfig.json'),rootConfig);await writeFile(join(f.root,'tsconfig.base.json'),baseConfig);
  assert.ok((await checkDesign(f.root,f.assetRef)).issues.some(i=>i.rule==='D10'&&i.reason.includes('编译配置')));
  const asset=structuredClone(f.asset);asset.id='names-compiler';
  asset.data.compiler_config_ref={path:'tsconfig.json',sha256:sha256(rootConfig)};asset.data.files.push(asset.data.compiler_config_ref);
  asset.data.content_sha256=assetDigest(asset);
  assert.ok((await checkDesign(f.root,await f.store.put(asset))).issues.some(i=>i.rule==='D10'&&i.reason.includes('tsconfig.base.json')));
  asset.id='names-compiler-complete';asset.data.files.push({path:'tsconfig.base.json',sha256:sha256(baseConfig)});asset.data.content_sha256=assetDigest(asset);
  const ref=await f.store.put(asset);assert.deepEqual((await checkDesign(f.root,ref)).issues,[]);
  const reviewed=await f.service.assess(f.taskRef,ref,'compiler-config-review',response);
  await writeFile(join(f.root,'tsconfig.base.json'),'{"compilerOptions":{"target":"ES2020"}}');
  await assert.rejects(f.service.gate(ref,reviewed.review_ref,false),/摘要不匹配/);
});

test('UI-06 live: independent reviewer accepts grounded design and rejects unsupported requirements',{
  skip:process.env.PI_UI_DESIGN_LIVE!=='1',timeout:300000,
},async t=>{
  const {f,asset,assetRef}=await prepareDiagnostic(t);
  const selected=await copyLiveModel(f.fixture.agentDir,process.env.PI_UI_MODEL_DIR??join(homedir(),'.pi/agent'));
  const runtime=await ModelRuntime.create({authPath:join(f.fixture.agentDir,'auth.json'),modelsPath:join(f.fixture.agentDir,'models.json')});
  const model=(await runtime.getAvailable()).find(m=>m.provider===selected.provider&&m.id===selected.modelId);assert.ok(model);
  const call=async input=>{
    const {system_prompt:systemPrompt,...facts}=input;
    const reviewer=new Agent({initialState:{model,tools:[],messages:[],thinkingLevel:'off',systemPrompt},convertToLlm,
      streamFn:(m,context,options)=>runtime.streamSimple(m,context,options)});
    const timer=setTimeout(()=>reviewer.abort(),120000);
    try{await reviewer.prompt(JSON.stringify(facts));}finally{clearTimeout(timer);}
    const message=[...reviewer.state.messages].reverse().find(m=>m.role==='assistant');
    return {raw:textContent(message?.content),provider:model.provider,model:model.id,stop_reason:message?.stopReason??'error'};
  };
  const task=await f.store.load(f.taskRef);
  const taskRef=await f.store.put({...task,id:'live-design-task',data:{...task.data,input_sha256:sha256('live-design-smoke')}});
  const evidence=join(repoRoot,'evidence/ui-testing/ui-06',String(Date.now()));await mkdir(evidence,{recursive:true});
  try{
    const good=await f.service.assess(taskRef,assetRef,'live-grounded',call);
    const wrong=await f.make('live-wrong',validCode.replace('toHaveText([key])','toHaveText([key.toUpperCase()])'),c=>{
      c.data.sources[0].statement='R1 requires Save to uppercase every Name.';
      c.data.cases[0].assertions[0].expected={from:'uppercase of the generated key'};
    });
    wrong.asset.id='names-live-wrong';wrong.asset.data.files.push(...asset.data.files.filter(r=>r.path!==f.scriptRef.path&&!wrong.asset.data.files.some(x=>x.path===r.path)));
    wrong.asset.data.content_sha256=assetDigest(wrong.asset);const wrongRef=await f.store.put(wrong.asset);
    const negativeTaskRef=await f.store.put({...task,id:'live-negative-sample',data:{...task.data,input_sha256:sha256('independent negative calibration sample')}});
    const rejected=await f.service.assess(negativeTaskRef,wrongRef,'live-unsupported',call);
    const saved=await f.store.load(rejected.review_ref);
    await writeFile(join(evidence,'summary.json'),JSON.stringify({model:selected,good,rejected,
      scope:'UI-06 semantic smoke only; UI-10 repeated calibration remains required'},null,2));
    assert.equal(good.decision,'approved','reasonable grounded design must not be universally rejected');
    assert.notEqual(rejected.decision,'approved');
    assert.ok(saved.data.issues.some(i=>i.rule==='D2'&&i.blocking),'unsupported statement must be traced to original R1');
  }finally{
    await cp(join(f.root,'qa/ui'),join(evidence,'qa/ui'),{recursive:true});
    await cp(join(f.root,'requirements.md'),join(evidence,'requirements.md'));
    t.diagnostic(`UI-06 live evidence: ${evidence}`);
  }
});
