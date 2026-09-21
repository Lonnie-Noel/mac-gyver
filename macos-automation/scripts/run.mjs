import { existsSync } from 'node:fs';
import { unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createBridge, startBridge, root, ipcRoot, atomicJSON, readJSON, privateDirectory } from './bridge.mjs';
import { readUI, rotateItems, validateConfig } from './core.mjs';
import { PhotoWorkflow } from './workflow.mjs';
import { requireNodeVersion } from './runtime.mjs';
import { openSettings } from './setup.mjs';
import { scanInputImages, importInputImages, requireImportReady, verifyImportedAlbum, waitForImportedAlbum } from './input-images.mjs';
const artifacts=path.join(root,'artifacts'), pendingPath=path.join(artifacts,'pending-edit.json'), stopPath=path.join(artifacts,'STOP'), activePath=path.join(artifacts,'active-run.json'), leasePath=path.join(ipcRoot,'workflow-lock.json');
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export function argumentsFor(argv) {
  const action=argv[0]??'run';if(!['setup','check','inspect','albums','plan','run','stop','recover'].includes(action))throw new Error('명령: setup|check|inspect|albums|plan|run|stop|recover');
  const options={action};for(let i=1;i<argv.length;i+=2){const key=argv[i],value=argv[i+1];if(!value||!['--limit','--album-id','--config'].includes(key))throw new Error('알 수 없거나 값이 없는 옵션');options[key.slice(2)]=value;}
  if(options.limit!==undefined){options.limit=Number(options.limit);if(!Number.isSafeInteger(options.limit)||options.limit<1||action!=='run')throw new Error('--limit은 run에서 양의 정수로 지정하세요.');}return options;
}
async function configuration(options){const file=options.config?path.resolve(options.config):path.join(root,existsSync(path.join(root,'config.json'))?'config.json':'config.example.json');return validateConfig({...await readJSON(file),albumId:options['album-id']??null});}
function requirePermissions(s){const missing=[];if(!s.accessibility||!s.postEvents)missing.push('손쉬운 사용');if(!s.screenCapture)missing.push('화면 기록');if(s.photos!=='authorized')missing.push('사진 전체 접근');if(missing.length)throw new Error(`필요한 권한: ${missing.join(', ')}. 설정 실행 파일에서 허용하고 보조 앱을 재시작하세요.`);}
async function lease(){
  await privateDirectory(ipcRoot);if(existsSync(leasePath)){const old=await readJSON(leasePath);if(alive(old.pid))throw new Error('다른 Mac 사진 자동화가 진행 중입니다.');if(old.projectRoot!==root&&old.pendingPath&&existsSync(old.pendingPath))throw new Error('다른 작업 폴더에서 먼저 미완료 사진을 복구하세요.');await unlink(leasePath);}
  await atomicJSON(leasePath,{pid:process.pid,projectRoot:root,pendingPath,startedAt:new Date().toISOString()},{exclusive:true});return async()=>{if(existsSync(leasePath)&&(await readJSON(leasePath)).pid===process.pid)await unlink(leasePath);};
}
export async function makePlan(bridge,config){
  if(!config.albumId)throw new Error('기존 앨범 모드는 --album-id로 앨범을 지정하세요. 기본 실행은 InputImages 폴더를 사용합니다.');
  const snapshot=await bridge.call('snapshot'),state=readUI(snapshot);if(!state.viewer||state.alert)throw new Error('사진 앱에서 앨범의 사진 한 장을 크게 열어 주세요. 편집 화면에서는 시작하지 않습니다.');
  const selection=await bridge.call('selection');if(selection.items?.length!==1)throw new Error('사진을 정확히 한 장만 열어 주세요.');
  const {albums}=await bridge.call('albums');if(!Array.isArray(albums))throw new Error('앨범 목록 형식 오류');const album=albums.find(a=>a.id===config.albumId);if(!album)throw new Error('앨범 ID를 찾지 못했습니다.');
  const contents=await bridge.call('albumItems',{id:album.id});if(contents.id!==album.id)throw new Error('요청과 다른 앨범');const items=rotateItems(contents.items,selection.items[0].id);
  return {version:1,source:'album',createdAt:new Date().toISOString(),album,startingItemID:selection.items[0].id,originalIDs:contents.items.map(i=>i.id),items};
}
async function stop(){await privateDirectory(artifacts);if(!existsSync(activePath)){console.log('실행 중인 Mac 사진 작업이 없습니다.');return;}const active=await readJSON(activePath);if(!alive(active.pid)){console.log('실행 프로세스는 종료됐습니다. 미완료 기록이 있으면 recover를 실행하세요.');return;}await atomicJSON(stopPath,{requestedAt:new Date().toISOString()});console.log('중지를 요청했습니다. 진행 중인 요청 종료 후 멈춥니다.');}
async function main(){
  requireNodeVersion();
  const options=argumentsFor(process.argv.slice(2));if(options.action==='stop')return stop();if(options.action==='setup')return openSettings();
  if(options.action==='run'&&existsSync(pendingPath))throw new Error('미완료 사진이 있습니다. 먼저 npm run recover를 실행하세요.');
  const fromInput=['plan','run'].includes(options.action)&&!options['album-id'];
  const input=fromInput?await scanInputImages(path.join(root,'InputImages'),{limit:options.limit}):undefined;
  if(options.action==='plan'&&fromInput){
    const file=path.join(artifacts,`plan-${Date.now()}.json`);
    await atomicJSON(file,{version:2,source:'input-folder',createdAt:new Date().toISOString(),...input});
    console.log(`InputImages: ${input.files.length}장 (파일명 순)\n${input.files.map(f=>f.filename).join('\n')}\n사진 앱에 가져오거나 편집하지 않았습니다.\n계획: ${file}`);return;
  }
  const config=await configuration(options),status=await startBridge(),bridge=createBridge();
  if(fromInput&&!status.capabilities?.includes('input-images-v1'))throw new Error('InputImages 기능이 있는 새 도우미가 필요합니다. 설정 창의 보조 앱 종료를 누른 뒤 설정 커맨드로 다시 빌드하세요.');
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
    let plan;
    if(fromInput)await requireImportReady(bridge);else plan=await makePlan(bridge,config);
    const startedAt=new Date().toISOString(),runID=randomUUID();
    runDir=path.join(artifacts,`photos-${startedAt.replace(/[:.]/g,'-')}`);await mkdir(runDir,{mode:0o700});await privateDirectory(path.join(runDir,'.metadata'));
    manifest={version:2,runID,source:fromInput?'input-folder':'album',status:fromInput?'importing':'running',startedAt,album:plan?.album,photos:{},total:input?.files.length??plan.items.length};
    await atomicJSON(activePath,{pid:process.pid,runDir,action:'run'});await atomicJSON(path.join(runDir,'manifest.json'),manifest);
    const recorder=createBridge({onRequest:async r=>{
      await atomicJSON(path.join(runDir,'.metadata',`request-${r.id}.json`),r,{exclusive:true});
      manifest.lastRequest={id:r.id,action:r.action,at:new Date().toISOString()};
      await atomicJSON(path.join(runDir,'manifest.json'),manifest);
    }});
    if(fromInput){
      const albumName=`MacGyver InputImages ${startedAt}`;
      const journal={version:1,runID,albumName,directory:input.directory,files:input.files,ignored:input.ignored,imported:[]};
      await atomicJSON(path.join(runDir,'import.json'),journal);
      console.log(`InputImages: ${input.files.length}장 가져오기\n결과 폴더: ${runDir}\n사진 앱에 복사한 뒤 원본 파일 검증까지 기다립니다.`);
      const imported=await importInputImages(recorder,input.files,{runID,albumName,stopped,onImported:async record=>{
        journal.imported.push(record);await atomicJSON(path.join(runDir,'import.json'),journal);
        manifest.album=record.album;await atomicJSON(path.join(runDir,'manifest.json'),manifest);
        console.log(`[가져오기 ${journal.imported.length}/${input.files.length}] ${record.source.filename}`);
      }});
      if(stopped())throw new Error('가져오기 후 중지했습니다.');
      console.log('가져오기 완료. 사진 앱에서 작업 앨범과 사진 ID를 확인합니다…');
      const originalIDs=await waitForImportedAlbum(recorder,imported.album,imported.items,{stopped});
      plan={version:2,runID,createdAt:startedAt,...imported,directory:input.directory,originalIDs,startingItemID:imported.items[0].id};
      manifest.status='running';manifest.album=plan.album;await atomicJSON(path.join(runDir,'manifest.json'),manifest);
    }
    await atomicJSON(path.join(runDir,'plan.json'),plan);
    const workflow=new PhotoWorkflow({bridge:recorder,config,runDir,pendingPath,stopped});console.log(`앨범: ${plan.album.name} (${plan.items.length}개)\n결과 폴더: ${runDir}`);
    let visited=0;for(const item of plan.items){
      workflow.checkStop();const current=await recorder.call('albumItems',{id:plan.album.id});
      if(fromInput)verifyImportedAlbum(current,plan.album,plan.items);
      else if(JSON.stringify(current.items?.map(i=>i.id))!==JSON.stringify(plan.originalIDs))throw new Error('실행 중 앨범 구성이나 순서가 바뀌었습니다.');
      const result=/\.(mov|mp4|m4v|avi)$/i.test(item.filename)?{item,status:'skipped-video'}:await workflow.process(item);manifest.photos[item.id]=result;visited++;manifest.updatedAt=new Date().toISOString();await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.log(`[${visited}/${plan.items.length}] ${result.status}`);if(options.limit&&visited>=options.limit)break;
    }
    manifest.status=visited===plan.items.length?'complete':'paused-after-limit';manifest.finishedAt=new Date().toISOString();await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.log(`작업 종료: ${manifest.status}\n${runDir}`);
  }catch(error){if(manifest){manifest.status=stopped()?'stopped':'failed';manifest.error={at:new Date().toISOString(),message:error.message};await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.error(`마지막 도우미 요청: ${manifest.lastRequest?.action??"없음"}\n오류 기록: ${path.join(runDir,'manifest.json')}`);}if(existsSync(pendingPath))console.error('미완료 사진 기록을 보존했습니다. 다음 실행 전에 npm run recover를 실행하세요.');throw error;}
  finally{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);if(existsSync(activePath))await unlink(activePath);await release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
