import { collectResults, saveAnalysis, draftReport } from '../../packages/ui-testing/dist/index.js';
import { ready } from './ui-run-fixture.mjs';
import { artifact } from './ui-artifacts.mjs';

export function finding(result){
  return { instance_id:result.data.instances[0].instance_id,classification:'product',certainty:'unknown',
    facts:['The A1 persistence assertion failed after Save and reload.'],hypotheses:[],supporting_refs:[result.data.raw_ref],
    alternatives:['The UI report alone does not establish an internal storage or server root cause.'],
    next_action:'Inspect the corresponding original trace and deployment/source mapping before deciding the root cause; any rerun uses a new batch.' };
}
export async function resultFixture(t){
  const d=await ready(t,{targetFault:true}),execution=await d.service.start(d.request);
  const result=await collectResults(d.f.root,execution.run_ref,'results-original');
  const make=async(id,change=()=>{},selected=result)=>{
    const analysis=artifact('analysis',{run_ref:execution.run_ref,results_ref:selected.results_ref,findings:[finding(selected)]},`analysis-${id}`);
    change(analysis);
    const saved=await saveAnalysis(d.f.root,analysis);
    const draft=await draftReport(d.f.root,selected.results_ref,saved.analysis_ref,`report-${id}`);
    return {analysis,analysisRef:saved.analysis_ref,...draft};
  };
  return {...d,execution,result,make,...await make('original')};
}
export function resultDecision(input,kind='approved'){
  const source=input.evidence.find(e=>e.ref.path.endsWith('/content.md'))??input.evidence[0];
  const checks=Array.from({length:6},(_,i)=>({rule:`R${i+1}`,verdict:'pass',
    reason:'Protocol fixture verifies the independent tool path; semantic quality is separately calibrated.',
    evidence:[{anchor_id:source.anchors[0].anchor_id}]}));
  const issues=[];
  if(kind!=='approved'){
    checks[3].verdict='fail';checks[3].reason='The evidence establishes a UI assertion failure but does not establish a database deadlock.';
    issues.push({id:'unsupported-root',rule:'R4',reason:checks[3].reason,evidence_refs:[{anchor_id:source.anchors[0].anchor_id}],
      fix_condition:'Retain the failure fact and leave the unsupported internal root cause unknown.',blocking:true});
  }
  return {decision:kind,checked_rules:checks.map(c=>c.rule),checks,issues,improvement:input.previous?'improved':'first'};
}
export const resultResponse=input=>({raw:JSON.stringify(resultDecision(input)),provider:'fixture',model:'protocol'});
