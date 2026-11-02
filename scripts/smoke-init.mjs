// POSIX CLI smoke: build first; fake agents never make inference requests.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join, delimiter} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {execFileSync} from 'node:child_process'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'
const directory=mkdtempSync(join(tmpdir(),'crosscheck-cli-smoke-'))
const bin=join(directory,'bin');mkdirSync(bin)
const script=`#!/usr/bin/env node
const agent=process.argv[1].split('/').at(-1), args=process.argv.slice(2);
if(agent==='gh'){console.log(args[0]==='api'?'fixture-user':args[0]==='auth'?'Logged in\\nToken scopes: admin:org_hook':'gh fixture');process.exit(0)}
if(agent==='smee'){console.log('fixture');process.exit(0)}
if(args[0]==='--version'){console.log(agent==='opencode'?'1.19.5':'fixture');process.exit(0)}
if(agent==='codex'){process.exit(1)}
if(agent==='claude'){console.log('{"loggedIn":false}');process.exit(1)}
if(args[0]==='run'){console.log('Options:\\n --auto\\n --format json\\n --attach\\n --port');process.exit(0)}
if(args[0]==='auth'){console.log('└ 0 credentials');process.exit(0)}
if(args[0]==='models'){for(const [id,price] of [['opencode/glm-5.3-flash-free',0],['opencode/kimi-k3-free',0],['private/paid-flash',1]])console.log(id+'\\n'+JSON.stringify({cost:{input:price,output:price},variants:{high:{}},headers:{Authorization:'fixture-secret'}},null,2));process.exit(0)}
if(args[0]==='debug'){console.log('{"model":"opencode/glm-5.3-flash-free","apiKey":"fixture-secret"}');process.exit(0)}
process.exit(1)
`
for(const name of ['codex','claude','opencode','gh','smee'])writeFileSync(join(bin,name),script,{mode:0o755})
const config=join(directory,'config.yml')
try{
 const stdout=execFileSync(process.execPath,[fileURLToPath(new URL('../dist/ck.js', import.meta.url)),'init','--config',config],{cwd:directory,encoding:'utf8',timeout:30000,env:{...process.env,PATH:bin+delimiter+process.env.PATH,CROSSCHECK_WEBHOOK_SECRET:'fixture-webhook-secret'}})
 const text=readFileSync(config,'utf8'), saved=yaml.load(text)
 assert.equal(saved.mode,'single-vendor')
 assert.equal(saved.vendors.opencode.enabled,true)
 assert.equal(saved.vendors.codex.enabled,false)
 assert.deepEqual(saved.quality.review_models.opencode.map(model=>model.id),['opencode/glm-5.3-flash-free'])
 assert.equal(saved.quality.refresh_free_models,true)
 assert.ok(!text.includes('fixture-secret'))
 assert.ok(stdout.includes('Review strategy: balanced'))
 console.log('Built ck init smoke passed: no-auth free model selected; flagship/paid routes excluded; no credentials persisted.')
}finally{rmSync(directory,{recursive:true,force:true})}
