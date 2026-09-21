# Shared by the Finder launchers. Keep the caller's PATH unchanged.
# Optional trailing fallback paths make runtime selection testable without
# inspecting this Mac's installed Node versions or the user's home directory.
macgyver_select_node() {
  local task_runtime_root="$1"
  shift
  local task_runtime_check="$task_runtime_root/scripts/runtime.mjs"
  local task_candidate task_path_node task_version task_reason task_check_error
  local -a task_candidates task_fallbacks
  local -A task_seen
  typeset -g MACGYVER_SELECTED_NODE=''

  if [[ ! -f "$task_runtime_check" ]]; then
    print -u2 -- "Node.js 확인 파일이 없습니다: $task_runtime_check"
    return 1
  fi

  if (( ${+MACGYVER_NODE} )); then
    task_candidate="$MACGYVER_NODE"
    if [[ "$task_candidate" != /* || ! -f "$task_candidate" || ! -x "$task_candidate" ]]; then
      print -u2 -- 'MACGYVER_NODE에는 실행 가능한 Node.js의 절대 경로를 지정하세요.'
      return 1
    fi
    if ! task_check_error="$("$task_candidate" "$task_runtime_check" 2>&1)"; then
      print -u2 -- "MACGYVER_NODE로 지정한 Node.js를 사용할 수 없습니다: $task_candidate"
      [[ -z "$task_check_error" ]] || print -u2 -- "$task_check_error"
      return 1
    fi
    if ! task_version="$("$task_candidate" --version 2>&1)"; then
      print -u2 -- "MACGYVER_NODE의 버전을 확인하지 못했습니다: $task_candidate"
      return 1
    fi
    MACGYVER_SELECTED_NODE="$task_candidate"
    print -u2 -- "Node.js $task_version 사용: $MACGYVER_SELECTED_NODE (MACGYVER_NODE)"
    return 0
  fi

  task_path_node="$(whence -p node 2>/dev/null || true)"
  if [[ -n "$task_path_node" ]]; then
    task_path_node="${task_path_node:a}"
    task_candidates+=("$task_path_node")
  fi
  if (( $# )); then
    task_fallbacks=("$@")
  else
    task_fallbacks=(/opt/homebrew/bin/node /usr/local/bin/node)
    [[ -z "${HOME:-}" ]] || task_fallbacks+=("$HOME/.local/bin/node")
  fi
  task_candidates+=("${task_fallbacks[@]}")

  for task_candidate in "${task_candidates[@]}"; do
    [[ -n "$task_candidate" && -f "$task_candidate" && -x "$task_candidate" ]] || continue
    task_candidate="${task_candidate:a}"
    [[ -z "${task_seen[$task_candidate]:-}" ]] || continue
    task_seen[$task_candidate]=1
    if ! task_check_error="$("$task_candidate" "$task_runtime_check" 2>&1)"; then
      print -u2 -- "지원하지 않는 Node.js를 건너뜁니다: $task_candidate"
      [[ -z "$task_check_error" ]] || print -u2 -- "$task_check_error"
      continue
    fi
    if ! task_version="$("$task_candidate" --version 2>&1)"; then
      print -u2 -- "버전을 확인하지 못한 Node.js를 건너뜁니다: $task_candidate"
      continue
    fi
    MACGYVER_SELECTED_NODE="$task_candidate"
    task_reason='대체 설치 경로'
    [[ "$task_candidate" != "$task_path_node" ]] || task_reason='현재 PATH'
    print -u2 -- "Node.js $task_version 사용: $MACGYVER_SELECTED_NODE ($task_reason)"
    return 0
  done

  print -u2 -- 'Node.js 22.12.0 이상을 찾지 못했습니다. 설치 후 PATH 또는 MACGYVER_NODE를 확인하세요.'
  return 1
}
