# mend-v2

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bebek-gg/mend-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in four
formats, to a tree of text files: unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. It finds the lines each edit names at the first of three matching tiers
(exact, then trailing-whitespace tolerant, then indentation tolerant), and
changes every file or none. It prints what it changed or why it failed, and
is deterministic: the same patch gives the same exit code, stdout and files
every run.

## Run it

```sh
node main.ts [options] [PATCH]
```

Options: `--format=NAME` (`auto`, `unified`, `search-replace`, `v4a`, `json`;
default `auto` detects it), `--check` (do everything but write),
`--strict` (match lines exactly, tier 0 only). `PATCH` is the patch file;
when it is absent or `-`, the patch is read from standard input. The working
directory is the root of the tree.

Exit codes: `0` when the tree is written (or would be, with `--check`),
`1` when an edit failed (nothing is written, every failure is listed),
`2` on a usage, missing-patch, format or parse error. A patch that changes
nothing prints only `ok: 0 files`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
