import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, copyFile, writeFile, readFile, mkdir, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { argumentsFor } from '../scripts/run.mjs';

const execute = promisify(execFile);
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const write = (file, data) => writeFile(file, JSON.stringify(data));

// These tests run the actual CLI/importer/persistence in isolated subprocesses.
// Only the native bridge and photo UI workflow are replaced; no Photos events,
// private user images, helper process, or actual library are accessible.
async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'macgyver-resume-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = path.join(directory, 'scripts'), input = path.join(directory, 'InputImages');
  await mkdir(scripts); await mkdir(input);
  for (const filename of await readdir(new URL('../scripts/', import.meta.url))) {
    if (filename.endsWith('.mjs')) await copyFile(new URL(`../scripts/${filename}`, import.meta.url), path.join(scripts, filename));
  }
  await copyFile(new URL('../scripts/bridge.mjs', import.meta.url), path.join(scripts, 'storage.mjs'));
  await copyFile(new URL('../config.example.json', import.meta.url), path.join(directory, 'config.example.json'));
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg']) await writeFile(path.join(input, name), `synthetic bytes ${name}`);
  await writeFile(path.join(scripts, 'bridge.mjs'), `
import { existsSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export { atomicJSON, readJSON, privateDirectory } from './storage.mjs';
import { atomicJSON, readJSON } from './storage.mjs';
export const root=fileURLToPath(new URL('../',import.meta.url));
export const ipcRoot=path.join(root,'fake-ipc');
export const appPath=path.join(root,'fake-app');
export const bridgeIsRunning=async()=>false;
export const sleep=async()=>{};
const libraryPath=path.join(root,'library.json');
export const record=async data=>appendFile(path.join(root,'calls.jsonl'),JSON.stringify(data)+'\\n');
export async function startBridge(){
 await record({action:'startBridge'});
 return {accessibility:true,postEvents:true,screenCapture:true,photos:'authorized',capabilities:['input-images-batch-v1']};
}
export function createBridge({onRequest}={}){return {async call(action,args={}){
 const request={id:randomUUID(),action,args};await onRequest?.(request);await record({action,args});
 if(action==='activate')return {};
 if(action==='snapshot')return {nodes:[],frontmost:true,appPid:123,truncated:false,window:{title:'Photos',rect:{x:0,y:0,width:1000,height:800}}};
 const library=existsSync(libraryPath)?await readJSON(libraryPath):{albums:[],edited:[]};
 if(action==='importImages'){
   const album={id:'album-'+(library.albums.length+1),name:args.albumName};
   const imports=args.files.map((source,index)=>({item:{id:album.id+'-asset-'+index,filename:source.filename,width:1440,height:1800},sourceSHA256:source.sha256}));
   library.albums.push({...album,items:imports.map(entry=>entry.item)});await atomicJSON(libraryPath,library);
   if(existsSync(path.join(root,'uncertain-import')))throw new Error('simulated response lost after import');
   if(existsSync(path.join(root,'stop-during-import')))await atomicJSON(path.join(root,'artifacts/STOP'),{});
   return {album,imports};
 }
 if(action==='albumItems'){
  const album=library.albums.find(album=>album.id===args.id);if(!album)throw new Error('missing test album');
  return {id:album.id,items:[...album.items].reverse()};
 }
 throw new Error('unexpected native action '+action);
}};}
`);
  await writeFile(path.join(scripts, 'workflow.mjs'), `
import { existsSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { root, record, atomicJSON, readJSON } from './bridge.mjs';
export class PhotoWorkflow {
 constructor(options){Object.assign(this,options);}
 checkStop(){if(this.stopped())throw new Error('stopped test workflow');}
 async process(item){
  await record({action:'process',item});
  const failure=path.join(root,'fail-filename');
  if(existsSync(failure)&&(await readFile(failure,'utf8'))===item.filename){
   await atomicJSON(this.pendingPath,{runDir:this.runDir,item,phase:'editing'});
   throw new Error('simulated photo failure');
  }
  const library=await readJSON(path.join(root,'library.json'));library.edited.push(item.id);await atomicJSON(path.join(root,'library.json'),library);
  const result={item,status:'complete',keptEdits:true,phase:'retained'};
  await atomicJSON(this.pendingPath,{runDir:this.runDir,item,phase:'retained'});
  await this.onComplete(result);
  const saved=await readJSON(path.join(this.runDir,'manifest.json'));
  if(saved.photos[item.id]?.status!=='complete')throw new Error('manifest not durable before pending deletion');
  await unlink(this.pendingPath);
  return result;
 }
 async recover(pending){
  await record({action:'recover',item:pending.item});
  const result={item:pending.item,status:'recovered-without-result',phase:'restored'};
  await this.onComplete(result);
  const saved=await readJSON(path.join(this.runDir,'manifest.json'));
  if(saved.photos[pending.item.id]?.status!=='recovered-without-result')throw new Error('recovery manifest not durable before pending deletion');
  await unlink(this.pendingPath);
  return result;
 }
}
`);
  async function invoke(...args) {
    return execute(process.execPath, ['--experimental-permission', `--allow-fs-read=${directory}`, `--allow-fs-write=${directory}`, path.join(scripts, 'run.mjs'), ...args], {
      cwd: directory, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
  }
  async function calls() { return (await readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  async function state() {
    const pointer = await read(path.join(directory, 'artifacts/input-batch.json'));
    return { pointer, manifest: await read(path.join(pointer.runDir, 'manifest.json')), plan: await read(path.join(pointer.runDir, 'plan.json')), journal: await read(path.join(pointer.runDir, 'import.json')) };
  }
  return { directory, input, invoke, calls, state };
}

test('CLI option parsing supports resume and explicit new runs while rejecting ambiguous combinations', () => {
  assert.deepEqual(argumentsFor(['run', '--limit', '1', '--new-run']), { action: 'run', limit: 1, 'new-run': true });
  assert.deepEqual(argumentsFor(['resume', '--limit', '2']), { action: 'resume', limit: 2 });
  for (const args of [ ['resume', '--new-run'], ['resume', '--album-id', 'album'], ['run', '--limit'], ['run', '--limit', '0'], ['plan', '--limit', '1'], ['run', '--new-run', '--new-run'], ['run', '--new-run', '--album-id', 'album'] ]) {
    assert.throws(() => argumentsFor(args), Error, JSON.stringify(args));
  }
});

test('one-photo run bulk imports all images; subsequent runs advance exact IDs without reimporting; complete is a no-op', async t => {
  const f = await fixture(t);
  await f.invoke('run', '--limit', '1');
  const first = await f.state(), initialCalls = await f.calls();
  assert.equal(first.plan.items.length, 3);
  assert.equal(first.journal.imported.length, 3);
  assert.equal(first.manifest.status, 'paused-after-limit');
  assert.equal(Object.keys(first.manifest.photos).length, 1);
  assert.equal(initialCalls.filter(call => call.action === 'importImages').length, 1);
  assert.equal(initialCalls.find(call => call.action === 'importImages').args.files.length, 3);
  assert.deepEqual(initialCalls.filter(call => call.action === 'process').map(call => call.item.filename), ['a.jpg']);
  await f.invoke('resume', '--limit', '1');
  assert.equal((await f.state()).pointer.runDir, first.pointer.runDir);
  await f.invoke('run');
  assert.equal((await f.state()).manifest.status, 'complete');
  assert.deepEqual((await f.calls()).filter(call => call.action === 'process').map(call => call.item.filename), ['a.jpg', 'b.jpg', 'c.jpg']);
  const completed = await f.invoke('run');
  assert.match(completed.stdout, /이미 모든 사진을 처리했습니다/);
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
  assert.equal((await f.calls()).filter(call => call.action === 'process').length, 3);
  const library = await read(path.join(f.directory, 'library.json'));
  assert.equal(library.albums.length, 1);
  assert.deepEqual(library.edited, first.plan.items.map(item => item.id));
  await f.invoke('run', '--new-run', '--limit', '1');
  assert.notEqual((await f.state()).pointer.runDir, first.pointer.runDir);
  assert.equal((await read(path.join(f.directory, 'library.json'))).albums.length, 2);
  assert.equal((await read(path.join(first.pointer.runDir, 'manifest.json'))).status, 'complete');
});

test('changed input bytes or added files block resume without importing copies', async t => {
  const f = await fixture(t);
  await f.invoke('run', '--limit', '1');
  const original = await readFile(path.join(f.input, 'b.jpg'));
  await writeFile(path.join(f.input, 'b.jpg'), 'different source');
  await assert.rejects(() => f.invoke('run'), error => /원본 바이트.*달라졌습니다/.test(error.stderr));
  await writeFile(path.join(f.input, 'b.jpg'), original);
  await writeFile(path.join(f.input, 'd.jpg'), 'new image');
  await assert.rejects(() => f.invoke('resume'), error => /--new-run/.test(error.stderr));
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
  assert.equal((await f.calls()).filter(call => call.action === 'process').length, 1);
  await f.invoke('run', '--new-run', '--limit', '1');
  assert.equal((await f.state()).plan.items.length, 4);
});

test('pending failure requires recovery; recovered-without-result is retried while completed earlier photos are skipped', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'fail-filename'), 'b.jpg');
  await assert.rejects(() => f.invoke('run'), error => /simulated photo failure/.test(error.stderr));
  const failed = await f.state();
  assert.equal(failed.manifest.status, 'failed');
  assert.equal(Object.keys(failed.manifest.photos).length, 1);
  const before = (await f.calls()).length;
  await assert.rejects(() => f.invoke('run'), error => /먼저 npm run recover/.test(error.stderr));
  assert.equal((await f.calls()).length, before, 'pending guard precedes even helper startup');
  await f.invoke('recover');
  await rm(path.join(f.directory, 'fail-filename'));
  await f.invoke('resume');
  assert.equal((await f.state()).manifest.status, 'complete');
  assert.deepEqual((await f.calls()).filter(call => call.action === 'process').map(call => call.item.filename), ['a.jpg', 'b.jpg', 'b.jpg', 'c.jpg']);
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
});

test('a lost native import response preserves uncertainty and never resends on ordinary run', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'uncertain-import'), '1');
  await assert.rejects(() => f.invoke('run'), error => /simulated response lost/.test(error.stderr));
  await rm(path.join(f.directory, 'uncertain-import'));
  await assert.rejects(() => f.invoke('run'), error => /자동으로 다시 가져오지 않습니다/.test(error.stderr));
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
  assert.equal((await f.calls()).filter(call => call.action === 'process').length, 0);
  assert.equal((await read(path.join(f.directory, 'library.json'))).albums.length, 1);
});

test('a stop during the bulk transaction preserves all receipts and resumes without another import', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'stop-during-import'), '1');
  await assert.rejects(() => f.invoke('run'), error => /전체 가져오기를 마친 뒤 중지/.test(error.stderr));
  const state = await f.state();
  assert.equal(state.manifest.status, 'stopped');
  assert.equal(state.journal.imported.length, 3);
  assert.equal(state.plan.items.length, 3);
  await rm(path.join(f.directory, 'stop-during-import'));
  await f.invoke('resume');
  assert.equal((await f.state()).manifest.status, 'complete');
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
});

test('changed album membership is rejected before editing another photo', async t => {
  const f = await fixture(t);
  await f.invoke('run', '--limit', '1');
  const libraryPath = path.join(f.directory, 'library.json'), library = await read(libraryPath);
  library.albums[0].items.push({ id: 'foreign-asset', filename: 'foreign.jpg', width: 1, height: 1 });
  await write(libraryPath, library);
  await assert.rejects(() => f.invoke('resume'), error => /작업 앨범을 확인하지 못했습니다/.test(error.stderr));
  assert.equal((await f.calls()).filter(call => call.action === 'process').length, 1);
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 1);
});

test('resume with no recorded batch refuses to import', async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.invoke('resume'), error => /작업 기록이 없습니다/.test(error.stderr));
  assert.equal((await f.calls()).filter(call => call.action === 'importImages').length, 0);
});
