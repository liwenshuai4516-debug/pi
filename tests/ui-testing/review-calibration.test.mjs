import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { Agent } from '@earendil-works/pi-agent-core';
import { chromium, expect } from 'playwright/test';
import { ModelRuntime, convertToLlm } from '@earendil-works/pi-coding-agent';
import { assetDigest, sha256, ResultReviewService, checkDesign } from '../../packages/ui-testing/dist/index.js';
import { prepareDiagnostic, validCode } from '../support/ui-design-fixture.mjs';
import { resultFixture } from '../support/ui-result-fixture.mjs';
import { copyLiveModel, repoRoot, textContent } from '../support/ui-fixture.mjs';

const strictCode=validCode.replace("expect(page.getByRole('listitem')).toHaveText([key])",
  "expect.poll(()=>page.getByRole('listitem').allTextContents()).toEqual([key])");
const strictComparison='expect.poll(allTextContents).toEqual: exact original textContent array, without whitespace normalization';

test('UI-10: exact original text oracle rejects whitespace that toHaveText normalizes',async t=>{
  const browser=await chromium.launch();t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<ul><li> qa-ABC </li></ul>');
  await expect(page.getByRole('listitem')).toHaveText(['qa-ABC']);
  await assert.rejects(expect.poll(()=>page.getByRole('listitem').allTextContents(),{timeout:100}).toEqual(['qa-ABC']));
  await page.getByRole('listitem').evaluate(element=>element.textContent='qa-ABC');
  await expect.poll(()=>page.getByRole('listitem').allTextContents()).toEqual(['qa-ABC']);
  const design=await prepareDiagnostic(t,{testCode:strictCode,comparison:strictComparison});
  const candidate=await design.f.store.load(design.f.casesRef);
  assert.equal(candidate.data.cases[0].assertions[0].comparison,strictComparison);
  assert.deepEqual((await checkDesign(design.f.root,design.assetRef)).issues,[]);
});

test('UI-10: explicit existing model selection preserves source settings and isolates provider credentials',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ui-calibration-config-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),target=join(root,'target');await mkdir(source);await mkdir(target);
  const files={
    'settings.json':{defaultProvider:'first',defaultModel:'removed-model'},
    'models.json':{providers:{first:{models:[{id:'first-model'}]},second:{models:[{id:'second-model'}]}}},
    'auth.json':{first:{type:'api_key',key:'synthetic-first'},second:{type:'api_key',key:'synthetic-second'}},
  };
  for(const [name,value] of Object.entries(files))await writeFile(join(source,name),JSON.stringify(value));
  await assert.rejects(copyLiveModel(target,source),/选定模型不在现有自定义配置/);
  const selected=await copyLiveModel(target,source,{provider:'second',modelId:'second-model'});
  assert.deepEqual(selected,{provider:'second',modelId:'second-model'});
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(target,'auth.json'),'utf8'))),['second']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(target,'models.json'),'utf8')).providers),['second']);
  for(const [name,value] of Object.entries(files))assert.deepEqual(JSON.parse(await readFile(join(source,name),'utf8')),value);
});

test('UI-10 live: independent repeated design/result calibration preserves all errors and heldout outcomes', {
  skip:process.env.PI_UI_CALIBRATION_LIVE!=='1',timeout:2700000,
},async t=>{
  const manifestBytes=await readFile(new URL('../support/ui-review-calibration.json',import.meta.url));
  const manifest=JSON.parse(manifestBytes),evidence=join(repoRoot,'evidence/ui-testing/ui-10',String(Date.now()));
  await mkdir(evidence,{recursive:true});
  // 样本及期望先冻结；本次运行不根据模型反馈修改规则或样本。
  await writeFile(join(evidence,'frozen-samples.json'),manifestBytes);
  const design=await prepareDiagnostic(t,{testCode:strictCode,comparison:strictComparison}),result=await resultFixture(t),f=design.f;
  const selection=process.env.PI_UI_PROVIDER||process.env.PI_UI_MODEL?
    {provider:process.env.PI_UI_PROVIDER,modelId:process.env.PI_UI_MODEL}:undefined;
  const selected=await copyLiveModel(f.fixture.agentDir,process.env.PI_UI_MODEL_DIR??join(homedir(),'.pi/agent'),selection);
  const runtime=await ModelRuntime.create({authPath:join(f.fixture.agentDir,'auth.json'),modelsPath:join(f.fixture.agentDir,'models.json')});
  const model=(await runtime.getAvailable()).find(m=>m.provider===selected.provider&&m.id===selected.modelId);assert.ok(model);
  const summary={schema_version:'1.0',model:selected,manifest_sha256:sha256(manifestBytes),
    fixture_revision:manifest.fixture_revision,
    label_origin:manifest.label_origin,human_review:manifest.human_review,started_at:new Date().toISOString(),outcomes:[],
    limitations:['The human confirmed the seven expected labels; no human timing baseline or line-by-line artifact audit is claimed.',
      'Fixture assets were authored by test support; this is reviewer calibration, not autonomous case generation or full M3 acceptance.']};
  let current,consecutiveProviderErrors=0;
  const call=async input=>{
    const {system_prompt:systemPrompt,...facts}=input;
    const agent=new Agent({initialState:{model,tools:[],messages:[],thinkingLevel:'off',systemPrompt},convertToLlm,
      streamFn:(m,context,options)=>runtime.streamSimple(m,context,options)});
    await writeFile(join(evidence,`${current}-input.json`),JSON.stringify(input,null,2));
    const timer=setTimeout(()=>agent.abort(),120000),started=Date.now();
    try{
      await agent.prompt(JSON.stringify(facts));
      const message=[...agent.state.messages].reverse().find(m=>m.role==='assistant');
      const response={raw:textContent(message?.content),provider:model.provider,model:model.id,stop_reason:message?.stopReason??'error'};
      const errorText=message?.errorMessage??'';
      // 仅输出已知错误类别及状态码，不将供应商原始错误中的配置或凭据写入证据。
      const error_category=response.stop_reason!=='error'?null:
        /balance|insufficient|quota|credit|余额|额度/i.test(errorText)?'quota-or-balance':
        /429|rate.limit|too many/i.test(errorText)?'rate-limit':
        /401|403|unauthori|api.key|authentication/i.test(errorText)?'authentication':
        /timeout|abort/i.test(errorText)?'timeout-or-abort':
        /50[0-9]|overload|unavailable/i.test(errorText)?'provider-unavailable':'unclassified-provider-error';
      consecutiveProviderErrors=response.stop_reason==='error'?consecutiveProviderErrors+1:0;
      await writeFile(join(evidence,`${current}-response.json`),JSON.stringify({elapsed_ms:Date.now()-started,
        ...response,error_category,error_status:errorText.match(/\b[45]\d\d\b/)?.[0]??null},null,2));
      return response;
    }finally{clearTimeout(timer);}
  };
  const samples=new Map([['design-grounded',design.assetRef],['result-unknown',result.report_ref]]);
  for(const [id,method] of [['design-uppercase','toUpperCase'],['design-lowercase','toLowerCase'],['design-whitespace-tolerant',null]]){
    const wrong=await f.make(id,method?strictCode.replace('toEqual([key])',`toEqual([key.${method}()])`):validCode,c=>{
      if(method){
        c.data.sources[0].statement=`R1 requires Save to ${method==='toUpperCase'?'uppercase':'lowercase'} every Name.`;
        c.data.cases[0].assertions[0].expected={from:`${method} of the generated key`};
      }else c.data.cases[0].assertions[0].comparison='toHaveText';
    });
    wrong.asset.id=`names-${id}`;
    wrong.asset.data.files.push(...design.asset.data.files.filter(r=>r.path!==f.scriptRef.path&&!wrong.asset.data.files.some(x=>x.path===r.path)));
    wrong.asset.data.content_sha256=assetDigest(wrong.asset);samples.set(id,await f.store.put(wrong.asset));
  }
  for(const [id,cause] of [['result-deadlock','a database deadlock'],['result-cache-cause','a Redis cache invalidation defect']]){
    const wrong=await result.make(id,a=>{a.data.findings[0].certainty='confirmed';a.data.findings[0].hypotheses=[`The confirmed root cause is ${cause}.`];});
    samples.set(id,wrong.report_ref);
  }
  try{
    rounds:for(const sample of manifest.samples)for(let repetition=1;repetition<=manifest.repetitions;repetition++){
      current=`${sample.id}-${repetition}`;const started=Date.now();
      const outcome={sample_id:sample.id,partition:sample.partition,repetition,expected:sample.expected};
      try{
        let assessed,saved;
        if(sample.reviewer==='design'){
          const original=await f.store.load(f.taskRef);
          const taskRef=await f.store.put({...original,id:current,data:{...original.data,input_sha256:sha256(current)}});
          assessed=await f.service.assess(taskRef,samples.get(sample.id),current,call);
          saved=await f.store.load(assessed.review_ref);
        }else{
          // 每个显式校准任务有独立预算和上下文，不把同一修订循环伪装成多次独立样本。
          const service=new ResultReviewService(result.f.root,join(result.f.authority,current));
          assessed=await service.assess(samples.get(sample.id),current,call);saved=await result.f.store.load(assessed.review_ref);
        }
        Object.assign(outcome,{decision:assessed.decision,review_ref:assessed.review_ref,issues:saved.data.issues});
        outcome.matches_expectation=sample.expected==='approved'?assessed.decision==='approved':
          assessed.decision!=='approved'&&saved.data.issues.some(i=>i.rule===sample.blocking_rule&&i.blocking);
      }catch(error){outcome.error=String(error.message);outcome.artifact_refs=error.artifact_refs??[];outcome.matches_expectation=false;}
      outcome.elapsed_ms=Date.now()-started;summary.outcomes.push(outcome);
      await writeFile(join(evidence,'summary.json'),JSON.stringify(summary,null,2));
      t.diagnostic(`${current}: ${outcome.decision??'error'}; expected=${sample.expected}; matched=${outcome.matches_expectation}`);
      if(consecutiveProviderErrors>=3){summary.stopped_reason='Three consecutive provider errors; remaining samples not attempted, not rejected.';break rounds;}
    }
  }finally{
    summary.finished_at=new Date().toISOString();
    const positives=summary.outcomes.filter(o=>o.expected==='approved'&&o.decision),negatives=summary.outcomes.filter(o=>o.expected==='rejected'&&o.decision);
    summary.metrics={planned:manifest.samples.length*manifest.repetitions,total:summary.outcomes.length,
      not_attempted:manifest.samples.length*manifest.repetitions-summary.outcomes.length,matched:summary.outcomes.filter(o=>o.matches_expectation).length,
      valid_positive_decisions:positives.length,valid_negative_decisions:negatives.length,
      false_rejections:positives.filter(o=>o.decision!=='approved').length,
      critical_misses:negatives.filter(o=>o.decision==='approved').length,
      false_rejection_rate:positives.length?positives.filter(o=>o.decision!=='approved').length/positives.length:null,
      critical_miss_rate:negatives.length?negatives.filter(o=>o.decision==='approved').length/negatives.length:null,
      errors:summary.outcomes.filter(o=>o.error).length};
    await writeFile(join(evidence,'summary.json'),JSON.stringify(summary,null,2));
    for(const [name,fixture] of [['design',f],['result',result.f]]){
      await cp(join(fixture.root,'qa/ui'),join(evidence,name,'qa/ui'),{recursive:true});
      await cp(join(fixture.root,'requirements.md'),join(evidence,name,'requirements.md'));
    }
    t.diagnostic(`UI-10 calibration evidence: ${evidence}`);
  }
  assert.equal(summary.outcomes.length,manifest.samples.length*manifest.repetitions,summary.stopped_reason??'All planned calibration rounds must run');
  assert.deepEqual(summary.outcomes.filter(o=>!o.matches_expectation),[],'retain and investigate mismatches; never silently retry to green');
});
