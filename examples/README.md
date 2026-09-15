# 시나리오 예제

| 파일 | 용도 | 실행 전 할 일 |
| --- | --- | --- |
| [demo_roundtrip.json](demo_roundtrip.json) | 모의 사진 앱에서 왕복·검사·캡처 3회 | 데모 모드로 연결 |
| [photos_roundtrip.example.json](photos_roundtrip.example.json) | 실제 사진 앱에서 좌우 왕복 1회 | 테스트 앨범과 사진 선택 좌표를 직접 기록·보정 |
| [gestures.example.json](gestures.example.json) | 누름·확대/축소·회전·드래그의 매개변수 예시 | 원하는 단계만 남기고 각 동작의 시작 화면을 준비 |
| [device_config.example.json](device_config.example.json) | Appium 연결·WDA 서명 설정 | 별도의 `device_config.json`으로 복사 후 placeholder 변경 |

기기 설정 JSON은 시나리오가 아닙니다. GUI의 시나리오 열기에 넣지 말고 `--config` 옵션 또는 연결 설정에 사용합니다.

## 데모 실행

```bash
.venv/bin/python -m mac_gyver --demo --run examples/demo_roundtrip.json --output reports
```

이 예제의 `photo-0`, `photo-viewer`, `current-photo-0` 등은 **모의 기기 전용 접근성 이름**입니다. 실제 iOS 사진 앱의 식별자로 가정하지 않습니다. 데모는 모의 화면과 상태만 검증하며, 아이폰의 사진 전환이나 속도를 검증하지 않습니다.

## 실기기 사진 왕복

사진 앱을 열고 테스트 앨범에 들어가 좌표를 직접 기록합니다. 예제의 탭 `(0.25, 0.35)`는 첫 실행 전에 보정해야 하는 임시 값입니다. 예제에서 앱을 활성화해도 특정 앨범·사진으로 초기화되지는 않습니다.

```bash
.venv/bin/python -m mac_gyver --config device_config.json --run examples/photos_roundtrip.example.json --output reports
```

이 예제에는 결과 검사가 없으므로 명령을 모두 실행해도 **검사 없음**입니다. 사진 A와 B를 식별할 요소 또는 기준 이미지 검사를 추가한 뒤 횟수를 늘립니다. 최초 반복 횟수는 1이며, 검증 후 20회 등으로 변경합니다.

## JSON 필드

| 필드 | 의미 |
| --- | --- |
| `schema_version` | 현재 `1` |
| `name` | 시나리오 이름 |
| `app_profile` | 기본 `photos`; 다른 앱은 연결의 Bundle ID 또는 단계의 `bundle_id`를 지정 |
| `device_profile` | 선택 사항, 사용자가 붙인 프로필 이름 |
| `geometry` | 선택 사항, 기록 화면의 `width`, `height`, `orientation` |
| `precondition` | 선택 사항, 시작 화면 확인에 사용할 검사 단계 |
| `setup` | 본 테스트 전에 한 번 실행할 준비 단계 |
| `steps` | 실행할 단계 목록 |
| `on_failure` | 현재 `stop`만 지원 |

좌표는 화면 내부의 비율이며 `x`, `y`는 0~1입니다. 요소를 사용할 때는 다음처럼 기록합니다.

```json
{
  "type": "wait_element",
  "target": {"mode": "element", "by": "accessibility_id", "value": "실제 요소 식별자"},
  "state": "visible",
  "timeout_ms": 5000,
  "poll_interval_ms": 200
}
```

`by`는 `accessibility_id`, `predicate`, `class_chain`, `xpath`를 지원합니다. `state`는 `visible` 또는 `absent`입니다. 제한 시간 없이 기다리거나 JSON에서 임의 코드를 실행하는 기능은 없습니다.

기준 이미지 검사는 시나리오가 있는 폴더 아래에 PNG를 저장한 뒤 추가합니다.

```json
{
  "type": "assert_image",
  "name": "사진 A 복귀 확인",
  "baseline": "baselines/photo_a.png",
  "region": {"x": 0.05, "y": 0.15, "width": 0.9, "height": 0.7},
  "tolerance": 0.03,
  "expected": "match"
}
```

`expected: "different"`는 기준과의 평균 차이가 허용치를 넘는지 검사합니다. 차이를 확인해도 어느 사진으로 바뀌었는지까지 확인한 것은 아닙니다. 시계·도구 모음·Live Photo 움직임 등을 제외하고, 화면 크기와 방향을 동일하게 맞춥니다. **기준 이미지 파일은 이 예제에 포함하지 않았습니다.** 실제 화면에서 저장한 기준을 사용하세요.

## 시간과 반복

`long_press`는 `press_duration_ms`, `swipe`와 `drag`는 `move_duration_ms`를 사용합니다. 드래그는 `press_duration_ms`와 `hold_duration_ms`도 설정할 수 있습니다. `after_delay_ms`는 기기 명령이 반환된 뒤 추가하는 대기이며, `wait.duration_ms`는 독립 대기 단계입니다.

핀치 `scale`은 1보다 크면 확대, 1보다 작으면 축소이며 `velocity`는 양수입니다. 회전은 `angle_degrees` 부호로 방향을 정하고, `velocity_degrees`는 양의 도/초 값입니다. 이 매개변수는 목표 입력을 지정하며 실제 앱의 반응은 별도로 검사합니다. 사진 앱의 화면에 따라 회전 입력 등을 처리하지 않을 수 있습니다.

```json
{
  "type": "repeat",
  "count": 20,
  "between_iterations_ms": 500,
  "steps": [
    {"type": "swipe", "from": {"x": 0.8, "y": 0.5}, "to": {"x": 0.2, "y": 0.5}, "move_duration_ms": 300, "after_delay_ms": 1000},
    {"type": "swipe", "from": {"x": 0.2, "y": 0.5}, "to": {"x": 0.8, "y": 0.5}, "move_duration_ms": 300, "after_delay_ms": 1000}
  ]
}
```

전체 테스트 구간을 반복하려면 GUI 하단의 `전체 반복` 또는 CLI의 `--cycles N`을 사용합니다. 준비 단계는 한 번만 실행합니다. `--skip-setup`을 사용해도 시작 화면 검사는 생략되지 않습니다.

반복 그룹을 중첩하지 않습니다. 서로 다른 횟수·지연이 필요하면 각각 별도 반복 그룹으로 만듭니다. 정확한 범위 검사는 [모델 구현](../src/mac_gyver/models.py)을 따릅니다.
