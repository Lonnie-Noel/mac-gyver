# 시나리오 예제

[photos_roundtrip.example.json](photos_roundtrip.example.json)은 사진 왕복 넘기기의 **제안된 저장 형식**입니다. 실행 엔진은 아직 구현되지 않았습니다.

예제는 앱 열기와 사진 선택을 준비 단계로 두고, 좌우 왕복 구간만 100회 반복합니다. 처음 실기기로 확인할 때는 1회부터 시작합니다.

- `schema_version`: 시나리오 형식 버전.
- `app_profile`, `device_profile`: 연결 및 화면 조건을 저장할 프로필 이름.
- `setup`: 반복하기 전에 한 번 실행할 준비 단계.
- `steps`: 실제 테스트 단계와 반복 구간.
- `move_duration_ms`: 손가락의 이동 목표 시간.
- `after_delay_ms`: 명령이 반환된 후 기다릴 시간.
- `between_iterations_ms`: 회차 사이의 추가 대기 시간.

좌표는 예시값입니다. 실제 앨범 진입과 사진 위치를 기록한 뒤 바꿔야 합니다. 이 예제에는 화면 검사가 없어 실행 완료만으로 기능 통과라고 판정할 수 없습니다. 화면 검사 방식과 확장 범위는 [구현 계획서](../docs/Plan_iPhone_자동테스트_2026-09-15.md)에 정의했습니다.
