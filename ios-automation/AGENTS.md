# iPhone 사진 자동화 유지보수 지침

이 폴더는 USB로 연결한 실제 아이폰의 사진 앱을 조작한다. 설치·운영 안내는 `README.md`, 실제 동작은 `scripts/`를 기준으로 확인한다.

## 작업 범위

- 문서 작성, 배포 파일 준비, 구문 검사 요청만으로 아이폰 조작이 허용되는 것은 아니다. 이 작업에서는 Appium 세션을 열거나 사진을 조작하지 않는다.
- 실제 기기 연결·캡처·편집 테스트는 사용자가 요청하거나 이미 허용한 범위에서 수행한다. 기존 승인이 유효하면 같은 승인을 반복해서 요구하지 않는다.
- 사용자가 중지를 요청하면 `npm run photos:stop`으로 중지하고 현재 요청과 정리 절차가 끝났는지 확인한다. 중지 요청 전송만으로 종료됐다고 보고하지 않는다.
- 예상하지 못한 화면이나 경고를 임의로 통과시키지 않는다. 현재 상태와 실패 근거를 확인하고 원인을 해결한다.

## 구성과 책임

| 파일 | 책임 |
| --- | --- |
| `사진 자동 캡처 시작.command` | Node 버전을 검사하고 실행 프로그램을 호출하는 macOS 실행 파일 |
| `사진 자동 캡처 중지.command` | 실행 프로그램에 협조적 중지를 요청하는 macOS 실행 파일 |
| `scripts/run-photos.mjs` | 중복 실행 방지, 로컬 서버 준비, 세션 연결, 앨범 순번 읽기, 새 결과 폴더 생성, 배치 실행과 세션 종료 |
| `scripts/phone.mjs` | Appium HTTP 명령, 사진 앱용 세션, UI 요소 검색, 화면·XML 캡처 |
| `scripts/photos-batch.mjs` | UI 상태 해석, 사진 순회, 드래그·재생성·취소, 완료 증거 검증과 중단 기록 |
| `scripts/smoke.mjs` | 설정 형식 검사 또는 기기 연결·화면 캡처·UI 구조 읽기·세션 종료 |
| `scripts/package-release.mjs` | 명시한 소스 파일만 검증·압축하고 배포 ZIP과 SHA-256 생성 |
| `scripts/capture-storage.mjs`, `scripts/photo-filename.mjs` | 원래 파일명 읽기, 평면 저장 경로 예약, 이전 결과 호환 |
| `scripts/export-bridge.mjs`, `ExportBridge/` | PhotoKit 보조 앱 통신, 실제 JPEG 내보내기·검증·원본 복원 |
| `scripts/edit-journal.mjs`, `scripts/recover-photo.mjs` | 저장 직전 복구 기록, 중단된 사진의 내보내기·복원 확인 |
| `.env.example` | 배포 가능한 빈 설정 양식. 실제 값은 로컬 `.env`에만 보관 |

Appium → XCUITest 드라이버 → Xcode로 서명한 WebDriverAgent(WDA) → 실제 아이폰 순으로 명령이 전달된다. `WebDriverAgentRunner-Runner`는 아이폰에서 XCUITest를 실행하는 개발용 테스트 도우미다. VPN 앱이나 MDM 등록을 뜻하지 않는다.

## 유지해야 할 동작

- 현재 기준은 한국어 사진 앱, iPhone 16 Pro, iOS 27, 세로 화면 **402 × 874 포인트**다. 캡처는 **1206 × 2622 픽셀**이다. 다른 크기·언어·UI를 지원한다고 추정하지 않는다.
- 한 장을 연 화면에서 `편집 → 도구 → 프레임 재설정 → 준비 완료 → 드래그 → 전 캡처 → 프레임 재설정 → 재생성 완료 → 후 캡처 → 취소 → 취소`를 수행한다.
- 드래그는 `(201, 437)`에서 `(5, 633)`까지 1,500ms다. 화면 중앙에서 왼쪽 아래 45도로 왼쪽 가장자리 안쪽까지 이동하는 현재 구현을 보존한다.
- 재생성 요청 뒤 **최소 25초**가 지나야 하며, 동시에 실제 완료 상태(`editAIStatusViewCompleted`, 활성 `Save`, 진행 표시 없음)를 확인해야 한다. 고정 시간 대기만으로 캡처하지 않는다.
- 캡처 모드는 `Save`/`완료`를 누르지 않고 **취소 → 취소**한다. 사용자가 요청한 JPEG 모드는 `IOS_EXPORT_BUNDLE_ID` 설정으로 켜며, Save/완료 후 실제 JPEG를 검증하고 동일 asset ID를 PhotoKit으로 원본 복원한다. 이 두 모드를 혼동하지 않는다.
- JPEG 모드는 처음부터 편집이 없는 사진만 처리한다. 기존 편집은 건너뛰고 파일명 중복은 중단한다. 전체 사진 접근 권한은 보조 앱에서 사용자가 설정한다. 같은 이름만 보고 여러 asset 중 하나를 임의로 고르지 않는다.
- `artifacts/pending-photo-edit.json`을 실제 저장 전에 남긴다. JPEG 전송·전체 디코딩·크기·해시 검증 전에는 원본으로 복귀하지 않는다. 미복원 기록이 있으면 새 실행을 막고 `npm run photos:recover`로 먼저 복구한다. 복구 전 기록·보조 앱 데이터를 지우지 않는다.
- 결과 PNG/JPEG는 실행 폴더 바로 아래 `<원래이름>-preview-capture.png`, `-result-capture.png`, `-result.jpg`로 둔다. XML/해시는 `.metadata/`에 둔다. 이름 충돌 시 접미사를 붙이며 기존 파일을 덮어쓰지 않는다. 이전 폴더 방식의 manifest도 검증할 수 있어야 한다.
- 사진 선택기의 현재 순번과 총수를 검증하고, 이동할 때 정확히 한 장 바뀌는지 확인한다. 사진 수 변경·순번 점프·사진 앱 이탈·예상 밖 경고에서는 중단한다.
- 순번과 총수는 전역적으로 안정적인 앨범 ID나 사진 ID가 아니다. 개수가 같은 다른 앨범, 정렬 변경, 내용 교체를 완전히 식별하지 못한다. 실행·재개 중 같은 앨범과 정렬을 유지해야 하며 WDA 요소 UUID를 영구 사진 ID로 쓰지 않는다.
- Appium 서버와 클라이언트는 `127.0.0.1:4723`을 사용한다. 배포 편의를 위해 `0.0.0.0`으로 바꾸거나 외부에 공개하지 않는다.

## 명령

아래 명령은 모두 이 폴더에서 실행한다. 설치에는 Node.js **22.12 이상 23 미만**, 잠금 파일과 일치하는 의존성, 기기 iOS를 지원하는 Xcode가 필요하다.

```bash
npm ci
npm run doctor
npm run wda:open
npm run smoke:check
node scripts/run-photos.mjs --check
```

`wda:open`은 Xcode 프로젝트를 여는 명령이다. 두 `--check` 명령은 설정/파일 형식만 검사하고 기기·서명 유효성을 확인하지 않는다. `--record-pilot`은 실제 기기 상태를 읽으므로 오프라인 검사로 취급하지 않는다.

사용자가 실제 실행을 요청한 경우:

```bash
npm run photos
npm run photos:stop
npm run photos:recover
```

세부 테스트가 필요한 경우 서버를 별도 터미널에서 `npm start`로 실행하고 다음 명령을 사용한다. 아래 25와 2는 예시이며 실제 앨범의 총수와 시작 순번에 맞춘다.

```bash
npm run smoke
npm run photos:connect
npm run photos:batch -- --run-dir artifacts/my-album-run --total 25 --start-index 2 --max-photos 1
npm run photos:disconnect
```

## 중지·재개·증거

- `artifacts/active-session.json`은 이 프로젝트의 세션 정보다. 실행 중인지 확인하지 않고 삭제하거나 다른 Appium 작업을 일괄 종료하지 않는다.
- 실행 프로그램은 `.photos-workflow.lock`, 배치는 실행 폴더의 `.batch.lock`으로 중복 실행을 막는다. 잠금 파일은 해당 PID와 실행 상태를 확인한 뒤에만 정리한다.
- 중지는 실행 폴더의 `STOP`으로도 요청할 수 있다. 진행 중인 요청은 즉시 취소되지 않으며 편집 화면이 남을 수 있다. 재개 전 원래 사진 화면으로 취소 복귀하고 `STOP`을 제거한다.
- 매번 시작 파일을 실행하면 새 결과 폴더를 만든다. 수동 재개는 같은 `--run-dir`, `--total`, `--start-index`를 사용하며 같은 앨범인지 확인해야 한다.
- `manifest.json`의 상태와 사진별 전후 PNG/XML, `generation.json`의 시간·드래그 정보를 함께 확인한다. PNG 존재만으로 완료 처리하지 않는다.
- 완료 기록은 전후 캡처 검증과 원래 사진 화면 복귀까지 포함한다. 실패·중지 기록과 `failures/` 증거를 보존하고 과거 결과를 덮어쓰지 않는다.

## 검증과 배포

- 문서 변경에 실제 기기 테스트는 필요 없다. 코드 변경은 영향 범위의 구문 검사와 오프라인 상태 해석부터 확인한다.
- `npm test`는 파일명·경로·기존 결과 호환·가짜 보조 앱 통신·해시·복구 순서를 오프라인에서 검사한다. 시뮬레이터 빌드는 `ExportBridge/README.md`를 따른다. 기기 테스트와 구분해서 보고한다.
- 구문 검사: `node --check scripts/photos-batch.mjs`, `node --check scripts/run-photos.mjs`, `node --check scripts/phone.mjs`, `node --check scripts/smoke.mjs`, `zsh -n "사진 자동 캡처 시작.command"`, `zsh -n "사진 자동 캡처 중지.command"`.
- 기존 로컬 XML로 검사: `node scripts/photos-batch.mjs --fixture PATH_TO_SOURCE_XML`. 필요하면 개인정보 없는 합성 XML로 준비/생성 중/완료/경고/잘못된 순번 구분을 검사한다. `parseState`, `buildOrder`는 import해 오프라인 검사할 수 있다.
- 실제 검증 범위는 연결 스모크 성공과 앨범의 **6장(2~7번), 캡처 12개, 취소 복귀**다. 사용자 요청으로 중단했으므로 **전체 25장 완료**나 **더블클릭 실행 프로그램의 전체 앨범 통합 검증**을 완료했다고 쓰지 않는다.
- 0.2.0의 정보 패널 파일명 인식·새 저장 방식·보조 앱 JPEG 저장/복원 통합은 아직 실기기 미검증이다. 기존 6장 결과를 새 기능의 검증으로 쓰지 않는다.
- 배포물은 소스, 문서, 실행 파일, `package.json`, `package-lock.json`, 빈 `.env.example` 등 필요한 파일만 포함한다. Git 제외 규칙만 믿지 말고 압축 파일 목록을 직접 검사한다.
- `node scripts/package-release.mjs --check`는 배포 파일만 검사하고, `npm run release:zip`은 `dist/`에 ZIP과 SHA-256을 생성한다. 기기 연결은 하지 않는다. 공개 npm 의존성 연락처를 제외한 민감정보 패턴을 검사하지만 수동 내용 검토를 대체하지 않는다.
- `.env`, 실제 UDID·Team ID·계정 이메일, 서명 인증서·개인키·프로비저닝 프로파일, `node_modules/`, `DerivedData/`, `.appium/`, `artifacts/`, `logs/`와 캡처·UI XML·세션 정보를 배포하지 않는다.
- 수신자는 자신의 Apple 계정과 기기로 WDA를 새로 서명·설치하고 필요한 개발자 신뢰를 완료한다. 작성자의 서명된 WDA 앱이나 인증서를 재사용하는 배포 방식으로 바꾸지 않는다.
