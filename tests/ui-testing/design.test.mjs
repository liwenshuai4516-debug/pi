import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArtifactStore, assetDigest, checkDesign, designEvidence, DesignReviewService, sha256 } from '../../packages/ui-testing/dist/index.js';
import { artifact, scope, cases, designReview } from '../support/ui-artifacts.mjs';
import { setupUiFixture, textContent, repoRoot } from '../support/ui-fixture.mjs';
import { PluginManager } from '../../dist/main/plugins/manager.js';
import { AgentHost } from '../../dist/main/agent/agent-host.js';

const validCode=`import {test,expect} from 'playwright/test';
test('C1 Name persists',async({page})=>{
 const key='qa-'+crypto.randomUUID();await page.goto('/');
 await page.getByRole('textbox',{name:'Name'}).fill(key);
 await page.getByRole('button',{name:'Save'}).click();await page.reload();
 await test.step('A1 Name persists after reload',async()=>{await expect(page.getByRole('listitem')).toHaveText([key]);});
});`;
async function setup(t) {
  const fixture=await setupUiFixture();t.after(()=>fixture.close());
  const root=fixture.project,store=new ArtifactStore(root),authority=join(fixture.agentDir,'private-reviews');
  const ref={path:'requirements.md',sha256:sha256('R1: Saved Name persists after reload.')};
  await writeFile(join(root,ref.path),'R1: Saved Name persists after reload.');
  const s=scope();s.data.sources[0].ref=ref;s.data.base_url=fixture.url;
  const scopeRef=await store.put(s);
  const inventory=artifact('inventory',{scope_ref:scopeRef,features:[{module_id:'names',feature_id:'save',name:'Names',
    entry:'/',role:'tester',actions:['Save Name','Reload'],scenarios:[{scenario_id:'valid-name',title:'Persistence'}],coverage:'discovered',
    source_refs:[ref],source_locations:[{ref,symbol:'R1',line:1}],discovery:'source',priority:'P0',states:['initial','saved','reloaded'],gaps:[]}],unexplored:[]});
  const inventoryRef=await store.put(inventory);
  const dataRules=await store.putFile('qa/ui/cases/cases-1/data-rules.json',JSON.stringify({name:'qa-${uuid}',isolation:'browser context',cleanup:'close owned context'}));
  const make=async(revision='v1',code=validCode,change=()=>{})=>{
    const c=cases();c.id=`cases-${revision}`;c.data.scope_ref=scopeRef;c.data.sources=s.data.sources;c.data.data_rules_ref=dataRules;
    c.data.cases[0].assertions[0].expected={from:'generated input key'};change(c);
    const casesRef=await store.put(c);
    const scriptRef=await store.putFile(`qa/ui/assets/names/revisions/${revision}/name.spec.ts`,code);
    const asset=artifact('asset',{revision,module_ids:['names'],scope_ref:scopeRef,inventory_ref:inventoryRef,cases_ref:casesRef,
      recording_refs:[],files:[scriptRef,dataRules],bindings:[{case_id:'C1',script_ref:scriptRef,test_title:'C1 Name persists',assertion_ids:['A1']}],
      dependencies:[{name:'playwright',version:'1.62.1'}],readiness:'design-only',content_sha256:'0'.repeat(64),gaps:[]},'names');
    asset.data.content_sha256=assetDigest(asset);const assetRef=await store.put(asset);
    return {asset,assetRef,scriptRef,cases:c,casesRef};
  };
  const candidate=await make();
  const task=artifact('task',{intent:'record',scope_ref:scopeRef,state:'running',stage:'design-review',completed_stages:['discover-record','case-design'],
    input_sha256:sha256('design names'),asset_refs:[],run_ids:[],output_refs:[],blockers:[]});
  const taskRef=await store.put(task);
  return {fixture,root,store,authority,service:new DesignReviewService(root,authority),make,taskRef,...candidate};
}
function decision(input,kind='approved',improvement=input.previous?'improved':'first') {
  const script=input.evidence.find(f=>f.ref.path.endsWith('.spec.ts'));
  const source=input.evidence.find(f=>f.ref.path==='requirements.md');
  const asset=input.evidence[0];
  const checks=Array.from({length:10},(_,i)=>{
    const evidence=i===1?source:i===6?asset:script;
    return {rule:`D${i+1}`,verdict:i===6?'not-applicable':'pass',reason:'Protocol fixture cites actual original source bytes; semantic quality is separately calibrated.',
      evidence:[{ref:evidence.ref,quote:evidence.content.slice(0,80)}]};
  });
  const issues=[];
  if(kind!=='approved'){
    checks[1].verdict='fail';issues.push({id:'I1',rule:'D2',case_id:'C1',assertion_id:'A1',reason:'Candidate expectation lacks the required independent source.',
      evidence_refs:[source.ref],fix_condition:'Bind the expected value to R1 and independent generated input.',blocking:true});
  }
  return {decision:kind,checked_rules:checks.map(c=>c.rule),checks,issues,improvement};
}
const response = input => ({raw:JSON.stringify(decision(input)),provider:'fixture',model:'protocol'});

test('UI-06: TypeScript and binding checks accept a complete source-grounded candidate',async t=>{
  const f=await setup(t),check=await checkDesign(f.root,f.assetRef);
  assert.deepEqual(check.issues,[]);assert.deepEqual(check.coverage.missing,[]);
  assert.ok(check.dependencies.some(d=>d.name==='playwright'&&d.version==='1.62.1'));
  const evidence=await designEvidence(f.root,f.assetRef);
  assert.ok(evidence.some(f=>f.ref.path==='requirements.md'));
  assert.ok(evidence.some(file=>file.ref.path===f.scriptRef.path));
  await assert.rejects(designEvidence(f.root,f.assetRef,1),/超过预算/);
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
});
