// Opt-in live test: uses the authenticated Codex subscription, sends no GitHub comments.
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareReviewPlan, finishReview, savePublishedReview } from '../dist/lib/review-memory.js';
import { runCodexReview } from '../dist/reviewers/codex.js';
import { ConfigSchema } from '../dist/config/schema.js';
const root=mkdtempSync(join(tmpdir(), 'crosscheck-live-smoke-'));  const repo=join(root,'repo');mkdirSync(repo);
const git=(...args)=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:'pipe'}).trim();
git('init','-q');git('config','user.name','Crosscheck Test');git('config','user.email','test@example.test');
writeFileSync(join(repo,'sum.js'),'export const sum = values => values.reduce((a, b) => a + b, 0);\n');git('add','.');git('commit','-qm','Initial');git('update-ref','refs/remotes/origin/staging','HEAD');
writeFileSync(join(repo,'sum.js'),'export const sum = values => values.reduce((a, b) => a + b);\n');git('commit','-am','Change sum');
const config=ConfigSchema.parse({quality:{mode:'fixed',review_memory:true},vendors:{codex:{model:'gpt-6-astra',effort:'high'}}});
const makePlan=()=>prepareReviewPlan({repoDir:repo,repository:'smoke/sum#1',baseBranch:'staging',instructions:'Review the sum function. It must return 0 for an empty array. Inspect source; do not modify files.',policy:'smoke-v1',root:join(root,'memory')});
async function review(){const p=makePlan();const r=await runCodexReview(repo,'staging','Change sum',config.quality,config.vendors.codex,p.instructions,console.log,180000);const f=finishReview(p,r.review);console.log(JSON.stringify({mode:p.mode,model:r.model,findings:f.snapshot.report.findings,verdict:f.text.split('\n').at(-1)}));return {p,f};}
const first=await review();if(!first.f.snapshot.report.findings.some(f=>f.status==='open'))throw new Error('Seeded defect was missed');
// Simulated publication only in this isolated fixture; no GitHub comments are sent.
savePublishedReview(first.p,first.f.snapshot);
writeFileSync(join(repo,'sum.js'),'export const sum = values => values.reduce((a, b) => a + b, 0);\n');git('commit','-am','Restore empty input handling');
const second=await review();if(second.p.mode!=='incremental'||second.f.snapshot.report.findings.some(f=>f.status==='open'))throw new Error('Fix did not converge');
console.log('LIVE_SMOKE_PASSED',root);
