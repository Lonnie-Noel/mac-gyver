# mac-gyver: 맥과 아이폰 설정

아이폰 없이 UI를 먼저 확인하려면 Python을 준비한 뒤 `Demo.command`를 실행하세요. 실제 아이폰 연결에는 아래의 Xcode·Appium·WDA 설정도 필요합니다.

## 1. 맥 준비

| 구성 | 필요한 설정 |
| --- | --- |
| Python | 3.11~3.14, Python 3.12 또는 3.13 권장 |
| Xcode | 사용 중인 아이폰 iOS의 SDK를 포함하는 Xcode 전체 설치 |
| Node.js | `^20.19.0`, `^22.12.0` 또는 `>=24.0.0`, npm 10 이상 |
| USB | 데이터 전송 가능한 케이블, 잠금을 해제한 아이폰 |
| Apple 서명 | Xcode에 등록한 Apple 계정과 기기에 설치 가능한 WDA 서명 프로필 |

Python은 [python.org macOS 설치 프로그램](https://www.python.org/downloads/macos/) 또는 기존 개발 환경을 사용합니다. Finder에서 Homebrew Python을 찾을 수 있도록 실행 스크립트는 `/opt/homebrew/bin`과 `/usr/local/bin`을 확인합니다. 다른 위치의 Python을 쓰려면 터미널에서 다음처럼 지정할 수 있습니다.

```bash
MAC_GYVER_PYTHON="/원하는/경로/python3" bash Start.command
```

`.venv`가 이미 있으면 해당 Python을 재사용합니다. 프로젝트를 다른 위치로 옮겨 가상환경이 깨졌다면 `.venv` 폴더를 다른 이름으로 옮기고 다시 실행하세요. 시나리오나 결과를 지울 필요는 없습니다.

Xcode를 한 번 열어 추가 구성요소 설치와 사용권 계약을 완료합니다. Xcode Settings → Locations → Command Line Tools에서 사용할 Xcode를 선택하고 확인합니다.

```bash
xcode-select -p
xcodebuild -version
```

출력이 `/Library/Developer/CommandLineTools`만 가리킨다면 전체 Xcode를 선택해야 합니다. iOS와 Xcode 지원 범위는 [Apple Xcode 지원표](https://developer.apple.com/support/xcode/) 및 [XCUITest 호환성 표](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/system-requirements/)에서 실제 버전에 맞춰 확인합니다. 여기서 특정 iOS 조합의 실기기 호환성을 검증했다고 주장하지 않습니다.

Appium의 Node/npm 요구사항은 [공식 시스템 요구사항](https://appium.io/docs/en/latest/quickstart/requirements/)을 따릅니다. 프로젝트 스크립트는 Appium **3.7.0**, XCUITest Driver **12.12.4**를 사용하며, `.tools/`에만 설치합니다. 첫 설치 시 하위 의존성을 해석한 npm lockfile도 해당 로컬 폴더에 생성됩니다. 완전한 macOS 환경 잠금 파일은 아닙니다.

## 2. 아이폰 준비

1. USB로 연결한 아이폰을 잠금 해제하고 **이 컴퓨터를 신뢰**를 허용합니다.
2. Xcode → Window → Devices and Simulators에서 아이폰이 표시되는지 확인합니다. 준비 작업이 완료될 때까지 기다립니다.
3. iOS 16 이상에서 설정 → 개인정보 보호 및 보안 → **개발자 모드**를 켭니다. 재부팅 후 기기에서 활성화를 확인합니다.
4. 설정 → 개발자 → **UI Automation 활성화**를 켭니다.
5. 설정 → 손쉬운 사용 → 확대/축소의 시스템 확대 기능은 꺼 둡니다. 사진 안의 확대 기능과 별개이며, 시스템 확대는 좌표 판정을 바꿀 수 있습니다.

메뉴 이름은 iOS 언어·버전에 따라 달라질 수 있습니다. [Appium 기기 준비 문서](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/device-setup/)

사진 앱에서 테스트하려면 서로 구별되는 정지 사진을 최소 3장 내려받아 전용 앨범에 둡니다. 아이폰을 손으로 조작해 시작 사진을 준비했다면 맥 앱의 화면 새로고침 후 기록합니다. 앱 열기 명령만으로 매번 같은 앨범에 들어가지는 않습니다.

## 3. Appium과 WDA 준비

저장소 폴더의 터미널에서:

```bash
bash scripts/start_appium.sh --install-only
bash scripts/start_appium.sh --doctor
```

`--doctor`는 XCUITest 자체 진단입니다. 처음에는 Node 패키지를 내려받을 수 있습니다. 글로벌 Appium이나 다른 프로젝트의 드라이버는 사용하지 않습니다.

### WDA 서명

WDA는 아이폰에서 테스트 명령을 수행하는 XCTest 앱입니다. mac-gyver가 Apple 계정의 비밀번호나 인증서를 받지 않습니다. Xcode에서 계정과 서명을 설정합니다.

1. Xcode → Settings → Accounts에 Apple 계정을 추가합니다.
2. 다음 명령으로 설치된 드라이버의 WDA 프로젝트를 엽니다.

   ```bash
   bash scripts/start_appium.sh --open-wda
   ```

3. `WebDriverAgentRunner` 타깃의 Signing & Capabilities에서 Team을 선택합니다. Automatic Signing을 사용하고 본인 팀이 서명할 수 있는 고유 Bundle Identifier를 지정합니다. 예: `com.yourname.macgyver.WebDriverAgentRunner`.
4. 실행 목적지를 연결한 아이폰으로 선택합니다. `WebDriverAgentRunner` scheme에서 **Product → Test**로 한 번 빌드·실행해 서명과 기기 신뢰 문제를 확인합니다.
5. 기기가 개발자 앱 신뢰를 요구하면 아이폰 설정 → 일반 → VPN 및 기기 관리에서 해당 개발자를 확인한 뒤 신뢰합니다. 메뉴는 해당 프로필 설치 후에만 나타날 수 있습니다.
6. 수동 테스트를 중지한 뒤 mac-gyver에 연결 정보를 입력합니다. 일반 경로에서는 Appium이 WDA를 빌드하고 실행합니다.

Team ID는 해당 Apple 개발 팀의 식별자입니다. WDA Bundle ID는 위에서 서명한 값과 일치시킵니다. 기본 설정인 `use_preinstalled_wda: false`를 유지하면 Appium이 WDA 빌드·설치 과정을 관리합니다. 사전 설치 WDA 사용은 해당 기기에서 호환되는 WDA를 준비한 경우에만 선택합니다. 개인 무료 팀은 프로비저닝·기능·유효기간 제한 때문에 추가 수동 설정이 필요할 수 있습니다. [자동 서명 구성](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/auto-config/), [수동 구성](https://appium.github.io/appium-xcuitest-driver/latest/getting-started/provisioning-profile/basic-manual-config/)

## 4. 서버를 켜고 연결

```bash
bash scripts/start_appium.sh
```

`http://127.0.0.1:4723`에서 서버를 실행합니다. 이 터미널을 켜 둔 상태에서 `Start.command`를 실행합니다. 서버를 끝내려면 해당 터미널에서 Ctrl+C를 누릅니다.

앱의 연결 설정에서 다음 값을 입력합니다.

| 필드 | 입력값 |
| --- | --- |
| 서버 URL | `http://127.0.0.1:4723` |
| UDID | Xcode Devices and Simulators에 표시되는 연결 아이폰 Identifier |
| iOS 버전 | 필요하면 기기의 실제 버전 지정, 빈 값이면 드라이버에 맡김 |
| 대상 앱 Bundle ID | 기본 사진 앱: `com.apple.mobileslideshow` |
| Team ID | 서명할 Apple 개발 팀 ID |
| WDA Bundle ID | Xcode에서 서명 가능한 것으로 준비한 WDA ID |
| 사전 설치 WDA | 첫 연결에서는 끔 |

JSON 설정을 쓰려면 `examples/device_config.example.json`을 저장소 루트의 `device_config.json`으로 복사하고 placeholder를 실제 값으로 수정합니다. 이 설정은 시나리오와 다른 파일입니다.

```bash
bash Start.command --config device_config.json
```

첫 연결은 WDA 빌드·설치 때문에 시간이 걸립니다. 화면 캡처가 보이고 새로고침이 되는지 확인한 뒤 사진 앱 조작을 시작합니다.

## 5. 첫 시나리오 기록

1. 사진 앱을 열고 원하는 테스트 앨범 화면을 준비합니다.
2. 기록 시작 후 `탭` 도구로 사진을 클릭합니다.
3. `스와이프` 도구로 왼쪽으로 한 번, 오른쪽으로 한 번 드래그합니다.
4. 기록 종료 후 이동 시간은 300ms, 각 동작 후 대기는 1000ms로 편집합니다.
5. 기본값인 `기록 시작 화면을 재생 전 검사`를 사용한다면, 아이폰을 처음 기록한 앨범 화면으로 되돌리고 `화면 새로고침`을 누릅니다.
6. `전체 실행`을 한 번 눌러 사진 A → B → A가 실제로 보이는지 확인합니다.
7. `요소 읽기` 후 요소를 선택하거나 `이미지 영역 검사` 도구로 미리보기의 비교할 영역을 드래그해 검사를 넣습니다. 기준 이미지는 시나리오 저장 시 같은 위치의 `<시나리오이름>.assets` 폴더로 복사되므로 JSON과 함께 옮깁니다.
8. 좌우 스와이프 구간을 선택해 `반복으로 묶기`를 누르고, 한 번 검증한 다음 횟수를 늘립니다.

마우스 속도와 관계없이 이동 시간을 지정하려면 `마우스 이동 시간을 자동으로 기록`을 끄고 우측 `이동 (ms)` 값을 설정합니다. 기존 단계는 목록에서 더블클릭해 수정하고, 여러 단계의 대기는 `선택 단계의 후 대기 일괄 변경`으로 바꿀 수 있습니다.

기록하는 시간은 맥 앱에서 입력 가능한 상태가 된 뒤 사용자가 기다린 시간입니다. 아이폰 본체에서 직접 한 동작이나 실제 터치 지연을 기록하는 기능은 없습니다. 이미지 비교는 지정한 영역의 평균 RGB 차이를 계산합니다. 화면이 변했다는 것만으로 사진 B가 맞다고 증명하지 않으므로 기준·영역·허용치를 직접 검증하세요.

## 6. 오류가 나면

| 증상 | 확인할 내용 |
| --- | --- |
| `.command` 실행 권한 오류 | 저장소 폴더에서 `bash Start.command` 또는 `bash Demo.command` 실행 |
| Python을 찾지 못함 | Python 3.11~3.14 설치와 `MAC_GYVER_PYTHON` 경로 확인 |
| pip SSL 오류 | python.org Python을 쓴다면 해당 설치 폴더의 `Install Certificates.command` 실행 후 재시도; TLS 검증을 끄지 않음 |
| Qt 또는 동적 라이브러리 로딩 실패 | Python·PySide6 wheel의 macOS/CPU 지원 범위를 확인; Apple Silicon에서는 native Python 권장 |
| Node/npm 버전 오류 | 요구되는 Node 및 npm 조합 설치 후 서버 스크립트 다시 실행 |
| 서버 연결 거부 | Appium 터미널을 유지하고 URL·포트 확인; 기본 경로는 `/`, `/wd/hub`가 아님 |
| 4723 포트 사용 중 | 다른 Appium 서버가 실행 중인지 확인하고 자신이 실행한 서버를 정리 |
| 기기를 못 찾음 | USB 데이터 케이블·신뢰·잠금 해제·Xcode Devices 목록·UDID 확인 |
| WDA 서명 / xcodebuild 65 | Appium 로그와 Xcode의 Team·Bundle ID·프로비저닝·개발자 신뢰 확인 |
| 요소를 못 찾음 | 미리보기 새로고침과 요소 검사기로 현재 접근성 속성 확인; 언어·iOS UI 차이를 반영 |
| 좌표 조건 불일치 | 기록 때와 화면 방향·크기를 맞춘 뒤 다시 기록 |
| 시작 화면 검사 실패 | 기록을 시작했던 앨범·사진 화면으로 되돌리고 화면 새로고침; `precondition`은 준비 단계보다 먼저 검사 |
| 중단이 바로 반응하지 않음 | 이미 전달한 XCTest 명령이 끝나거나 통신 제한 시간에 도달할 때까지 기다릴 수 있음 |

환경 진단:

```bash
bash scripts/doctor.command
```

이 명령은 모든 Apple 설정이나 실제 터치 성공을 자동으로 확인할 수 없습니다. 개발자 모드·서명 등 직접 확인해야 하는 항목은 별도로 표시합니다.

## 7. 실기기 수동 검증 기록

다음 표의 결과를 사용자 환경에서 채웁니다. **현재 모두 미검증**이며, 데모 성공으로 대체하지 않습니다.

환경: Mac 모델/CPU ___ · macOS ___ · Xcode ___ · iPhone 모델 ___ · iOS ___ · Appium ___ · XCUITest ___

| 확인 항목 | 통과 기준 | 결과 |
| --- | --- | --- |
| 연결·화면 | 실제 기기 화면과 미리보기가 일치 | 미검증 |
| 사진 왕복 1회 → 20회 | A → B → A와 각 회차 검사 조건 충족 | 미검증 |
| 확대·축소 | 대상 화면이 제스처를 실제로 처리 | 미검증 |
| 길게 누르기·드래그 | 기대 UI와 시간 설정에 맞는 동작 | 미검증 |
| 두 손가락 회전 | 회전을 지원하는 대상 화면에서 동작 확인 | 미검증 |
| 없는 요소 기다리기 | 제한 시간 후 실패 기록, 다음 제스처 중단 | 미검증 |
| 대기 중 일시정지·중단 | 이후 새 기기 명령을 보내지 않음 | 미검증 |
| USB 연결 해제 | 실행 오류와 가능한 화면 캡처, 종료 처리 | 미검증 |
| 저장·종료·다시 열기 | 시나리오와 기준 이미지 경로 유지 | 미검증 |
| `.app` 빌드·실행 | Finder 실행, 저장·보고서·데모 동작 확인 | 미검증 |
