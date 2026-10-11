# dsh-session-restore · session archive restore

[中文](README.md) · **English**

[![ci](https://github.com/pigeoncode258/dsh-session-restore/actions/workflows/ci.yml/badge.svg)](https://github.com/pigeoncode258/dsh-session-restore/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.15-brightgreen.svg)](package.json)

Import a **Session-log ZIP exported by DeepSeek Harness (dsh)** and put the conversation back on this
machine: session identity, event history, sub-sessions, images, and attachments land exactly as
exported, appear in the sidebar, open in the Conversation view, and resume where they left off.

The export side is the **Download session log** button in the Session header of the Web UI (the
`/export` command, or `GET /api/session.export?sessionId=…&includeDescendants=true`). This project is
the missing other half.

```
dsh session-log ZIP  ──►  preview (read the archive, write nothing)  ──►  commit (write back through the persistence seam)
```

---

## What it does

| Capability | Detail |
|---|---|
| One ZIP, one import | The root Session plus every sub-Session log are restored together, lineage (`parentSession`) intact |
| A real restore, not a rebuild | Logs are written event by event through a `ctx.sessionPersistence` write handle, so a restored Session is indistinguishable from one dsh wrote itself: it lists, opens, and resumes |
| Two import modes | **Original identity** (keep the archived ids and workspace) or **copy** (mint new ids — the safe choice for archives from another machine) |
| Conflicts escalate instead of overwriting | When an identity already exists here, the whole import switches to copy mode, and every reference to that id inside events is rewritten — including JSON-text carriers such as `tool/call.arguments` |
| Workspace rewrite | A workspace that is missing here, or written in another platform's convention (Windows ↔ POSIX), can be replaced with a target workspace for every restored Session; the default target is the invoking Session's workspace |
| Joins the target project | After the write, `workspaceRegistry.resolveByPath` / `create` / `attachSession` register the Session, so it shows up under the chosen project instead of the Ungrouped bucket |
| Permission preset normalization | An archive carries the exporting machine's posture; the import resolves it against this deployment's catalog and pins the default preset through the same three events dsh writes, so pairs like `workspace-write + approval: never` no longer resolve to `custom` (keeping the archive's own settings stays an option) |
| Attachment restore | `media/*` images go through `ctx.attachments.saveImage`; `files/*` files stream through `saveFileStream`. When the store re-normalizes an object into a different id, the log's reference is rewritten to match |
| Strict archive validation | Format version, event vocabulary, dense `seq`, exact header key set, and `isSeeded`/`session/end-seed` agreement are all checked before anything is written — publishing an unreadable log is worse than refusing it |
| Legacy archives | Raw `.jsonl.zstd` artifacts from 0.1.x exports (concatenated Zstandard frames) are decoded too; generations this build cannot restore are refused with a precise reason instead of being misread |
| No dependencies, no build | The host half uses only `node:*`; the browser half is a hand-written lazy-CJS bundle, so no bundler is involved |

---

## Compatibility

- **Target harness**: dsh `0.2.0-rc.2` (session format v4, Web/desktop profile). The reader validates
  this generation's archive layout and event vocabulary strictly: when a future dsh changes the
  vocabulary, the plugin refuses the archive instead of misreading it.
- **Node.js** ≥ 22.15 (the host half uses the Zstandard API in `node:zlib`).
- **Platforms**: Windows, macOS, and Linux (macOS and Linux share the same path rules); CI runs the
  suite on Windows and Linux. A cross-platform import — for example a Windows export restored on
  Linux — needs an explicit target workspace.

---

## Install

```bash
# From GitHub (recommended before an npm release)
dsh plugin --profile desktop add github:pigeoncode258/dsh-session-restore

# Local directory (development; edits apply on the next dsh start)
dsh plugin --profile desktop add link:<absolute path to this directory>

# After an npm release
dsh plugin --profile desktop add dsh-session-restore
```

The package already declares `dsh.bundle.patch` (host half) and `dsh.client` (browser half), so
`dsh plugin add` adds it to the profile's `dsh.profile.bundles` and runs `pnpm install` in that
profile. It can also be installed from **Settings → Plugins**.

> **Bundles are composed when dsh starts — restart dsh once after installing.**

---

## Usage

### 1. The dialog (recommended)

Two entry points share one import dialog:

- **Sidebar foot**: the "Import session archive" entry beside Settings (label when the rail is wide,
  icon when collapsed). It does not depend on an open Session — the dialog lives here.
- **Session header, right side**: the unarchive icon next to the download button. It offers the
  current Session's workspace as the default target.

The flow:

1. Drop a `dsh-session-*.zip` into the dialog, or click to choose one;
2. The dialog reports what the archive holds: title, id, event count, creation time, whether the
   workspace exists / is usable here, whether that identity already exists, attachment counts and
   missing references, plus every non-fatal note;
3. Choose **import mode** (original identity / copy), the **workspace** as one of three explicit
   choices (keep the archive's / pick a registered project / type a path), and the **permission
   preset** (this machine's default, or keep the archive's); the dialog always shows the
   `archive workspace → target workspace` mapping and the archive's own permission posture;
4. Press **Start import**. The dialog lists the outcome per Session, including the project it joined
   and how the permissions changed, and **Open session** jumps straight to the restored root; the
   Session list refreshes.

### 2. Slash command (archive already on this host)

```
/import D:\backup\dsh-session-<id>.zip
/import "path with spaces\x.zip" --copy      # import as a copy (new session ids)
/import x.zip --cwd /work/project           # restore into a specific workspace
/import x.zip --permission workspace-write  # pin one permission preset
/import x.zip --keep-permissions            # keep the archive's own settings
/import x.zip --no-media                    # conversation only, no attachments
```

Options: `--copy` / `-c`, `--no-media`, `--cwd <path>` (relative paths resolve against the current
working directory), `--permission <name>`, `--keep-permissions`. Without `--cwd` the target is the
**workspace of the invoking Session**, and the restored Sessions are registered with that project.
A successful run refreshes the Session list and names the restored ids, the project they joined, and
the permission change.

### 3. Programmatic surface

```js
const service = ctx.get('sessionRestore');
const preview = await service.preview(zipPath, { sessionId });
const result = await service.commit({ token, mode: 'restore', cwd, importMedia: true });
```

HTTP routes registered by the host half (the browser addresses them document-relative and needs the
session cookie):

| Route | Method / body | Purpose |
|---|---|---|
| `/api/session.restore.preview` | `POST`, `application/zip`, **streaming** | Stage an upload and answer with a preview plus a `token` |
| `/api/session.restore.commit` | `POST`, `application/json` | Restore a staged archive |
| `/api/session.restore.discard` | `POST`, `application/json` | Drop a staged upload |

Everything after protocol validation answers `200` with `{ ok: true, value }` or
`{ ok: false, error: { code, message } }` — the envelope this harness already uses for
browser-facing operations; a status code therefore always means the request itself was malformed.

---

## Restore semantics

- **Identity.** Original-identity mode keeps the archived `id`. Copy mode mints a fresh id with the
  same *shape* as the archived one (ordinary Sessions are `session-<uuid>`, subagent Sessions are
  bare UUIDs) and rewrites every occurrence of the old id — in headers, `parentSession`, subagent
  directories, and JSON-text carriers.
- **Workspace.** `cwd` must be an absolute path *on this platform*; a cold Session without one never
  appears in the Session list (existing dsh behaviour). A cross-platform archive is flagged in the
  preview as "workspace path is not absolute on this platform" and needs an explicit target (the
  dialog's workspace field, or `--cwd`). The default target is the **invoking Session's workspace**;
  the archived one is used only when it exists here, is usable, and you pick "archive workspace".
- **Project membership.** dsh's sidebar does not group Sessions by `cwd`: a Session belongs to a
  project only when the workspace record's `sessionIds` accounts for it ("membership is ownership
  plus live cwd facts"). A restore therefore registers what it wrote the way the harness registers
  its own Sessions — `workspaceRegistry.resolveByPath(cwd)` / `create(cwd)` and then
  `attachSession(id)` — so the restored Session appears under the chosen project instead of the
  **Ungrouped** bucket. Registration happens only when the directory exists (a project *is* a
  directory), and subagent Sessions are never registered on their own.
- **Permission preset.** dsh stores no preset label: it folds `permission/preset`, `sandbox/mode`,
  and `approval/policy` and looks the resulting `(sandbox, approval)` pair up in the deployment's
  catalog. An archive carries the *exporting* machine's posture, and a pair this host has no entry
  for — `workspace-write` with `approval: never`, for instance — resolves to `custom`, which is how
  "workspace write" appears to vanish. Imports pin this deployment's default preset by appending the
  same three events in the same order `dsh-permission-presets` writes them, so a restored Session
  matches a fresh one here; choose "keep archive" (or `--keep-permissions`) to preserve the original.
  Note that the sandbox's writable boundary is `session.header.cwd`, so a wrong workspace shows up as
  the wrong path rather than a downgraded permission.
- **Conflicts.** `create()` rejects an identity that already exists and this build ships no delete
  API, so an existing Session is **never overwritten**: the import switches to copy mode and says so.
- **Inheritance cut.** A seeded Session's `inheritedEventCount` is derived from the log's last
  `session/end-seed { inherited: true }` marker (the export file does not carry it); a log whose
  marker disagrees is refused.
- **Sub-Sessions.** `origin: "subagent"` Sessions cannot be resumed on their own (existing dsh rule),
  but they come back fully inside the root's lineage and trajectory.
- **Attachments.** Only objects referenced by the restored logs are restored; references missing from
  the archive, or re-identified by the store, are reported honestly in the result.
- **Staging and cleanup.** Uploads are staged under `$DSH_HOME/session-restore/staging/` and deleted
  as soon as they are committed or discarded; an unconsumed upload expires after 6 hours, and at most
  24 are kept.

---

## Limitations

- The archive must use a **format version this harness reads (v4)**. A newer archive says "update the
  harness"; an older one says where to re-export it from. Neither is ever misread.
- A restored Session keeps its historical `request/header` events, but **the next request uses the
  current envelope** (current model, system prompt, tool set). Importing from another machine
  therefore continues under *your* model settings.
- The permission preset is normalized to this deployment's default as described above; on a
  deployment that mounts no `permissionPresets` (headless / SDK profile) the archive's events are
  kept and the result says so.
- `agentPreset` is stored verbatim: if this machine has no preset with that name the Session still
  opens, but check the preset before continuing it.
- There is no delete or retention API: importing is additive, and cleaning up means removing
  `$DSH_HOME/sessions/<project directory>/<session directory>/` yourself.

## Configuration

Add a `config:` block to the insert row in `cordis.patch.yml`:

| Key | Default | Purpose |
|---|---|---|
| `stagingTtlMs` | `21600000` (6 h) | How long an unconsumed upload is kept |
| `maxUploadBytes` | `2 GiB` | Upload ceiling per archive |
| `maxEntryBytes` | `512 MiB` | Decompressed ceiling per archive entry |

---

## Layout

```
lib/index.js      Plugin entry: service, routes, the /import command
lib/service.js    preview / commit / discard, project list and workspace suggestion
lib/restore.js    Restore engine: identity mapping, batched append, conflict escalation, project registration, permission normalization
lib/media.js      Attachment restore and reference rewriting
lib/archive.js    Archive reading: entry classification, JSONL validation, inheritance cut, portable workspaces
lib/permissions.js Reading permission facts, resolving them against this catalog, writing the override
lib/workspace.js  Registering restored Sessions with their project (resolveByPath / create / attachSession)
lib/zip.js        Dependency-free ZIP reader plus multi-frame Zstandard decoding
lib/vocabulary.js The event vocabulary and format version of this build
lib/staging.js    Upload staging and cleanup
lib/routes.js     The three HTTP routes
lib/client.js     Browser half (hand-written lazy-CJS bundle): sidebar entry, header trigger, import dialog
test/             82 offline tests, a cross-platform (POSIX-semantics) simulator, and an optional real-artifact checker
```

## Development

```bash
node test/run.mjs                      # the whole offline suite (nothing to install)
node test/simulate-posix/run.mjs       # run it again under POSIX path rules, from any host
node test/real-artifacts.mjs           # optional: validate the reader against real artifacts under $DSH_HOME/sessions
```

- The suite needs no dsh runtime: persistence, the attachment store, and the host HTTP connection are
  replaced by behaviour-equivalent doubles, and the browser half is loaded in `node:vm` through the
  real loader protocol and rendered branch by branch with a minimal React.
- `test/simulate-posix/` swaps `node:path`'s absolute-path rule for the POSIX one and flips the
  platform constant the fixtures read, so a branch that would only fail on ubuntu shows up on a
  Windows development machine (CI runs it on every push).
- Issues and pull requests are welcome. Please keep the "no runtime dependencies, no build step" line.

## License

[MIT](LICENSE)
