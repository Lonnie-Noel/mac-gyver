# iPhone 사진 앨범 자동 캡처

Mac에 USB로 연결한 아이폰의 사진 앱에서 **프레임 재설정 전후 화면을 캡처**합니다. 추가 보조 앱을 설정하면 **편집 결과 JPEG 저장 → 검증 → 원본 복원**도 수행합니다. 최초 환경 설정 후에는 `사진 자동 캡처 시작.command`를 더블클릭해 실행합니다.

이 배포물은 **설치용 소스 묶음**입니다. 받는 사람은 자신의 Apple 계정과 아이폰으로 초기 설정을 해야 합니다. 서명된 아이폰 앱이나 개인 인증서는 포함하지 않습니다.

- 설치·운영 안내: 이 README
- AI 코딩 에이전트와 유지보수자 지침: [AGENTS.md](AGENTS.md)
- 개인 설정 양식: [.env.example](.env.example)
- 실제 JPEG 내보내기·복구 안내: [EDITED-IMAGE-EXPORT.md](EDITED-IMAGE-EXPORT.md)

## 1. WebDriverAgentRunner-Runner는 무엇인가요?

**WebDriverAgent(WDA)는 아이폰에서 자동화 명령을 실행하는 테스트 보조 앱**입니다. Xcode로 빌드하고 본인의 개발자 서명으로 설치합니다. Appium은 이 앱과 통신해 Apple의 XCTest 기능으로 화면 요소를 읽고 탭·드래그·스크린샷을 수행합니다. [WDA 공식 프로젝트](https://github.com/appium/WebDriverAgent)

```text
Mac의 자동화 스크립트
    → Appium 서버 / XCUITest 드라이버
    → USB로 연결한 아이폰의 WebDriverAgentRunner-Runner
    → 사진 앱의 화면 조작과 캡처
```

아이폰 **설정 → 일반 → VPN 및 기기 관리**에는 개발자 서명 앱의 신뢰 설정도 표시됩니다. 여기서 보이는 WDA는 위 테스트 앱입니다. 이 프로젝트의 설치 과정에는 **VPN 구성이나 MDM 기기 등록이 없습니다**. 개발자 앱 목록에서 서명에 사용한 본인 Apple 계정을 신뢰하는 절차이며, 확인 시 아이폰의 인터넷 연결이 필요합니다. [Appium 개발자 앱 신뢰 안내](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/#developer-app-certificate-is-not-trusted)

WDA를 삭제하면 다음 실행 전에 다시 설치해야 합니다. 아이폰에서 WDA 아이콘을 매번 직접 열 필요는 없으며, 연결 프로그램이 실행을 준비합니다.

## 2. 필요한 환경과 검증 범위

| 항목 | 준비할 내용 |
| --- | --- |
| Mac / Xcode | 아이폰의 iOS를 지원하는 **전체 Xcode**, 첫 실행과 추가 구성요소 설치 완료 |
| Node.js / npm | **Node 22.12 이상, 23 미만** 및 npm 10 이상 |
| 아이폰 | USB 연결, Mac 신뢰, 개발자 모드, UI 자동화 활성화, 잠금 해제 |
| 사진 앱 | **한국어·세로 방향·402 × 874 포인트**, 편집의 도구에 **프레임 재설정**이 실제로 있는 환경 |
| Apple 계정 | Xcode에 로그인한 본인의 무료 Personal Team 또는 개발 Team |
| 인터넷 | 패키지 설치·Apple 서명/앱 확인에 필요한 Mac과 아이폰 인터넷 연결 |

무료 Personal Team도 사용할 수 있습니다. 개인 테스트용 프로비저닝 프로필은 발급 후 **7일에 만료**되므로, 만료되면 같은 계정으로 다시 빌드·설치해야 합니다. [Apple 계정 안내](https://developer.apple.com/help/account/basics/about-your-developer-account)

2026-09-19 확인 환경: macOS 27.0, Xcode 27.0, Node.js 22.23.1, npm 10.9.8, iPhone 16 Pro / iOS 27.0. 고정 패키지는 Appium 3.7.0, XCUITest 드라이버 12.12.5, WebdriverIO 9.31.9, xmldom 0.9.12이며 잠금 파일의 WDA는 16.12.8입니다.

연결 검사와 실제 앨범 **6장(2~7번)의 전후 캡처 12개 및 취소 복귀**를 확인했습니다. 사용자 요청으로 중단했으므로 전체 25장 처리, 다른 아이폰 모델, 더블클릭 프로그램을 통한 전체 앨범 처리는 아직 검증하지 않았습니다. 다른 화면 크기는 실행 시 중단합니다. 사진 앱 UI가 바뀌면 스크립트 조정이 필요합니다.

**0.2.0의 새 파일명 인식·평면 저장·JPEG 내보내기/복원은 코드와 오프라인 테스트 단계입니다.** 보조 앱은 무서명 시뮬레이터 빌드를 확인했지만 실제 아이폰에서 새 흐름으로 한 장을 끝까지 처리하는 검증은 아직입니다. 기존 6장 검증을 새 JPEG 기능의 검증으로 해석하지 마세요.

## 3. 처음 설치하기

아래 명령은 **압축을 푼 `iphone-photos-automation` 폴더 안에서** 실행합니다. 저장 위치와 폴더 이름은 바꿔도 됩니다. `.command` 파일만 따로 옮기지 말고 전체 폴더를 함께 보관하세요.

### 3-1. Mac 준비

1. [Xcode](https://developer.apple.com/xcode/)를 설치하고 실행해 약관과 추가 구성요소 설치를 마칩니다. Command Line Tools만으로는 부족합니다.
2. Xcode의 `Settings → Locations → Command Line Tools`에서 사용할 Xcode를 선택합니다.
3. [Node.js 공식 다운로드](https://nodejs.org/en/download)에서 위 조건에 맞는 22 버전을 설치합니다.
4. 터미널에서 다음을 확인합니다.

```bash
xcode-select -p
xcodebuild -version
node --version
npm --version
```

`xcode-select -p`는 선택한 Xcode 앱 안의 `Contents/Developer`를 가리켜야 합니다. 여러 Xcode가 있으면 아이폰 iOS를 지원하는 버전을 선택하세요.

패키지를 설치하고 빈 개인 설정 파일을 준비합니다. 기존 `.env`는 덮어쓰지 않습니다.

```bash
npm ci
test -e .env || cp .env.example .env
npm run doctor
```

프로젝트에 고정된 Appium과 드라이버를 사용하므로 전역 Appium 설치는 필요 없습니다. `doctor`의 필수 항목 오류부터 해결하세요. 동영상 등 사용하지 않는 기능의 선택 항목까지 모두 설치할 필요는 없습니다.

### 3-2. 아이폰 준비

1. USB로 연결하고 잠금을 해제한 뒤 **이 컴퓨터를 신뢰**를 승인합니다.
2. Xcode `Window → Devices and Simulators`에서 아이폰의 준비가 끝났는지 확인합니다.
3. 아이폰 `설정 → 개인정보 보호 및 보안 → 개발자 모드`를 켭니다. 재시동 안내가 나오면 따르고, 재시동 후 암호로 잠금을 풀어 활성화를 완료합니다.
4. 아이폰 `설정 → 개발자 → UI 자동화 활성화`를 켭니다. 메뉴 표기는 iOS 버전에 따라 다를 수 있습니다.

**Mac 신뢰**, **개발자 모드**, **UI 자동화**, 다음 단계의 **개발자 앱 신뢰**는 서로 다른 설정입니다. [Appium 실기기 준비 안내](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/)

### 3-3. 본인 계정으로 WDA 서명·설치

1. Xcode `Settings → Apple Accounts`에서 본인의 Apple 계정으로 로그인합니다.
2. 터미널에서 WDA 프로젝트를 엽니다.

```bash
npm run wda:open
```

3. Xcode 왼쪽의 `WebDriverAgent` 프로젝트를 선택하고 **TARGETS → WebDriverAgentRunner → Signing & Capabilities**로 이동합니다.
4. **Automatically manage signing**을 켜고 **Team**에 본인의 Team 또는 Personal Team을 선택합니다.
5. **Bundle Identifier**를 본인만 사용하는 값으로 지정합니다. 예: `com.yourname.photosautomation.WebDriverAgentRunner`. `yourname`을 바꾸세요.
6. 실행 Scheme은 **WebDriverAgentRunner**, 실행 대상은 연결한 실제 아이폰으로 선택합니다.
7. `Product → Test`를 실행합니다. Xcode가 개발 인증서와 프로비저닝을 준비하고 WDA를 빌드·설치합니다. 필요한 기기 등록·개발자 권한 안내를 완료합니다.
8. 아이폰에 신뢰 오류가 뜨면 **설정 → 일반 → VPN 및 기기 관리 → 개발자 앱 → 본인 Apple 계정 → 신뢰/허용**을 완료합니다. 인터넷에 연결해 앱 확인을 마친 뒤 Xcode 테스트를 다시 실행합니다.
9. WDA 실행이 확인되면 **Xcode의 Stop 버튼으로 테스트를 중지**합니다. Appium 연결 검사와 Xcode 테스트를 동시에 실행하지 않습니다.

`Manage Certificates`의 추가 버튼이 비활성화됐다는 이유만으로 유료 가입이 필요한 것은 아닙니다. 먼저 위 자동 서명에서 본인 Team을 선택해 빌드하세요. 무료 계정도 Xcode에서 WDA를 설정할 수 있습니다. [WDA 수동 설정 안내](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/full-manual-config/)

### 3-4. 개인 설정 입력

텍스트 편집기로 이 폴더의 `.env`를 열고 세 값을 입력합니다. Apple 계정 비밀번호는 입력하지 않습니다.

| 변수 | 찾는 곳 / 입력할 값 |
| --- | --- |
| `IOS_UDID` | Xcode `Window → Devices and Simulators`에서 아이폰의 **Identifier** |
| `IOS_TEAM_ID` | WDA `Build Settings`에서 `DEVELOPMENT_TEAM` / `Development Team`을 검색해 확인한 **10자리 Team ID**. Team 표시 이름이 아님 |
| `WDA_BUNDLE_ID` | 앞에서 정한 WDA Bundle Identifier. 자동으로 붙는 **`.xctrunner`는 제외** |
| `IOS_EXPORT_BUNDLE_ID` | 선택: 3-6에서 설치한 PhotosExportBridge 앱의 Bundle ID. 비우면 캡처 후 취소, 입력하면 JPEG 저장·원본 복원 |

Xcode의 Team/Bundle ID와 `.env`가 일치해야 합니다. `.env`는 공유하지 마세요. 셸에 같은 이름의 환경 변수가 있다면 그 값이 `.env`보다 우선합니다.

Xcode가 Team을 이름으로만 표시하면, 열린 `WebDriverAgent.xcodeproj`의 `project.pbxproj` 파일에서 `DEVELOPMENT_TEAM`에 기록된 10자리 값을 확인할 수 있습니다. 이 프로젝트 경로는 `npm run wda:open` 실행 시 터미널에도 표시됩니다.

```bash
npm run smoke:check
node scripts/run-photos.mjs --check
```

두 명령은 파일·설정 형식만 검사하며 **아이폰에 연결하거나 사진을 조작하지 않습니다**. 통과해도 기기 연결이나 서명 유효성까지 확인한 것은 아닙니다.

`npm ci`나 드라이버 업데이트로 `node_modules`를 다시 만들면 수동 Xcode 설정이 사라질 수 있습니다. 재설치 후 `npm run wda:open`으로 서명을 확인하세요. 프로젝트의 `.env`는 유지되지만 최초 Xcode 서명 절차를 대체하지는 않습니다.

### 3-5. 연결 검사

아이폰 잠금을 풀어 둡니다. 첫 번째 터미널에서 서버를 실행합니다.

```bash
npm start
```

같은 폴더를 연 두 번째 터미널에서 실행합니다.

```bash
npm run smoke
```

WDA 빌드·설치·실행 후 현재 화면의 PNG와 UI 구조 XML을 저장하고 세션을 종료합니다. 사진 편집용 탭·드래그 명령은 보내지 않습니다. 결과의 `status: "passed"`, `sessionClosed: true`를 확인합니다.

```text
artifacts/<실행 시각>/
  result.json
  screen.png
  source.xml
```

Appium은 **127.0.0.1:4723**에서만 사용합니다. 검사 후 첫 번째 터미널의 서버는 `Ctrl+C`로 종료해도 됩니다. 더블클릭 프로그램이 필요할 때 서버를 다시 시작합니다.

### 3-6. 실제 JPEG 파일 저장용 보조 앱

화면 캡처만 필요하면 이 단계와 `IOS_EXPORT_BUNDLE_ID`를 생략합니다. 실제 JPEG가 필요하면 다음을 준비합니다.

1. Xcode로 `ExportBridge/PhotosExportBridge.xcodeproj`를 엽니다.
2. `PhotosExportBridge` 타깃의 `Signing & Capabilities`에서 자동 서명과 본인 Team을 선택합니다.
3. WDA와 다른 고유 Bundle Identifier를 정합니다. 예: `com.yourname.PhotosExportBridge`.
4. Scheme은 `PhotosExportBridge`, 대상은 아이폰을 선택하고 **Product → Run**으로 설치·실행합니다. WDA의 Test와 구분하세요.
5. 아이폰 앱의 **사진 접근 권한 설정**을 눌러 **전체 사진 접근**을 허용합니다. 같은 이름의 사진이 여러 장인지 확인하기 위해 필요합니다.
6. Xcode 실행을 중지하고 `.env`의 `IOS_EXPORT_BUNDLE_ID`에 위 Bundle ID를 입력합니다. 이것이 JPEG 모드의 활성화 설정입니다.
7. 처음에는 아래 수동 배치 명령의 `--max-photos 1`로 한 장의 캡처·JPEG·원본 복원을 확인한 뒤 전체 앨범을 실행합니다.

보조 앱도 무료 Personal Team으로 서명하면 만료 시 같은 계정으로 재빌드해야 합니다. **복구 대기 기록이 있는 동안 보조 앱을 삭제·재설치하거나 데이터를 지우지 마세요.** 원본 확인 기록이 앱 안에 있습니다. 상세 안내는 [보조 앱 README](ExportBridge/README.md)에 있습니다.

## 4. 평소 실행과 중지

1. 아이폰을 USB로 연결하고 잠금을 풀어 둡니다. 작업 중 Mac과 아이폰이 잠들지 않도록 합니다.
2. 한국어 사진 앱에서 **대상 앨범의 사진 한 장을 크게 엽니다**. 편집 화면에서는 시작하지 않습니다.
3. Mac에서 **`사진 자동 캡처 시작.command`**를 더블클릭합니다. 터미널에 사진 총수·현재 순번·저장 경로·진행 상황이 표시됩니다.
4. 완료될 때까지 아이폰의 앱·앨범·정렬을 바꾸지 않습니다. 알림이 작업을 가리지 않도록 집중 모드를 사용하면 도움이 됩니다.

현재 사진부터 앨범 끝까지 처리한 다음 앞부분으로 돌아가 남은 사진을 처리합니다. 먼저 사진 정보 패널에서 원래 파일명을 읽습니다. 이름이 불명확하면 편집 전에 중단하며 임의로 이름을 만들지 않습니다. 확장자가 없는 사용자 지정 이름은 인식하지 못할 수 있습니다. 캡처 모드에서는 다음을 수행합니다.

1. **편집 → 도구 → 프레임 재설정**, 조작 준비 완료 확인
2. 중앙 `(201, 437)`에서 왼쪽 아래 45도 방향 `(5, 633)`까지 **1.5초 드래그**
3. 재생성 전 **전체 화면 PNG 캡처**
4. **프레임 재설정 → 최소 25초 대기 → 실제 생성 완료 확인 → 후 캡처**
5. 재설정 화면 **취소 → 편집 화면 취소**, 원래 사진 순번 확인
6. 가로 스와이프로 다음 사진으로 이동

드래그는 중앙에서 왼쪽 가장자리 안쪽까지 가능한 45도 이동입니다. **화면 전체 캡처**이므로 편집 UI도 포함됩니다. **캡처 모드**에서는 캡처 후 취소하며 **Save/완료를 누르지 않습니다**. 생성이 끝나지 않으면 25초가 지나도 캡처하지 않고 더 기다리며, 제한 시간을 넘으면 중단합니다.

**JPEG 모드**에서는 위 5번부터 **Save → 필요하면 완료 → JPEG 내보내기 → Mac에서 이미지·크기·SHA-256 확인 → PhotoKit으로 같은 사진 원본 복원 → 복원 검증 → 다음 사진** 순서로 진행합니다. JPEG는 최대 크기 편집 결과를 8비트 sRGB/품질 1.0으로 재인코딩하며 원본 HEIC/RAW의 바이트나 HDR·Live Photo 동영상은 보존하지 않습니다. 기존 편집이 있는 사진은 건너뛰고 기록합니다. 보관함 전체에서 원래 파일명이 중복되면 사진을 임의로 고르지 않고 중단합니다.

멈추려면 **`사진 자동 캡처 중지.command`**를 더블클릭합니다. 현재 요청이 끝난 후 다음 단계 전에 멈추므로 연결 준비나 생성 대기 중에는 즉시 종료되지 않을 수 있습니다. 터미널의 종료 결과를 확인하세요. 저장 전 초안이면 취소로 돌아갑니다. **JPEG 모드에서 이미 저장한 뒤 중단됐다면 아래 복구 절차를 사용**하고, JPEG 검증 전에 임의로 원본으로 복귀하지 마세요.

터미널에서도 실행할 수 있습니다.

```bash
npm run photos
```

중지는 별도 터미널에서 실행합니다.

```bash
npm run photos:stop
```

자동 실행이 끝나면 세션은 종료합니다. 로컬 Appium 서버는 다음 실행을 위해 대기 상태로 남을 수 있으며, 서버가 떠 있다는 것만으로 사진 처리가 진행 중인 것은 아닙니다.

### 결과와 재개

시작 파일을 실행할 때마다 **새 결과 폴더**가 생깁니다. 이전 실행을 자동으로 이어서 처리하지 않습니다.

```text
artifacts/photos-<실행 시각>/
  manifest.json
  IMG_1234-preview-capture.png
  IMG_1234-result-capture.png
  IMG_1234-result.jpg          # JPEG 모드에서만 생성
  IMG_5678-preview-capture.png
  IMG_5678-result-capture.png
  IMG_5678-result.jpg
  .metadata/                  # UI XML, 생성 시각, 내보내기 검증 기록
  failures/...
```

사진별 하위 폴더 없이 결과를 실행 폴더 바로 아래 저장합니다. 중복 이름·재시도는 `-photo-003`, `-attempt-02` 등을 붙여 덮어쓰지 않습니다. 이전 버전의 `photo-001/` 결과도 읽을 수 있으며 기존 6장의 폴더는 그대로 보존합니다. `manifest.json`은 사진별 상태·실제 경로·실패 이유를 기록합니다. 캡처·XML·로그에는 개인 정보가 포함될 수 있어 배포물에서 제외합니다.

**JPEG 저장 도중 중단:** `artifacts/pending-photo-edit.json`이 있으면 새 작업은 시작하지 않습니다. 아이폰에서 그 사진을 열고 실행합니다.

```bash
npm run photos:recover
```

필요한 서버·연결을 준비하고 이미 적용된 결과를 내보내서 검증한 뒤 원본 복원을 확인합니다. 다른 사진은 처리하지 않습니다. 검증 실패 시 기록을 유지합니다. 저장되지 않은 초안만 있었다면 원본 상태를 확인하고 그 사진을 완료로 표시하지 않습니다. 기록이나 결과 파일을 지워 복구 검사를 우회하지 마세요.

재개하려면 같은 앨범·정렬을 유지하고 편집을 취소해 사진 한 장을 연 화면으로 돌아오세요. 기존 실행이 끝난 것을 확인한 뒤 **그 결과 폴더의 `STOP` 파일만 제거**합니다. 서버가 실행 중인 상태에서 기존 폴더와 **원래의 총수·시작 순번**으로 실행합니다. 아래 `25`, `2`, 폴더 경로는 예시입니다.

```bash
npm run photos:connect
npm run photos:batch -- --run-dir artifacts/my-album-run --total 25 --start-index 2
npm run photos:disconnect
```

배치가 오류로 끝나도 별도로 `photos:disconnect`를 실행해 세션을 종료합니다. 이미 세션이 있다고 표시되면 기존 작업부터 확인하세요. 실행 중인 세션 파일을 임의로 삭제하지 않습니다.

기존 폴더의 검증된 완료 항목은 건너뜁니다. 새 환경에서 한 장만 점검하려면 배치 명령에 `--max-photos 1`을 추가하세요. 한 장 검사도 실제 아이폰을 조작합니다.

같은 실행 폴더 안에서 캡처 모드와 JPEG 모드를 바꾸지 않습니다. 완료 메시지는 처리 수·캡처 수·JPEG 수·기존 편집으로 건너뛴 수를 각각 표시합니다.

**범위 한계:** 화면의 사진 순번·총수를 사용하며 앨범/사진 고유 ID는 저장하지 않습니다. 개수가 같은 다른 앨범이나 순서 변경을 완전히 감지하지 못하므로 실행·재개 중 같은 앨범과 정렬을 유지해야 합니다.

## 5. 문제가 생기면

| 증상 | 확인할 내용 |
| --- | --- |
| 잠김/사용 불가 | 아이폰에서 암호로 잠금 해제, USB와 Mac 신뢰, Xcode Devices 준비 상태 확인 |
| 개발자 앱 신뢰 오류 | 아이폰 VPN 및 기기 관리에서 **서명한 본인 계정** 신뢰 및 온라인 앱 확인 |
| 계속 “확인 안 됨” | 아이폰 인터넷 확인 후 Wi-Fi/셀룰러를 바꿔 확인. 지속되면 정상 재시동 후 암호로 잠금 해제하고 재시도 |
| Xcode 코드 65 / 서명 실패 | `logs/appium.log`의 실제 Xcode 오류 확인. Team/Bundle ID, 프로필, 계정 로그인 확인 후 WDA에서 Test |
| 며칠 뒤 실행 불가 | Personal Team 프로필 만료 확인 후 같은 계정으로 재빌드·설치 |
| `npm ci` 후 서명 오류 | WDA의 자동 서명, Team, Bundle ID 재확인 |
| XCUITest 드라이버를 못 찾음 | 이 폴더에서 `npm ci`를 했는지 확인. 다른 환경의 `APPIUM_HOME`이 지정돼 있으면 사용할 터미널에서 `unset APPIUM_HOME` 후 실행 |
| Node를 못 찾음 / 버전 오류 | `node --version` 확인. 더블클릭은 `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`도 검색. 버전 관리자로만 설치했다면 Node 22 환경의 터미널에서 `npm run photos` |
| 실행 권한 없음 | 이 폴더에서 `chmod +x "사진 자동 캡처 시작.command" "사진 자동 캡처 중지.command"`. macOS 차단은 출처 확인 후 개별 파일 열기 안내를 따름 |
| 크기/UI 불일치 | 한국어·세로 방향·402 × 874 확인. 다른 기기/UI는 좌표와 상태 인식 수정·검증 필요 |
| 경고/사진 수 변화/앱 이탈 | `manifest.json`과 오류 증거 확인. 원인을 해결하고 원래 사진 화면으로 복귀한 뒤 재개 |
| 이미 실행 중 / 세션 존재 | 기존 터미널과 작업 PID 확인. 중지 완료 전에 잠금/세션 파일을 지우지 않음 |

검증 기기에서는 신뢰 후에도 확인되지 않았고, Mac Console의 해당 아이폰 `online-auth-agent` 로그에 `Failed to copy attestation key`, `Failed to copy system key (2)`가 있었습니다. 정상 재시동과 암호 잠금 해제 후 연결에 성공했습니다. 이는 관찰한 복구 사례이며 모든 오류의 원인이 같다는 뜻은 아닙니다.

첫 WDA 빌드·서명은 시간이 걸릴 수 있습니다. 연결 요청은 최대 600초를 기다리며 자동 재시도하지 않습니다. 실패 후에는 로그와 이전 빌드 종료 여부를 확인하세요. 원인 확인 없이 인증서를 폐기하거나 기기를 초기화할 필요는 없습니다.

## 6. 다른 사람에게 배포하기

이 폴더에서 다음을 실행하면 필요한 파일만 담은 ZIP과 SHA-256 검증 파일을 만듭니다. 아이폰에는 연결하지 않습니다.

```bash
npm run release:zip
```

```text
dist/
  iphone-photos-automation-0.2.0.zip
  iphone-photos-automation-0.2.0.zip.sha256
```

ZIP에는 문서, 빈 `.env.example`, 실행 스크립트, 보조 앱 소스/Xcode 프로젝트, 오프라인 테스트, `package.json`, `package-lock.json`을 포함합니다. **`.env`, 실제 기기 ID·계정 정보·인증서·개인키·프로비저닝 프로필, 캡처, 로그, `node_modules`, `DerivedData`는 제외**합니다. 명시한 파일 목록만 압축하며, 소스에 개인 값을 새로 넣었다면 공유 전 다시 확인하세요.

받는 사람은 압축을 풀고 **3번 설치 절차**부터 진행합니다. 본인의 Mac에서 WDA를 준비하고, 본인 계정으로 서명해 본인 아이폰에 설치한 뒤 **4번 실행 절차**를 사용합니다. 다른 사람에게 계정 비밀번호나 서명 인증서를 전달하지 않습니다.

의존성은 `npm ci`로 내려받으며 각 프로젝트의 라이선스를 따릅니다. WDA의 출처와 라이선스는 [공식 저장소](https://github.com/appium/WebDriverAgent), [LICENSE](https://github.com/appium/WebDriverAgent/blob/master/LICENSE)에서 확인할 수 있습니다. 의존성 원본이나 서명된 WDA 바이너리는 이 ZIP에 동봉하지 않습니다.
