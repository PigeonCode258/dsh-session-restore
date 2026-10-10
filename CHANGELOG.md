# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
