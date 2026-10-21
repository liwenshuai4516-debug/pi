import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdir, cp, writeFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Agent } from '@earendil-works/pi-agent-core';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import { ResultReviewService, collectResults, saveAnalysis } from '../../packages/ui-testing/dist/index.js';
import { resultFixture, resultDecision, resultResponse } from '../support/ui-result-fixture.mjs';
import { copyLiveModel, repoRoot, textContent } from '../support/ui-fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';

test('UI-08: real failure with unknown root is reviewable; rejection/correction preserve history and trusted delivery',{timeout:60000},async t=>{
  const d=await resultFixture(t),{f,report_ref,make,execution}=d,reviewer=new ResultReviewService(f.root,f.authority);
  await assert.rejects(reviewer.deliver(report_ref),/独立结果评估/);
  const accepted=await reviewer.assess(report_ref,'original-review',resultResponse);
  assert.equal(accepted.decision,'approved');await reviewer.gate(report_ref,accepted.review_ref);
  await new ResultReviewService(f.root,f.authority).gate(report_ref,accepted.review_ref);
  assert.deepEqual(await reviewer.assess(report_ref,'original-review',()=>{throw new Error('must not call model again');}),accepted);
  const saved=await f.store.load(accepted.review_ref);
  const forged=structuredClone(saved);forged.id='forged-result-review';const forgedRef=await f.store.put(forged);
  await assert.rejects(reviewer.gate(report_ref,forgedRef),/独立评估路径/);
  const delivery=await reviewer.deliver(report_ref,accepted.review_ref);
  const content=await readFile(join(f.root,delivery.delivery_ref.path),'utf8');assert.match(content,/unknown/);assert.match(content,/\| failed \| 1 \|/);
  for(const link of content.matchAll(/\]\(([^)]+)\)/g))await readFile(resolve(f.root,dirname(delivery.delivery_ref.path),link[1]));
  const report=await f.store.load(report_ref),follow=JSON.parse(await readFile(join(f.root,report.data.follow_up_ref.path),'utf8'));
  assert.equal(follow[0].defect_draft.status,'draft-not-submitted');assert.equal(follow[0].action_performed,false);
  const wrong=await make('unsupported',a=>{a.data.findings[0].certainty='confirmed';a.data.findings[0].hypotheses=['A database deadlock is the confirmed root cause.'];});
  const rejected=await reviewer.assess(wrong.report_ref,'reject-root',input=>({raw:JSON.stringify(resultDecision(input,'revise')),provider:'fixture',model:'protocol'}));
  assert.equal(rejected.decision,'revise');await assert.rejects(reviewer.gate(wrong.report_ref,rejected.review_ref),/完整批准/);
  const corrected=await make('corrected');const approved=await reviewer.assess(corrected.report_ref,'corrected-root',resultResponse);
  assert.equal(approved.round,3);assert.equal(approved.decision,'approved');
  assert.deepEqual((await f.store.load(approved.review_ref)).data.previous_review_ref,rejected.review_ref);
  const trace=execution.run.data.output_refs.find(r=>r.path.endsWith('trace.zip'));await rm(join(f.root,trace.path));
  await assert.rejects(reviewer.gate(corrected.report_ref,approved.review_ref),/统计或证据状态|引用不存在或不可读取.*trace\.zip/);
  const partialResult=await collectResults(f.root,execution.run_ref,'missing-trace-results');
  const partial=await make('partial',()=>{},partialResult);assert.equal(partial.completeness,'partial');
  const phase=await reviewer.deliver(partial.report_ref);assert.equal(phase.independently_approved,false);
  assert.match(await readFile(join(f.root,phase.delivery_ref.path),'utf8'),/完整性未通过/);
  const partialReviewer=new ResultReviewService(f.root,join(f.authority,'partial-review'));
  const partialDecision=await partialReviewer.assess(partial.report_ref,'partial-must-not-approve',resultResponse);
  assert.notEqual(partialDecision.decision,'approved');
  await assert.rejects(partialReviewer.gate(partial.report_ref,partialDecision.review_ref),/完整批准/);
});

test('UI-08: malformed evidence consumes budget, no improvement blocks, and a foreign screenshot cannot support analysis',{timeout:60000},async t=>{
  const {f,report_ref,result,analysis}=await resultFixture(t);
  const malformed=new ResultReviewService(f.root,join(f.authority,'malformed'));
  let refs;
  await assert.rejects(malformed.assess(report_ref,'bad-citation',async input=>{
    const d=resultDecision(input);d.checks[0].evidence=[{anchor_id:'E99999L99999'}];return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};
  }),e=>{refs=e.artifact_refs;assert.equal(refs.length,3);return /不存在的片段/.test(e.message);});
  await assert.rejects(malformed.assess(report_ref,'bad-citation',()=>{throw new Error('must not replay');}),e=>{assert.deepEqual(e.artifact_refs,refs);return true;});
  for(const request of ['bad-json-2','bad-json-3'])await assert.rejects(malformed.assess(report_ref,request,async()=>({raw:'invalid-json',provider:'fixture',model:'protocol'})),/有效 JSON/);
  await assert.rejects(malformed.assess(report_ref,'over-budget',resultResponse),/预算已耗尽/);
  const loop=new ResultReviewService(f.root,join(f.authority,'no-improvement'));
  const reject=async input=>{const d=resultDecision(input,'revise');if(input.previous)d.improvement='none';return {raw:JSON.stringify(d),provider:'fixture',model:'protocol'};};
  assert.equal((await loop.assess(report_ref,'one',reject)).decision,'revise');
  assert.equal((await loop.assess(report_ref,'two',reject)).decision,'blocked');
  await assert.rejects(loop.assess(report_ref,'three',reject),/上一轮已阻塞/);
  const foreign=await f.store.putFile('qa/ui/runs/other-batch/output/screenshot.png','synthetic foreign evidence, used only to verify rejection');
  const mixed=structuredClone(analysis);mixed.id='foreign-analysis';mixed.data.findings[0].supporting_refs=[foreign];
  await assert.rejects(saveAnalysis(f.root,mixed),/不能引用其他批次/);
  assert.equal(result.data.counts.failed,1);
  const original=await f.store.load(report_ref),forged=structuredClone(original);
  forged.id='forged-pass-report';forged.data.content_ref=await f.store.putFile(`${dirname(original.data.content_ref.path)}/forged-pass.md`,'All tests passed. No failures.');
  const forgedRef=await f.store.put(forged);
  const tamperReview=new ResultReviewService(f.root,join(f.authority,'tampered-report'));
  const tampered=await tamperReview.assess(forgedRef,'must-not-approve',resultResponse);
  assert.notEqual(tampered.decision,'approved');
  await assert.rejects(tamperReview.deliver(forgedRef,tampered.review_ref),/正文或元数据/);
});

test('UI-08: real Pi analysis Skill and isolated reviewer save a truthful failed report without replaying browsers',{timeout:60000},async t=>{
  const d=await resultFixture(t),{f,execution}=d;
  await new PluginManager(f.fixture.agentDir,f.root).install(join(repoRoot,'packages/ui-testing'),'package');
  const host=new AgentHost(()=>{},()=>{},f.fixture.agentDir);t.after(()=>host.dispose());const view=await host.create(f.root,true);
  assert.ok(view.skills.some(s=>s.name==='ui-result-analysis'));assert.ok(view.skills.some(s=>s.name==='ui-result-review'));
  let calls=0,parsed,analysisRef,reportRef,reviewRef,delivered,independentCalls=0;
  const before=f.fixture.state.browserRequests;
  f.fixture.state.respond=body=>{
    if(body.messages.some(m=>m.role==='system'&&JSON.stringify(m.content).includes('你是独立 UI 测试结果评估者'))){
      independentCalls++;assert.equal(body.tools?.length??0,0);assert.equal(body.messages.filter(m=>m.role==='user').length,1);
      const user=body.messages.find(m=>m.role==='user'),input=JSON.parse(typeof user.content==='string'?user.content:textContent(user.content));
      assert.equal(JSON.stringify(input).includes('ANALYST_PRIVATE_MARKER'),false);return {text:JSON.stringify(resultDecision(input))};
    }
    if(calls++===0)return {tool:'ui_result_analysis',args:{request:{operation:'parse',run_ref:execution.run_ref,result_id:'actual-result'}}};
    const previous=JSON.parse(textContent(body.messages.filter(m=>m.role==='tool').at(-1).content));
    if(calls===2){parsed=previous.output;const analysis=structuredClone(d.analysis);analysis.id='actual-analysis';analysis.data.results_ref=parsed.results_ref;
      return {tool:'ui_result_analysis',args:{request:{operation:'save-analysis',analysis}}};}
    if(calls===3){analysisRef=previous.output.analysis_ref;return {tool:'ui_result_analysis',args:{request:{operation:'draft-report',results_ref:parsed.results_ref,analysis_ref:analysisRef,report_id:'actual-report'}}};}
    if(calls===4){reportRef=previous.output.report_ref;return {tool:'ui_result_review',args:{request:{operation:'review',report_ref:reportRef,request_id:'actual-review'}}};}
    if(calls===5){reviewRef=previous.output.review_ref;return {tool:'ui_result_review',args:{request:{operation:'deliver',report_ref:reportRef,review_ref:reviewRef}}};}
    delivered=previous;return {text:'The report retains the real failed result and unknown root cause.'};
  };
  await host.send(view.id,'/skill:ui-result-analysis ANALYST_PRIVATE_MARKER Analyze this existing failed run, independently review and deliver the truthful report.',[],[]);
  if(f.fixture.state.responseError)throw f.fixture.state.responseError;
  assert.equal(delivered.status,'completed');assert.equal(delivered.output.independently_approved,true);assert.equal(independentCalls,1);
  assert.equal(f.fixture.state.browserRequests,before);assert.equal(parsed.data.counts.failed,1);
});

test('UI-08 live: reviewer accepts an honest failure with unknown root and rejects unsupported database certainty',{
  skip:process.env.PI_UI_RESULT_LIVE!=='1',timeout:300000,
},async t=>{
  const d=await resultFixture(t),{f,report_ref,make}=d;
  const selected=await copyLiveModel(f.fixture.agentDir,process.env.PI_UI_MODEL_DIR??join(homedir(),'.pi/agent'));
  const runtime=await ModelRuntime.create({authPath:join(f.fixture.agentDir,'auth.json'),modelsPath:join(f.fixture.agentDir,'models.json')});
  const model=(await runtime.getAvailable()).find(m=>m.provider===selected.provider&&m.id===selected.modelId);assert.ok(model);
  const call=async input=>{
    const {system_prompt:systemPrompt,...facts}=input;
    const agent=new Agent({initialState:{model,tools:[],messages:[],thinkingLevel:'off',systemPrompt},convertToLlm,
      streamFn:(m,context,options)=>runtime.streamSimple(m,context,options)});
    const timer=setTimeout(()=>agent.abort(),120000);
    try{await agent.prompt(JSON.stringify(facts));}finally{clearTimeout(timer);}
    const message=[...agent.state.messages].reverse().find(m=>m.role==='assistant');
    return {raw:textContent(message?.content),provider:model.provider,model:model.id,stop_reason:message?.stopReason??'error'};
  };
  const service=new ResultReviewService(f.root,f.authority),evidence=join(repoRoot,'evidence/ui-testing/ui-08',String(Date.now()));
  await mkdir(evidence,{recursive:true});
  try{
    const good=await service.assess(report_ref,'live-honest',call);
    const wrong=await make('live-overclaim',a=>{a.data.findings[0].certainty='confirmed';a.data.findings[0].hypotheses=['The root cause is a confirmed database deadlock.'];});
    const bad=await service.assess(wrong.report_ref,'live-overclaim',call);
    const saved=await f.store.load(bad.review_ref);
    await writeFile(join(evidence,'summary.json'),JSON.stringify({model:selected,good,bad,scope:'UI-08 smoke; UI-10 repeated calibration remains required'},null,2));
    assert.equal(good.decision,'approved');assert.notEqual(bad.decision,'approved');assert.ok(saved.data.issues.some(i=>i.rule==='R4'&&i.blocking));
  }finally{
    await cp(join(f.root,'qa/ui'),join(evidence,'qa/ui'),{recursive:true});await cp(join(f.root,'requirements.md'),join(evidence,'requirements.md'));
    t.diagnostic(`UI-08 live evidence: ${evidence}`);
  }
});
