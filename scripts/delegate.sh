#!/usr/bin/env bash
# Hands one coding task to other models through opencode: Muse Spark writes it in a git
# worktree of its own (branch muse/<name>), then a ChatGPT model reviews the change. The
# worktree starts from this checkout as it is, uncommitted work included, and its changes
# come back only with --take; this checkout is never touched otherwise.
#
#   scripts/delegate.sh <name> <task.md>            write, then review
#   scripts/delegate.sh <name> <task.md> --again    a follow-up in the same worktree (fixes from a review), then review
#   scripts/delegate.sh <name> <task.md> --review   review an existing worktree again
#   scripts/delegate.sh <name> --take               apply its changes to this checkout, remove the worktree
#
# DELEGATE_REVIEWER=muse-reviewer picks the Muse reviewer (when ChatGPT's limit is reached).
#
# The agents (opencode.json) can edit files and run only the tests, the typecheck and
# read-only git; no web, no other commands, no files outside the worktree, no .env.
set -euo pipefail
# Run from a copy: bash reads a script as it goes, so editing this file mid-run breaks it.
if [[ -z "${DELEGATE_COPY:-}" ]]; then
  copy=$(mktemp -t delegate)
  cp "$0" "$copy"
  DELEGATE_COPY=1 exec bash "$copy" "$@"
fi

name=${1:?usage: scripts/delegate.sh <name> <task.md> [--again|--review] | <name> --take}
root=$(git rev-parse --show-toplevel)
wt="$root/.worktrees/$name"
out="$root/.worktrees/$name.out"

if [[ "${2:-}" == "--take" ]]; then
  # The worktree's index holds its starting point, so staging everything and diffing
  # against that gives exactly the delegated change.
  git -C "$wt" add -A -- . ':!opencode.json' ':!.opencode' ':!scripts/delegate.sh'
  git -C "$wt" diff --cached --binary "$(cat "$out/base")" -- . ':!opencode.json' ':!.opencode' ':!scripts/delegate.sh' > "$out/change.patch"
  # Directly when it applies; otherwise merge file by file (three-way, against the state the
  # worktree started from), since this checkout has moved on and its work isn't staged.
  if ! git -C "$root" apply "$out/change.patch" 2>/dev/null; then
    base=$(cat "$out/base")
    conflicts=()
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      mine="$root/$path" theirs="$wt/$path"
      if [[ ! -e "$theirs" ]]; then rm -f "$mine"; continue; fi            # deleted there
      if ! git -C "$wt" cat-file -e "$base:$path" 2>/dev/null; then        # new there
        if [[ ! -e "$mine" ]] || cmp -s "$mine" "$theirs"; then mkdir -p "$(dirname "$mine")"; cp "$theirs" "$mine"; else conflicts+=("$path (added on both sides)"); fi
        continue
      fi
      if [[ ! -e "$mine" ]]; then conflicts+=("$path (deleted here)"); continue; fi
      git -C "$wt" show "$base:$path" > "$out/merge.base"
      git merge-file -L here -L base -L "muse/$name" "$mine" "$out/merge.base" "$theirs" || conflicts+=("$path")
    done < <(git -C "$wt" diff --cached --name-only "$base" -- . ':!opencode.json' ':!.opencode' ':!scripts/delegate.sh')
    if (( ${#conflicts[@]} )); then
      printf 'Merged with conflicts to resolve (marked <<<<<<< here / >>>>>>> muse/%s):\n' "$name" >&2
      printf '  %s\n' "${conflicts[@]}" >&2
      exit 1
    fi
  fi
  git -C "$root" worktree remove --force "$wt"
  git -C "$root" branch -D -q "muse/$name"
  git -C "$root" apply --stat "$out/change.patch"
  exit 0
fi

task_file=${2:?usage: scripts/delegate.sh <name> <task.md> [--again|--review]}
mode=${3:-}
task=$(cat "$task_file")

if [[ -z "$mode" ]]; then
  git -C "$root" worktree add -q -b "muse/$name" "$wt" HEAD
  # Dependencies come from the main checkout; the workspace packages point at this tree.
  mkdir -p "$wt/node_modules/@jig"
  for entry in "$root"/node_modules/* "$root"/node_modules/.bin; do
    [[ "$(basename "$entry")" == "@jig" ]] || ln -s "$entry" "$wt/node_modules/"
  done
  ln -s ../../core "$wt/node_modules/@jig/core"
  ln -s ../../web "$wt/node_modules/@jig/web"
  [[ -d "$root/web/node_modules" ]] && ln -s "$root/web/node_modules" "$wt/web/node_modules"
  # Start from this checkout as it is: uncommitted changes and new files too. The index
  # keeps that state, so `git diff` there shows only what the agent changes.
  git -C "$root" diff HEAD --binary | (cd "$wt" && git apply --allow-empty)
  git -C "$root" ls-files --others --exclude-standard -z | rsync -a --from0 --files-from=- "$root/" "$wt/"
  # Machine-local, gitignored files the builds need.
  [[ -f "$root/android/Jig/local.properties" ]] && cp "$root/android/Jig/local.properties" "$wt/android/Jig/"
  git -C "$wt" add -A
  mkdir -p "$out"
  git -C "$wt" write-tree > "$out/base"
fi
# The agents' config, current even when it isn't committed yet.
cp "$root/opencode.json" "$wt/"
mkdir -p "$wt/.opencode" && cp -R "$root/.opencode/prompts" "$wt/.opencode/"
mkdir -p "$out"

# Runs an agent in the worktree: run_agent <agent> <title> <message> <events.jsonl> <log>.
# Some runs stall before their first event; one that has produced nothing after five
# minutes is stopped and started again, up to three tries.
run_agent() {
  local agent=$1 title=$2 message=$3 events=$4 log=$5 try=1 pid waited
  while :; do
    (cd "$wt" && exec perl -e 'alarm shift; exec @ARGV' "${DELEGATE_TIMEOUT:-1800}" \
      opencode run --standalone --print-logs --log-level warn --agent "$agent" --format json --title "$title" "$message") > "$events" 2> "$log" &
    pid=$!
    waited=0
    while kill -0 "$pid" 2>/dev/null; do
      sleep 10
      waited=$((waited + 10))
      if (( waited >= ${DELEGATE_STALL:-300} )) && [[ ! -s "$events" ]]; then
        pkill -P "$pid" 2>/dev/null || true
        kill "$pid" 2>/dev/null || true
        break
      fi
    done
    wait "$pid" 2>/dev/null || true
    [[ -s "$events" ]] || (( try >= 3 )) && break
    try=$((try + 1))
    echo "· $agent produced nothing for five minutes; starting it again (try $try)" >&2
  done
}

# The final text of an opencode JSON event stream.
last_text() { jq -rs '[.[] | select(.type == "text") | .part.text] | last // ""' "$1"; }

if [[ "$mode" != "--review" ]]; then
  echo "· muse-writer is working on ${name}..." >&2
  run_agent muse-writer "$name" "$task" "$out/writer.jsonl" "$out/writer.err"
  last_text "$out/writer.jsonl" > "$out/writer.md"
  # The task the review checks against: the original, plus any follow-ups.
  if [[ -z "$mode" ]]; then cp "$task_file" "$out/task.md"; else printf '\n\nFollow-up:\n%s\n' "$task" >> "$out/task.md"; fi
fi
task=$(cat "$out/task.md")

echo "· ${DELEGATE_REVIEWER:-gpt-reviewer} is reviewing…" >&2
run_agent "${DELEGATE_REVIEWER:-gpt-reviewer}" "$name review" \
  "Review the change in this worktree: the unstaged changes and untracked files (\`git diff\`, \`git status\`). Staged changes are the starting point it was built on, not part of it. It was written for this task:"$'\n\n'"$task" "$out/review.jsonl" "$out/review.err"
last_text "$out/review.jsonl" > "$out/review.md"

echo "## Writer" && cat "$out/writer.md" 2>/dev/null
echo && echo "## Changes" && git -C "$wt" status --short -- . ':!opencode.json' ':!.opencode' ':!scripts/delegate.sh' ':!node_modules' ':!web/node_modules'
echo && echo "## Review" && cat "$out/review.md"
echo && echo "Worktree: $wt (branch muse/$name). Logs: $out"
