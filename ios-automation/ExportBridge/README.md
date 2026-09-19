# Photos Export Bridge

Mac의 Appium 자동화에 사진 파일 읽기·JPEG 내보내기·원본 복원 기능을 제공하는 독립 iOS 앱이다. 기존 MacGyver Xcode 프로젝트와 별개다. **2026-09-19 실기기 서명 빌드·설치와 한 장의 JPEG 저장·원본 복원을 검증했다.** 같은 asset의 원본/현재 이미지 해시가 실행 전과 일치하고 편집이 없음을 확인했다. 전체 앨범 처리와 강제 중단 후 복구의 실기기 검증은 아직이다.

Xcode에서 `PhotosExportBridge.xcodeproj`를 열어 `PhotosExportBridge` 타깃에 본인 Team과 고유 Bundle Identifier를 지정한다. 앱을 설치하고 화면의 `사진 접근 권한 설정`을 눌러 전체 사진 접근을 허용해야 한다. 제한된 사진 접근은 동명이인 사진을 놓칠 수 있어 처리하지 않는다. 앱이 권한 요청을 자동으로 승인하거나 Mac이 요청할 때 권한 팝업을 자동으로 열지는 않는다.

## USB 요청과 응답

Mac은 Appium `mobile: pushFile`로 `@설정한번들ID:documents/request.json`을 쓰고 앱을 전면으로 전환한다. 앱은 전면에서 한 번에 한 요청만 처리한다. 응답은 `@설정한번들ID:documents/<id>-response.json`으로 읽는다. 요청 ID는 새 UUID 문자열이어야 하며, 이미 응답 파일이 있는 ID는 다시 실행하지 않는다. 실패를 고친 뒤 다시 시도할 때는 새 ID를 쓴다.

```json
{"id":"UUID","action":"inspect","filename":"IMG_1234.HEIC"}
```

`inspect`는 확장자를 생략한 `IMG_1234`도 받으며 대소문자와 유니코드 정규화를 적용한다. 전체 사진에서 일치하는 이미지가 반드시 하나여야 한다. 정보 패널에서 읽은 다음 `selection`을 함께 보내면 기기 현지 Gregorian 촬영 시각(분 단위)과 가로·세로 픽셀 수가 모두 일치하는 후보만 남긴다. 후보가 없거나 여러 장이면 중단하고 조건을 완화하지 않는다. 응답의 `selection`도 요청과 일치해야 한다.

```json
{"creationLocal":{"year":2024,"month":2,"day":29,"hour":20,"minute":51},"width":4032,"height":3024}
```

원본 `.photo` 리소스의 파일명을 반환하고, 기존 편집이 없는 사진만 내부 초기 상태 기록에 등록한다. 기존 편집 사진은 `hasAdjustments: true`로 알리므로 Mac이 건너뛰어야 한다.

복구용 `inspect` 요청에는 `preserveBaseline: true`, 기존 `assetId`, `baselineOriginalSHA256`을 함께 넣어 같은 사진을 조회하고 기존 초기 해시·내보내기·복원 기록을 유지한다. asset ID와 해시는 함께 있어야 하며 보조 앱의 초기 기록까지 일치해야 한다. 편집으로 크기가 달라질 수 있으므로 복구 조회에는 초기 `selection`을 보내지 않는다. 일반적인 새 작업의 `inspect`와 구분한다.

```json
{
  "id":"새 UUID", "action":"export",
  "assetId":"inspect 응답의 assetId",
  "expectedOriginalFilename":"inspect 응답의 originalFilename",
  "baselineOriginalSHA256":"inspect 응답의 originalSHA256"
}
```

`export`는 처음에 미편집 상태였고 현재 편집이 적용된 동일 사진만 허용한다. PhotoKit `.current`의 최대 크기 이미지를 방향 정규화 후 **8비트 sRGB JPEG, 품질 1.0**으로 인코딩한다. 픽셀 크기를 줄이지 않지만 HDR/RAW 데이터, Live Photo 동영상, 편집 이력이나 원본 메타데이터 보존 기능은 아니다. 생성 파일은 `<id>-result.jpg`다.

```json
{
  "id":"또 다른 UUID", "action":"revert",
  "assetId":"inspect 응답의 assetId",
  "expectedOriginalFilename":"inspect 응답의 originalFilename",
  "baselineOriginalSHA256":"inspect 응답의 originalSHA256",
  "verifiedExportSHA256":"Mac에서 디코딩 및 해시 검증한 export 응답의 sha256"
}
```

`revert`는 마지막 내보내기 영수증과 `verifiedExportSHA256`이 일치해야 실행한다. Mac은 파일을 완전히 복사·디코딩하고 SHA-256을 검증하기 전 이 요청을 보내면 안 된다. 앱은 실제 Mac 검증 동작을 볼 수 없으므로 이 필드는 Mac 클라이언트의 검증 완료 선언이다.

원본 복원은 초기 원본 해시와 동일 사진 여부, 현재 이미지가 내보내기 이후 변경되지 않았는지 확인한 뒤 실행한다. 필요한 원본 리소스를 다운로드하고 복원 요청 직전 상태를 다시 검사한다. 복원 후 편집 없음, 원본 해시, 실행 전 `.current` 데이터 해시까지 일치해야 `restored: true`를 반환한다. 초기 해시·내보내기 영수증·복원 요청 기록은 `Application Support/export-ledger.json`에 원자적으로 저장한다.

## 응답 형식

모든 응답은 `id`, `ok`를 포함한다. 실패는 `ok: false`, `error`를 포함하며 완료되지 않은 작업을 성공으로 표시하지 않는다. 유효하지 않은 요청 ID는 경로로 사용하지 않고 `invalid-request-response.json`에 오류를 쓴다.

| 동작 | 성공 응답의 주요 필드 |
| --- | --- |
| `inspect` | `assetId`, `originalFilename`, `hasAdjustments`, `originalSHA256`, `currentSHA256`, `width`, `height` |
| `export` | 위 식별·해시 필드, `hasAdjustments: true`, `outputFile`, `sha256`, `bytes`, `width`, `height` |
| `revert` | 식별·해시 필드, `hasAdjustments: false`, `restored: true` |

`originalSHA256`은 `.original` 요청 데이터, `currentSHA256`은 `.current` 요청 데이터, `sha256`은 인코딩된 JPEG의 해시다. 서로 다른 형식일 수 있으므로 세 값을 서로 같다고 가정하지 않는다. 복원 후 `currentSHA256`은 **처음 inspect 응답의 currentSHA256**과 비교한다.

PhotoKit 이미지/리소스 다운로드 요청은 각각 180초 제한이며 iCloud 다운로드를 허용한다. Mac 클라이언트도 충분한 대기 시간과 미완료 작업 복구 기록을 유지해야 한다. 복원 중 종료된 경우 같은 사진의 새 `revert` 요청으로 실제 상태를 재검증할 수 있다. 앱 내부 기록을 지우거나 앱을 재설치하면 이 복구용 초기 기록을 잃으므로 미완료 작업이 있는 동안 재설치하지 않는다.

## 빌드 확인

`ios-automation` 폴더에서 실행한다. 아래 명령은 아이폰에 설치하거나 시뮬레이터를 실행하지 않는다.

```sh
xcodebuild -project ExportBridge/PhotosExportBridge.xcodeproj \
  -scheme PhotosExportBridge -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath DerivedData/ExportBridgeSimulator \
  CODE_SIGNING_ALLOWED=NO build
```

현재 빌드 기준은 Xcode 27.0, iOS Simulator 27 SDK, arm64와 x86_64이며 최소 배포 대상은 iOS 17이다. Reframe 조작 자체는 이 앱이 아닌 iOS 27 사진 앱과 Mac 스크립트에서 수행한다.
