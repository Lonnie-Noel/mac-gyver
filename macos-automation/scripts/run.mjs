import { existsSync } from 'node:fs';
import { unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, startBridge, root, ipcRoot, atomicJSON, readJSON, privateDirectory } from './bridge.mjs';
import { readUI, rotateItems, validateConfig } from './core.mjs';
import { PhotoWorkflow } from './workflow.mjs';
import { requireNodeVersion } from './runtime.mjs';
const artifacts=path.join(root,'artifacts'), pendingPath=path.join(artifacts,'pending-edit.json'), stopPath=path.join(artifacts,'STOP'), activePath=path.join(artifacts,'active-run.json'), leasePath=path.join(ipcRoot,'workflow-lock.json');
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export function argumentsFor(argv) {
  const action=argv[0]??'run';if(!['setup','check','inspect','albums','plan','run','stop','recover'].includes(action))throw new Error('명령: setup|check|inspect|albums|plan|run|stop|recover');
  const options={action};for(let i=1;i<argv.length;i+=2){const key=argv[i],value=argv[i+1];if(!value||!['--limit','--album-id','--config'].includes(key))throw new Error('알 수 없거나 값이 없는 옵션');options[key.slice(2)]=value;}
  if(options.limit!==undefined){options.limit=Number(options.limit);if(!Number.isSafeInteger(options.limit)||options.limit<1||action!=='run')throw new Error('--limit은 run에서 양의 정수로 지정하세요.');}return options;
}
async function configuration(options){const file=options.config?path.resolve(options.config):path.join(root,existsSync(path.join(root,'config.json'))?'config.json':'config.example.json');const config=validateConfig(await readJSON(file));if(options['album-id'])config.albumId=options['album-id'];return config;}
function requirePermissions(s){const missing=[];if(!s.accessibility||!s.postEvents)missing.push('손쉬운 사용');if(!s.screenCapture)missing.push('화면 기록');if(s.photos!=='authorized')missing.push('사진 전체 접근');if(missing.length)throw new Error(`필요한 권한: ${missing.join(', ')}. 설정 실행 파일에서 허용하고 보조 앱을 재시작하세요.`);}
async function lease(){
  await privateDirectory(ipcRoot);if(existsSync(leasePath)){const old=await readJSON(leasePath);if(alive(old.pid))throw new Error('다른 Mac 사진 자동화가 진행 중입니다.');if(old.projectRoot!==root&&old.pendingPath&&existsSync(old.pendingPath))throw new Error('다른 작업 폴더에서 먼저 미완료 사진을 복구하세요.');await unlink(leasePath);}
  await atomicJSON(leasePath,{pid:process.pid,projectRoot:root,pendingPath,startedAt:new Date().toISOString()},{exclusive:true});return async()=>{if(existsSync(leasePath)&&(await readJSON(leasePath)).pid===process.pid)await unlink(leasePath);};
}
function inferAlbum(snapshot,albums){
  const nodes=snapshot.nodes??[],byPath=new Map(nodes.map(n=>[n.path,n]));const inSidebar=node=>{let p=node;for(let i=0;i<40&&p;i++,p=byPath.get(p.parent))if(p.identifier==='SidebarOutlineView')return true;return false;};
  const names=new Set(nodes.filter(n=>n.role==='AXRow'&&n.selected===true&&inSidebar(n)).map(n=>typeof n.value==='string'?n.value:n.title).filter(Boolean));
  let matches=albums.filter(a=>names.has(a.name));if(!matches.length)matches=albums.filter(a=>a.name===snapshot.window.title);
  if(matches.length!==1)throw new Error('현재 앨범을 고유하게 확인할 수 없습니다. npm run albums에서 ID를 확인해 config.json의 albumId에 지정하세요.');return matches[0];
}
export async function makePlan(bridge,config){
  const snapshot=await bridge.call('snapshot'),state=readUI(snapshot);if(!state.viewer||state.alert)throw new Error('사진 앱에서 앨범의 사진 한 장을 크게 열어 주세요. 편집 화면에서는 시작하지 않습니다.');
  const selection=await bridge.call('selection');if(selection.items?.length!==1)throw new Error('사진을 정확히 한 장만 열어 주세요.');
  const {albums}=await bridge.call('albums');if(!Array.isArray(albums))throw new Error('앨범 목록 형식 오류');const album=config.albumId?albums.find(a=>a.id===config.albumId):inferAlbum(snapshot,albums);if(!album)throw new Error('앨범 ID를 찾지 못했습니다.');
  const contents=await bridge.call('albumItems',{id:album.id});if(contents.id!==album.id)throw new Error('요청과 다른 앨범');const items=rotateItems(contents.items,selection.items[0].id);
  return {version:1,createdAt:new Date().toISOString(),album,startingItemID:selection.items[0].id,originalIDs:contents.items.map(i=>i.id),items};
}
async function stop(){await privateDirectory(artifacts);if(!existsSync(activePath)){console.log('실행 중인 Mac 사진 작업이 없습니다.');return;}const active=await readJSON(activePath);if(!alive(active.pid)){console.log('실행 프로세스는 종료됐습니다. 미완료 기록이 있으면 recover를 실행하세요.');return;}await atomicJSON(stopPath,{requestedAt:new Date().toISOString()});console.log('중지를 요청했습니다. 진행 중인 요청 종료 후 멈춥니다.');}
async function main(){
  requireNodeVersion();
  const options=argumentsFor(process.argv.slice(2));if(options.action==='stop')return stop();const config=await configuration(options),status=await startBridge(),bridge=createBridge();
  if(options.action==='setup'){await bridge.call('showSetup');console.log('설정 창을 열었습니다. 권한 요청 버튼을 눌러 macOS 안내를 따르세요.');return;}
  if(options.action==='check'){console.log(JSON.stringify(status,null,2));requirePermissions(status);await bridge.call('selection');console.log('보조 앱·권한·사진 ID 조회 확인 완료. 사진은 변경하지 않았습니다.');return;}
  requirePermissions(status);
  if(options.action==='albums'){console.log(JSON.stringify(await bridge.call('albums'),null,2));return;}
  if(options.action==='inspect'){const file=path.join(artifacts,`inspect-${Date.now()}.json`);await atomicJSON(file,await bridge.call('snapshot'));console.log(`현재 UI 기록: ${file}`);return;}
  if(options.action==='plan'){const plan=await makePlan(bridge,config),file=path.join(artifacts,`plan-${Date.now()}.json`);await atomicJSON(file,plan);console.log(`앨범 ${plan.album.name}, ${plan.items.length}개. 사진은 변경하지 않았습니다.\n계획: ${file}`);return;}
  if(options.action==='run'&&existsSync(pendingPath))throw new Error('미완료 사진이 있습니다. 먼저 npm run recover를 실행하세요.');if(options.action==='recover'&&!existsSync(pendingPath)){console.log('복구할 사진이 없습니다.');return;}
  const release=await lease();await privateDirectory(artifacts);if(existsSync(stopPath))await unlink(stopPath);let runDir,manifest,interrupted=false;
  const onSignal=()=>{interrupted=true;console.log('중지를 요청했습니다. 현재 요청 종료까지 기다립니다.');};process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);const stopped=()=>interrupted||existsSync(stopPath);
  try{
    if(options.action==='recover'){
      const pending=await readJSON(pendingPath);runDir=path.resolve(pending.runDir);if(path.dirname(runDir)!==artifacts)throw new Error('복구 폴더가 이 프로젝트의 결과 폴더가 아닙니다.');await atomicJSON(activePath,{pid:process.pid,runDir,action:'recover'});
      const result=await new PhotoWorkflow({bridge,config,runDir,pendingPath,stopped}).recover(pending);const mpath=path.join(runDir,'manifest.json');if(existsSync(mpath)){manifest=await readJSON(mpath);manifest.photos[result.item.id]=result;manifest.status='recovered';await atomicJSON(mpath,manifest);}console.log(`사진 한 장 복구: ${result.status}\n${runDir}`);return;
    }
    const plan=await makePlan(bridge,config);runDir=path.join(artifacts,`photos-${new Date().toISOString().replace(/[:.]/g,'-')}`);await mkdir(runDir,{mode:0o700});await privateDirectory(path.join(runDir,'.metadata'));await atomicJSON(path.join(runDir,'plan.json'),plan);
    manifest={version:1,status:'running',startedAt:new Date().toISOString(),album:plan.album,photos:{},total:plan.items.length};await atomicJSON(activePath,{pid:process.pid,runDir,action:'run'});await atomicJSON(path.join(runDir,'manifest.json'),manifest);
    const recorder=createBridge({onRequest:r=>atomicJSON(path.join(runDir,'.metadata',`request-${r.id}.json`),r,{exclusive:true})}),workflow=new PhotoWorkflow({bridge:recorder,config,runDir,pendingPath,stopped});console.log(`앨범: ${plan.album.name} (${plan.items.length}개)\n결과 폴더: ${runDir}`);
    let visited=0;for(const item of plan.items){workflow.checkStop();const current=await recorder.call('albumItems',{id:plan.album.id});if(JSON.stringify(current.items?.map(i=>i.id))!==JSON.stringify(plan.originalIDs))throw new Error('실행 중 앨범 구성이나 순서가 바뀌었습니다.');const result=/\.(mov|mp4|m4v|avi)$/i.test(item.filename)?{item,status:'skipped-video'}:await workflow.process(item);manifest.photos[item.id]=result;visited++;manifest.updatedAt=new Date().toISOString();await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.log(`[${visited}/${plan.items.length}] ${result.status}`);if(options.limit&&visited>=options.limit)break;}
    manifest.status=visited===plan.items.length?'complete':'paused-after-limit';manifest.finishedAt=new Date().toISOString();await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.log(`작업 종료: ${manifest.status}\n${runDir}`);
  }catch(error){if(manifest){manifest.status=stopped()?'stopped':'failed';manifest.error={at:new Date().toISOString(),message:error.message};await atomicJSON(path.join(runDir,'manifest.json'),manifest);}if(existsSync(pendingPath))console.error('미완료 사진 기록을 보존했습니다. 다음 실행 전에 npm run recover를 실행하세요.');throw error;}
  finally{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);if(existsSync(activePath))await unlink(activePath);await release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
