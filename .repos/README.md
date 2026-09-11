# `.repos/` — vendored reference codebases

Read-only copies of external codebases we keep around as **reference** (for extracting
patterns, checking implementation details, and grounding decisions). Do not edit files
inside the snapshots — changes there will be overwritten on the next update.

The directory is **committed** so a fresh clone includes the reference code. Each import
or update is squashed into a single snapshot commit, without upstream git history,
nested `.git` directories or submodules. Formatting, linting and tests exclude the
snapshots so repository checks leave the upstream files unchanged.

## What's here

| Path | Source | Snapshot of |
|---|---|---|
| `.repos/slopcop` | <https://github.com/Effect-TS/slopcop> (branch `main`) | `4809086` |
| `.repos/effect` | <https://github.com/Effect-TS/effect> (tag `effect@4.0.0-rc.112`, the v4 RC line — `effect@rc`) | `2600f62` |

## Adding or updating a snapshot

Clone shallowly, note the commit you took, then strip the `.git` directory:

```sh
# from the repo root
git clone --depth 1 https://github.com/<owner>/<repo> .repos/<name>
git -C .repos/<name> rev-parse --short HEAD   # record this in the table above
rm -rf .repos/<name>/.git
```

To pin a release instead of a branch head (e.g. the current Effect v4 RC), pass the tag:

```sh
npm view effect dist-tags          # find the current `rc` version
git clone --depth 1 --branch 'effect@<version>' https://github.com/Effect-TS/effect .repos/effect
git -C .repos/effect rev-parse --short HEAD
rm -rf .repos/effect/.git
```

To update an existing snapshot, delete the directory and re-clone. Update the table
when you do. Preserve upstream license files, review the snapshot for local artifacts,
and commit the whole import or update in one commit. Upstream ignore rules can match
files that belong to the snapshot, so include those files explicitly when staging.
