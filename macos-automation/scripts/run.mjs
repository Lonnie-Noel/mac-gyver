import { existsSync } from 'node:fs';
import { unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createBridge, startBridge, root, ipcRoot, atomicJSON, readJSON, privateDirectory } from './bridge.mjs';
import { resolveNamedAlbum, namedAlbumPlan, loadAlbumBatch, albumBatchPointerPath, cloneAlbumName, validateCloneResult } from './named-album.mjs';
import { readUI, rotateItems, validateConfig } from './core.mjs';
import { PhotoWorkflow } from './workflow.mjs';
import { requireNodeVersion } from './runtime.mjs';
import { openSettings } from './setup.mjs';
import { batchPointerPath, loadInputBatch, remainingItems, isFinishedPhoto } from './batch-state.mjs';
import { scanInputImages, importInputImages, requireFileImportSupport, requireImportReady, verifyImportedAlbum, waitForImportedAlbum } from './input-images.mjs';
const artifacts=path.join(root,'artifacts'), pendingPath=path.join(artifacts,'pending-edit.json'), stopPath=path.join(artifacts,'STOP'), activePath=path.join(artifacts,'active-run.json'), leasePath=path.join(ipcRoot,'workflow-lock.json');
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export function argumentsFor(argv) {
  const action = argv[0] ?? 'run';
  if (!['setup', 'check', 'inspect', 'albums', 'plan', 'run', 'resume', 'stop', 'recover'].includes(action)) throw new Error('명령: setup|check|inspect|albums|plan|run|resume|stop|recover');
  const options = { action };
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index], key = flag.slice(2);
    if (!['--limit', '--album-id', '--album-name', '--config', '--new-run'].includes(flag) || key in options) throw new Error('알 수 없거나 중복된 옵션');
    if (flag === '--new-run') { options[key] = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('옵션 값이 없습니다.');
    options[key] = value;
  }
  if (options.limit !== undefined) {
    options.limit = Number(options.limit);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || !['run', 'resume'].includes(action)) throw new Error('--limit은 run 또는 resume에서 양의 정수로 지정하세요.');
  }
  if (options['album-id'] && options['album-name']) throw new Error('--album-id와 --album-name은 함께 지정할 수 없습니다.');
  if (options['new-run'] && (action !== 'run' || options['album-id'])) throw new Error('--new-run은 run에서만 지정하고 --album-id와 함께 쓰지 마세요.');
  if (action === 'resume' && options['album-id']) throw new Error('resume은 기록된 작업을 이어합니다. --album-id는 지정하지 마세요.');
  return options;
}

async function configuration(options) {
  const file = options.config ? path.resolve(options.config) : path.join(root, existsSync(path.join(root, 'config.json')) ? 'config.json' : 'config.example.json');
  const stored = await readJSON(file);
  return validateConfig({ ...stored, albumId: options['album-id'] ?? null,
    albumName: options['album-id'] ? null : (options['album-name'] ?? (Object.hasOwn(stored, 'albumName') ? stored.albumName : 'Reframe')) });
}
function requirePermissions(s){const missing=[];if(!s.accessibility||!s.postEvents)missing.push('손쉬운 사용');if(!s.screenCapture)missing.push('화면 기록');if(s.photos!=='authorized')missing.push('사진 전체 접근');if(missing.length)throw new Error(`필요한 권한: ${missing.join(', ')}. 설정 실행 파일에서 허용하고 보조 앱을 재시작하세요.`);}
async function lease(){
  await privateDirectory(ipcRoot);if(existsSync(leasePath)){const old=await readJSON(leasePath);if(alive(old.pid))throw new Error('다른 Mac 사진 자동화가 진행 중입니다.');if(old.projectRoot!==root&&old.pendingPath&&existsSync(old.pendingPath))throw new Error('다른 작업 폴더에서 먼저 미완료 사진을 복구하세요.');await unlink(leasePath);}
  await atomicJSON(leasePath,{pid:process.pid,projectRoot:root,pendingPath,startedAt:new Date().toISOString()},{exclusive:true});return async()=>{if(existsSync(leasePath)&&(await readJSON(leasePath)).pid===process.pid)await unlink(leasePath);};
}
export async function makePlan(bridge,config){
  if(config.albumName) return namedAlbumPlan(bridge, await resolveNamedAlbum(bridge, config.albumName));
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
  if(['run','resume'].includes(options.action)&&existsSync(pendingPath))throw new Error('미완료 사진이 있습니다. 먼저 npm run recover를 실행하세요.');
  const config = await configuration(options);
  const fromNamed = ['plan','run','resume'].includes(options.action) && !!config.albumName;
  const fromInput=['plan','run','resume'].includes(options.action)&&!config.albumId&&!fromNamed;
  const input=fromInput?await scanInputImages(path.join(root,'InputImages')):undefined;
  if(options.action==='plan'&&fromInput){
    const file=path.join(artifacts,`plan-${Date.now()}.json`);
    await atomicJSON(file,{version:2,source:'input-folder',createdAt:new Date().toISOString(),...input});
    console.log(`InputImages: ${input.files.length}장 (파일명 순)\n${input.files.map(f=>f.filename).join('\n')}\n사진 앱에 가져오거나 편집하지 않았습니다.\n계획: ${file}`);return;
  }
  const status=await startBridge(),bridge=createBridge();
  if(options.action==='check'){console.log(JSON.stringify(status,null,2));requirePermissions(status);await bridge.call('selection');console.log('보조 앱·권한·사진 ID 조회 확인 완료. 사진은 변경하지 않았습니다.');return;}
  requirePermissions(status);
  if(options.action==='albums'){console.log(JSON.stringify(await bridge.call('albums'),null,2));return;}
  if(options.action==='inspect'){const file=path.join(artifacts,`inspect-${Date.now()}.json`);await atomicJSON(file,await bridge.call('snapshot'));console.log(`현재 UI 기록: ${file}`);return;}
  if(options.action==='plan'){const plan=await makePlan(bridge,config),file=path.join(artifacts,`plan-${Date.now()}.json`);await atomicJSON(file,plan);console.log(`앨범 ${plan.album.name}, ${plan.items.length}개. 사진은 변경하지 않았습니다.\n계획: ${file}`);return;}
  if(['run','resume'].includes(options.action)&&existsSync(pendingPath))throw new Error('미완료 사진이 있습니다. 먼저 npm run recover를 실행하세요.');if(options.action==='recover'&&!existsSync(pendingPath)){console.log('복구할 사진이 없습니다.');return;}
  const release=await lease();await privateDirectory(artifacts);if(existsSync(stopPath))await unlink(stopPath);let runDir,manifest,interrupted=false;
  const onSignal=()=>{interrupted=true;console.log('중지를 요청했습니다. 현재 요청 종료까지 기다립니다.');};process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);const stopped=()=>interrupted||existsSync(stopPath);
  try{
    if(options.action==='recover'){
      const pending=await readJSON(pendingPath);runDir=path.resolve(pending.runDir);if(path.dirname(runDir)!==artifacts)throw new Error('복구 폴더가 이 프로젝트의 결과 폴더가 아닙니다.');await atomicJSON(activePath,{pid:process.pid,runDir,action:'recover'});
      const mpath = path.join(runDir, 'manifest.json');
      if (!existsSync(mpath)) throw new Error('복구 작업의 manifest 기록이 없습니다. 미완료 기록을 보존합니다.');
      manifest = await readJSON(mpath);
      const onComplete = async result => {
        if (result.item?.id !== pending.item.id || result.item?.filename !== pending.item.filename) throw new Error('복구 완료 기록의 사진 식별자가 다릅니다.');
        const next = { ...manifest, photos: { ...manifest.photos, [result.item.id]: result }, status: 'recovered', updatedAt: new Date().toISOString() };
        await atomicJSON(mpath, next);
        manifest = next;
      };
      const result = await new PhotoWorkflow({ bridge, config, runDir, pendingPath, stopped, onComplete }).recover(pending);
      console.log(`사진 한 장 복구: ${result.status}\n${runDir}`);
      return;
    }
    let plan;
    const namedAlbum = fromNamed ? await resolveNamedAlbum(bridge, config.albumName) : null;
    const previous = options['new-run'] ? null : fromInput ? await loadInputBatch(artifacts, input) : fromNamed ? await loadAlbumBatch(artifacts, namedAlbum) : null;
    if (previous && fromNamed) verifyImportedAlbum(await bridge.call('albumItems', { id: previous.plan.album.id }), previous.plan.album, previous.plan.items);
    if (options.action === 'resume' && !previous) throw new Error('이어할 작업 기록이 없습니다. 먼저 시작 또는 1장 테스트를 실행하세요.');
    if (previous) {
      ({ runDir, manifest, plan } = previous);
      if (!remainingItems(plan, manifest).length) {
        manifest.status = 'complete';
        await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
        console.log(`이미 모든 사진을 처리했습니다. 작업 앨범과 편집 결과는 그대로 남아 있습니다.\n결과 폴더: ${runDir}\n새로 테스트하려면 npm start -- --new-run을 실행하세요.`);
        return;
      }
      console.log(`기존 작업 이어하기: ${plan.items.length - remainingItems(plan, manifest).length}/${plan.items.length}장 완료. 완료한 사진을 건너뜁니다.`);
      manifest.status = 'running';
      manifest.resumedAt = new Date().toISOString();
    } else {
      if (fromInput) { requireFileImportSupport(status); await requireImportReady(bridge); }
      else {
        if (fromNamed && !status.capabilities?.includes('clone-reframe-album-v1')) throw new Error('앨범 사진 복사를 지원하는 도우미 업데이트가 필요합니다. 보조 앱 종료 후 설정 커맨드를 실행하세요.');
        plan = fromNamed ? await namedAlbumPlan(bridge, namedAlbum) : await makePlan(bridge, config);
        if (fromNamed) await requireImportReady(bridge);
      }
      const startedAt = new Date().toISOString(), runID = randomUUID();
      runDir = path.join(artifacts, `photos-${startedAt.replace(/[:.]/g, '-')}`);
      await mkdir(runDir, { mode: 0o700 });
      manifest = { version: 3, runID, source: fromInput ? 'input-folder' : fromNamed ? 'album-clone' : 'album', status: fromInput || fromNamed ? 'importing' : 'running', startedAt, album: fromNamed ? null : plan?.album, ...(fromNamed ? {sourceAlbum: namedAlbum} : {}), photos: {}, total: input?.files.length ?? plan.items.length };
    }
    await privateDirectory(path.join(runDir, '.metadata'));
    await atomicJSON(activePath, { pid: process.pid, runDir, action: options.action });
    await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
    const recorder = createBridge({ onRequest: async request => {
      await atomicJSON(path.join(runDir, '.metadata', `request-${request.id}.json`), request, { exclusive: true });
      manifest.lastRequest = { id: request.id, action: request.action, at: new Date().toISOString() };
      await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
    } });
    if (fromInput && !previous) {
      const { runID, startedAt } = manifest, albumName = `MacGyver InputImages ${startedAt}`;
      const journal = { version: 2, runID, albumName, directory: input.directory, files: input.files, ignored: input.ignored, imported: [] };
      await atomicJSON(path.join(runDir, 'import.json'), journal);
      // Persist before dispatch so an uncertain import can never silently create
      // another album on the next ordinary run.
      await atomicJSON(batchPointerPath(artifacts), { version: 1, runID, runDir });
      console.log(`InputImages: ${input.files.length}장 전체 일괄 가져오기${options.limit ? ` (이번 편집은 최대 ${options.limit}장)` : ''}\n결과 폴더: ${runDir}\n사진 앱에 전체를 복사한 뒤 원본 파일 검증까지 기다립니다.`);
      const imported = await importInputImages(recorder, input.files, { runID, albumName, stopped, onImported: async record => {
        journal.imported.push(record);
        await atomicJSON(path.join(runDir, 'import.json'), journal);
        console.log(`[복사 검증 ${journal.imported.length}/${input.files.length}] ${record.source.filename}`);
      } });
      plan = { version: 3, runID, createdAt: startedAt, ...imported, directory: input.directory, files: input.files, originalIDs: imported.items.map(item => item.id), startingItemID: imported.items[0].id };
      manifest.album = plan.album;
      manifest.status = 'running';
      await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
      // A stop after a successful transaction must retain a resumable plan even
      // when Photos.app has not yet refreshed its album list.
      await atomicJSON(path.join(runDir, 'plan.json'), plan);
      if (stopped()) throw new Error('전체 가져오기를 마친 뒤 중지했습니다. 다음 실행에서 같은 앨범을 이어합니다.');
      console.log('전체 가져오기 완료. 사진 앱에서 작업 앨범과 사진 ID를 확인합니다…');
      plan.originalIDs = await waitForImportedAlbum(recorder, imported.album, imported.items, { stopped });
    }
    if (fromNamed && !previous) {
      const sourcePlan = plan, albumName = cloneAlbumName(new Date(manifest.startedAt));
      await atomicJSON(path.join(runDir, 'clone.json'), { version: 1, runID: manifest.runID, albumName, source: sourcePlan });
      // Persist intent before sending the only mutating clone request. Missing
      // plan on resume means uncertainty, never permission to clone again.
      await atomicJSON(albumBatchPointerPath(artifacts, namedAlbum.id), { version: 1, runID: manifest.runID, runDir });
      const args = { runID: manifest.runID, sourceAlbumID: namedAlbum.id, albumName, items: sourcePlan.items };
      if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 900_000) throw new Error('앨범 복사 요청이 너무 큽니다. 사진 수를 줄여 새 작업을 시작하세요.');
      if (stopped()) throw new Error('앨범 복사 전에 중지했습니다.');
      console.log(`원본 앨범: Reframe (${sourcePlan.items.length}장)\n사진 사본과 작업 앨범 생성: ${albumName}\n결과 폴더: ${runDir}`);
      const copied = validateCloneResult(await recorder.call('cloneAlbum', args), sourcePlan, albumName);
      plan = { version: 3, source: 'album-clone', runID: manifest.runID, createdAt: manifest.startedAt,
        album: copied.album, sourceAlbum: copied.sourceAlbum, sourceItems: copied.sourceItems, imports: copied.imports,
        items: copied.imports.map(entry => entry.item), originalIDs: copied.imports.map(entry => entry.item.id), startingItemID: copied.imports[0].item.id };
      manifest.album = plan.album; manifest.status = 'running';
      await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
      await atomicJSON(path.join(runDir, 'plan.json'), plan);
      if (stopped()) throw new Error('앨범 사진 복사를 마친 뒤 중지했습니다. 다음 실행은 같은 사본을 이어합니다.');
      await waitForImportedAlbum(recorder, plan.album, plan.items, { stopped });
    }
    await atomicJSON(path.join(runDir, 'plan.json'), plan);
    const onComplete = async result => {
      const planned = plan.items.find(item => item.id === result.item?.id);
      if (!planned || result.item.filename !== planned.filename || !isFinishedPhoto(result)) throw new Error('사진 처리 완료 기록이 고정한 작업 계획과 다릅니다.');
      const next = { ...manifest, photos: { ...manifest.photos, [result.item.id]: result }, updatedAt: new Date().toISOString() };
      await atomicJSON(path.join(runDir, 'manifest.json'), next);
      manifest = next;
    };
    const workflow = new PhotoWorkflow({ bridge: recorder, config, runDir, pendingPath, stopped, onComplete });
    console.log(`앨범: ${plan.album.name} (${plan.items.length}개)\n결과 폴더: ${runDir}`);
    let visited = 0;
    for (const item of remainingItems(plan, manifest)) {
      workflow.checkStop();
      const current = await recorder.call('albumItems', { id: plan.album.id });
      if (fromInput || fromNamed) verifyImportedAlbum(current, plan.album, plan.items);
      else if (JSON.stringify(current.items?.map(item => item.id)) !== JSON.stringify(plan.originalIDs)) throw new Error('실행 중 앨범 구성이나 순서가 바뀌었습니다.');
      const result = /\.(mov|mp4|m4v|avi)$/i.test(item.filename) ? { item, status: 'skipped-video' } : await workflow.process(item);
      if (!isFinishedPhoto(result) || result.item?.id !== item.id || result.item?.filename !== item.filename) throw new Error('사진 처리 완료 기록이 요청한 사진과 일치하지 않습니다.');
      // Skipped images do not create a pending journal or call onComplete.
      if (manifest.photos[item.id] !== result) await onComplete(result);
      visited++;
      console.log(`[${plan.items.length - remainingItems(plan, manifest).length}/${plan.items.length}] ${result.status}`);
      if (options.limit && visited >= options.limit) break;
    }
    manifest.status = remainingItems(plan, manifest).length ? 'paused-after-limit' : 'complete';
    manifest.updatedAt = new Date().toISOString();
    if (manifest.status === 'complete') manifest.finishedAt = manifest.updatedAt;
    else manifest.pausedAt = manifest.updatedAt;
    await atomicJSON(path.join(runDir, 'manifest.json'), manifest);
    console.log(`작업 종료: ${manifest.status}\n${runDir}\n작업 앨범과 저장한 편집 결과를 보존했습니다.${manifest.status === 'paused-after-limit' ? ' 다음 실행에서 남은 사진을 이어합니다.' : ''}`);
  }catch(error){if(manifest){manifest.status=stopped()?'stopped':'failed';manifest.error={at:new Date().toISOString(),message:error.message};await atomicJSON(path.join(runDir,'manifest.json'),manifest);console.error(`마지막 도우미 요청: ${manifest.lastRequest?.action??"없음"}\n오류 기록: ${path.join(runDir,'manifest.json')}`);}if(existsSync(pendingPath))console.error('미완료 사진 기록을 보존했습니다. 다음 실행 전에 npm run recover를 실행하세요.');throw error;}
  finally{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);if(existsSync(activePath)&&(await readJSON(activePath)).pid===process.pid)await unlink(activePath);await release();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
