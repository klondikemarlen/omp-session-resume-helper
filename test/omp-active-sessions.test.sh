#!/usr/bin/env bash
set -euo pipefail

project_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
command="$project_directory/bin/omp-active-sessions"
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

create_process() {
  local process_id=$1
  shift
  mkdir -p "$process_directory/$process_id"
  printf '%s\0' "$@" >"$process_directory/$process_id/cmdline"
  ln -s "$working_directory" "$process_directory/$process_id/cwd"
}

process_directory="$temporary_directory/proc"
agent_directory="$temporary_directory/agent"
working_directory="$temporary_directory/active worktree"
status_command="$temporary_directory/ps"
mkdir -p "$process_directory" "$agent_directory/terminal-sessions" "$working_directory"

cat >"$status_command" <<'EOF'
#!/usr/bin/env bash
case "$2" in
  100) printf 'pts/7\n' ;;
  101) printf 'pts/8\n' ;;
  102) printf 'pts/9\n' ;;
  103) printf 'pts/10\n' ;;
  104) printf '?\n' ;;
  105) printf 'pts/11\n' ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$status_command"

create_process 100 omp
create_process 101 omp __omp_worker_tiny_inference
create_process 102 bash
create_process 103 omp --resume old-session
create_process 104 omp
create_process 105 /usr/local/bin/omp

printf '%s\n%s\n' \
  "$working_directory" \
  '/sessions/2026-08-07_019fb989-c2ee-7000-96ea-2a2cce5229b6.jsonl' \
  >"$agent_directory/terminal-sessions/pts-7"
printf '%s\n%s\n' \
  "$working_directory" \
  '/sessions/2026-08-07_019fb981-7adc-7000-a991-935c9a97acea.jsonl' \
  >"$agent_directory/terminal-sessions/pts-10"
printf '%s\n%s\n' \
  "$working_directory" \
  '/sessions/2026-08-07_019fdd42-e19a-7000-9bf6-1b1e5fd86a11.jsonl' \
  >"$agent_directory/terminal-sessions/pts-11"

expected_output="$temporary_directory/expected"
printf 'cd %q && omp --resume %q\n\n' \
  "$working_directory" \
  '019fb989-c2ee-7000-96ea-2a2cce5229b6' \
  >"$expected_output"
printf 'cd %q && omp --resume %q\n\n' \
  "$working_directory" \
  '019fb981-7adc-7000-a991-935c9a97acea' \
  >>"$expected_output"
printf 'cd %q && omp --resume %q\n\n' \
  "$working_directory" \
  '019fdd42-e19a-7000-9bf6-1b1e5fd86a11' \
  >>"$expected_output"

actual_output="$temporary_directory/actual"
PI_CODING_AGENT_DIR="$agent_directory" \
OMP_PROCESS_DIRECTORY="$process_directory" \
OMP_PROCESS_STATUS_COMMAND="$status_command" \
  "$command" >"$actual_output"
cmp "$expected_output" "$actual_output" || fail 'unexpected exported commands'

file_output="$temporary_directory/resume-commands"
PI_CODING_AGENT_DIR="$agent_directory" \
OMP_PROCESS_DIRECTORY="$process_directory" \
OMP_PROCESS_STATUS_COMMAND="$status_command" \
  "$command" --output "$file_output"
cmp "$expected_output" "$file_output" || fail '--output did not write exported commands'

if "$command" --unknown >/dev/null 2>&1; then
  fail 'unknown options should fail'
fi

printf '%s\n' 'PASS: active OMP sessions export as quoted resume commands'
