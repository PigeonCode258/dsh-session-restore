# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Restored Sessions now join the project they were imported into.** dsh groups a Session by its
  workspace record's `sessionIds`, not by `cwd`, so a Session written straight to the store stayed in
  the sidebar's Ungrouped bucket no matter which workspace the dialog named. The import now registers
  each restored ordinary Session the way the harness registers its own — `resolveByPath` / `create`
  and then `attachSession` — and reports the project (or the reason it could not be registered).
- **An imported Session no longer loses "workspace write".** A permission preset is not a stored
  label: dsh folds `permission/preset`, `sandbox/mode`, and `approval/policy` and looks the resulting
  `(sandbox, approval)` pair up in the deployment's catalog, so an archive from another machine (for
  example `workspace-write` with `approval: never`) resolved to `custom` here. Imports now pin this
  deployment's default preset through the same three events `dsh-permission-presets` writes.

### Changed

- **The default target workspace is the invoking Session's**, not the archived one: an archive from
  another machine names a directory that means nothing here. The archived workspace is still offered
  when it exists and is usable.
- **The dialog's workspace field is an explicit three-way choice** (archive / registered project /
  custom path) instead of an opt-in text box, and the permission preset is its own choice with the
  archive's posture shown next to it. The `preview` payload now carries the deployment's projects and
  the folded archive permissions.
- `/import` gained `--permission <name>` and `--keep-permissions`, and its summary reports the project
  and the permission change.

## [0.1.0] - 2026-09-14

Initial release.

### Added

- **Import** a Session-log ZIP exported by DeepSeek Harness and restore the conversation as durable
  Sessions: root Session plus every sub-Session log, with lineage, history, and attachments.
- **Preview before writing**: the archive is parsed and described (titles, ids, event counts,
  workspaces, conflicts, attachment counts, warnings) without touching the session store.
- **Two import modes**: original identity, or copy with fresh ids; every reference to a rewritten id
  inside events is updated, including JSON-text carriers such as `tool/call.arguments`.
- **Conflict escalation**: an identity that already exists here switches the import to copy mode
  instead of overwriting (the persistence seam has no delete or overwrite path).
- **Workspace handling**: reports missing and cross-platform workspaces, offers a target workspace in
  the dialog, and accepts `--cwd` on the command line.
- **Attachment restore** for `media/*` images and `files/*` files, with reference rewriting when the
  attachment store re-normalizes an object into a different id.
- **Strict pre-write validation**: format version, exact header key set, event vocabulary, dense
  `seq`, and seeded `session/end-seed` agreement.
- **Legacy artifact decoding**: raw `.jsonl.zstd` artifacts made of concatenated Zstandard frames.
- **Surfaces**: sidebar-foot entry, Session-header trigger, the `/import` slash command, the
  `sessionRestore` service, and three authenticated HTTP routes.
- **Dependency-free implementation**: host half on `node:*` only; browser half as a hand-written
  lazy-CJS bundle (no bundler).

[0.1.0]: https://github.com/pigeoncode258/dsh-session-restore/releases/tag/v0.1.0
