# 편집 결과 JPEG 저장과 원본 복원

## 구현 상태

0.2.1에는 평면 캡처 저장, PhotoKit 보조 앱, USB JPEG 전송·검증, 원본 복원 및 중단 복구 코드가 들어 있다. **2026-09-19 실제 아이폰에서 한 장의 식별 → 편집/재생성 → PNG 2개·JPEG 1개 저장 → 원본 복원을 통과했다.** JPEG 2592 × 1936 픽셀의 전체 디코딩·해시·바이트 수, 복원 후 같은 asset의 원본/현재 이미지 해시 일치와 편집 없음, 사진 뷰어 복귀, 미완료 복구 기록 없음을 확인했다. 오프라인 테스트 67개와 실기기 서명 빌드·설치도 통과했다. 전체 앨범 처리와 강제 중단 후 실기기 복구는 아직이다.

기본 설정은 캡처 후 취소다. [README의 보조 앱 설치](README.md#3-6-실제-jpeg-파일-저장용-보조-앱)를 마치고 `.env`에 `IOS_EXPORT_BUNDLE_ID`를 입력하면 JPEG 모드를 사용한다. 별도 보조 앱은 [ExportBridge](ExportBridge/README.md)에 있다.

## 출력 파일

```text
photos-시작날짜-시간/
  IMG_1234-preview-capture.png
  IMG_1234-result-capture.png
  IMG_1234-result.jpg
  manifest.json
  .metadata/
```

PNG는 편집 UI를 포함한 화면 캡처이고, JPEG는 편집이 반영된 실제 이미지다. 원래 파일명에서 확장자를 뺀 이름을 사용하며 충돌·재시도에는 순번 접미사를 붙인다. 사진별 결과 폴더는 만들지 않는다. 과거 폴더 방식의 결과도 읽을 수 있다.

JPEG는 PhotoKit `.current`의 최대 크기 데이터를 방향에 맞춰 **8비트 sRGB / JPEG 품질 1.0**으로 재인코딩한다. 픽셀 크기를 임의로 줄이지 않지만 HEIC/RAW 원본 바이트·HDR·Live Photo 동영상·편집 이력·원본 메타데이터 전체를 보존하지는 않는다. Reframe 결과의 픽셀 수가 편집 전과 같다고 가정하지 않는다. [Apple 이미지 요청 API](https://developer.apple.com/documentation/photos/phimagemanager/requestimagedataandorientation%28for%3Aoptions%3Aresulthandler%3A%29?language=objc)

## 처리 순서

1. Photos 정보 화면에서 원래 파일명을 읽는다. 인식할 수 없거나 여러 후보가 있으면 편집 전에 중단한다.
2. 보조 앱이 전체 사진 보관함에서 원래 파일명과, 읽을 수 있는 경우 정보 패널의 촬영일시·픽셀 크기가 모두 일치하는 **단 한 장**을 찾고 asset ID, 원본 해시, 편집 전 현재 이미지 해시와 편집 여부를 기록한다. 확장자가 숨겨진 카메라 이름도 지원한다.
3. 이미 편집된 사진은 건너뛴다. 미편집 사진만 Reframe 드래그·생성을 수행하고 PNG 두 장을 저장한다.
4. Mac에 `pending-photo-edit.json`을 먼저 기록한 뒤 **Save → 필요한 경우 완료**로 결과를 사진에 적용한다.
5. 보조 앱이 같은 asset ID의 편집된 `.current` 데이터를 JPEG로 만들어 `Documents/<요청UUID>-result.jpg`에 저장한다.
6. Mac이 USB/Appium `mobile: pullFile`로 가져와 JPEG 형식, 전체 이미지 디코딩, 픽셀 크기, 바이트 수·SHA-256을 검증한 뒤 `<원래이름>-result.jpg`로 확정한다. 기존 파일은 덮어쓰지 않는다.
7. 검증된 JPEG 해시를 포함한 복원 요청을 보낸다. 보조 앱은 원본 해시와 내보내기 이후 추가 편집 여부를 다시 확인하고 PhotoKit으로 같은 asset을 원본으로 복귀시킨다.
8. 편집 없음, 원본 해시, 편집 전 현재 이미지 해시, 사진 뷰어의 순번·총수를 확인하고 복구 기록을 정리한다. 그 뒤 다음 사진으로 이동한다.

보조 앱은 파일 공유가 가능한 Documents를 제공하며, Appium은 해당 앱의 Documents를 USB로 읽는다. 사진 앱 내부의 비공개 파일 경로를 추측하지 않는다. [Appium 파일 전송](https://appium.github.io/appium-xcuitest-driver/latest/guides/file-transfer/)

## 사진 식별과 기존 편집

화면 파일명은 PhotoKit의 `PHAssetResource.originalFilename`과 연결한다. 정보 패널에 촬영일시와 픽셀 크기가 있으면 기기의 현지 Gregorian 시각을 분 단위로 대조하고 가로·세로 픽셀 수도 정확히 비교한다. 모든 조건에 맞는 후보가 단 한 장이어야 하며, 없거나 여러 장이면 중단한다. 날짜·크기를 읽을 수 없으면 파일명 자체가 고유해야 한다. 제한된 사진 접근에서 중복을 놓치지 않도록 전체 접근을 요구한다. [Apple 원본 파일명](https://developer.apple.com/documentation/photos/phassetresource/originalfilename)

처음 대응시킨 뒤에는 **asset ID와 원본 해시**를 사용한다. 복구 시에는 저장된 asset ID·원본 해시로 동일 사진을 다시 조회하고 보조 앱의 초기 기록까지 대조한다. 편집으로 달라질 수 있는 픽셀 크기를 복구 대상 선택에 다시 사용하지 않는다.

**“원본으로 복귀”는 기존 편집 전체를 제거한다.** 그래서 현재 구현은 미편집 사진만 처리하고 기존 편집은 `skipped-existing-edits`로 기록한다. PhotoKit의 편집 상태와 adjustment 리소스를 확인한다. [Apple 복원 API](https://developer.apple.com/documentation/photos/phassetchangerequest/revertassetcontenttooriginal%28%29?language=objc)

저장 후 Reframe의 Reset을 사용하는 경로도 있지만, 이전 Reframe 상태까지 보존하는지 검증하지 않았으므로 기존 편집 보호를 우회하는 수단으로 쓰지 않는다. [Apple Reframe 안내](https://support.apple.com/en-ca/guide/iphone/xy0grrlxue5w/ios)

## 중단과 복구

Mac은 `artifacts/pending-photo-edit.json`에 저장 전부터 `saving → saved → exported → restored`를 기록한다. `exported`는 Mac JPEG 검증을 마친 상태다. 보조 앱도 초기 해시·내보내기 영수증·복원 요청 기록을 앱 안에 남긴다. 응답 UUID를 확인하며 타임아웃으로 결과가 불명확한 저장·복원 명령을 자동 재시도하지 않는다.

미복원 기록이 있으면 새 작업은 시작하지 않는다. 아이폰에서 기록된 사진을 열고 실행한다.

```bash
npm run photos:recover
```

복구는 사진의 실제 상태와 원본 식별자를 확인한다. 이미 적용된 결과가 남으면 JPEG를 먼저 내보내고 검증한 후 복원한다. 복원이 끝났지만 응답만 유실된 경우 기존 영수증으로 보조 앱의 복원 검증을 마친다. 저장되지 않은 초안은 사용자가 취소한 뒤 원본 상태를 확인하며, 없는 JPEG를 생성 완료로 기록하지 않는다. 복구 명령은 다음 사진으로 넘어가지 않는다.

파일이 손상됐거나 식별자가 다르거나 내보내기 이후 사진이 추가로 편집됐으면 기록을 보존하고 중단한다. **복구 전 보조 앱을 삭제하거나 데이터를 지우지 않는다.** iCloud 자료가 필요하면 PhotoKit이 다운로드하므로 연결 상태와 대기 시간이 영향을 준다.

## 실기기 검증 시 확인할 항목

- 시험 사진 한 장에서 PNG 2개·JPEG 1개를 얻고 JPEG가 리프레임 결과와 일치하는지 확인한다.
- 복원 후 같은 사진이 실행 전 상태인지 확인한다.
- 기존 편집 사진은 건너뛰고, 촬영일시·크기까지 중복된 사진은 중단하는지 확인한다. 파일명만으로 중복된 후보를 차단하고 추가 정보로 고유한 한 장을 식별하는 흐름은 실기기에서 확인했다.
- 저장 직후, 전송 중, Mac 검증 후, 복원 직후 중단한 기록을 복구한다.
- 전체 앨범 검증 전에는 위 한 장 검사를 먼저 수행한다.
