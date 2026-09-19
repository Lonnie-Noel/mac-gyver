#!/bin/zsh

photos_launcher_dir="${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

photos_launcher_finish() {
  local photos_exit_code="$1"
  printf '\n'
  if (( photos_exit_code != 0 )); then
    printf '작업이 오류로 종료되었습니다. 위 안내를 확인해 주세요. (종료 코드: %s)\n' "$photos_exit_code"
  fi
  if [[ -t 0 ]]; then
    read -r 'photos_enter?Enter를 누르면 이 실행을 마칩니다. '
  fi
  exit "$photos_exit_code"
}

printf '\033]0;사진 자동 캡처 시작\007'
printf '사진 자동 캡처를 시작합니다.\n\n'
printf '아이폰에서 대상 앨범의 시작 사진을 크게 열고, 잠금을 해제해 두세요.\n'
printf '캡처 결과의 저장 경로는 실행 중 아래에 표시됩니다.\n'
printf '중지하려면 “사진 자동 캡처 중지.command”를 더블클릭하세요.\n\n'

cd -- "$photos_launcher_dir" || photos_launcher_finish 1
photos_node="$(command -v node)"
if [[ -z "$photos_node" ]]; then
  printf 'Node.js를 찾지 못했습니다. Node.js 22.12 이상 23 미만 버전이 필요합니다.\n'
  photos_launcher_finish 1
fi

"$photos_node" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major !== 22 || minor < 12) { console.error(`현재 Node.js ${process.versions.node}: 22.12 이상 23 미만 버전이 필요합니다.`); process.exit(1); }'
photos_node_check_status=$?
if (( photos_node_check_status != 0 )); then
  photos_launcher_finish "$photos_node_check_status"
fi

"$photos_node" "$photos_launcher_dir/scripts/run-photos.mjs"
photos_run_status=$?
photos_launcher_finish "$photos_run_status"
