window.__ModuleLoader__.load({
	id: "dsh-session-restore",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { createSnapshotStore } = require("@deepseek-ai/dsh-client-store");
		const h = React.createElement;

		/** Browser-relative forms of the host routes; leading "/" is stripped on purpose. */
		const PREVIEW_ROUTE = "/api/session.restore.preview".slice(1);
		const COMMIT_ROUTE = "/api/session.restore.commit".slice(1);
		const DISCARD_ROUTE = "/api/session.restore.discard".slice(1);

		/** How many sub-Sessions a list spells out before it summarizes the rest. */
		const LIST_LIMIT = 8;

		/** Locale namespace owned by the import dialog. */
		const NS = "session-restore";

		/** Every state the dialog can be in. */
		const INITIAL = {
			open: false,
			sessionId: null,
			phase: "idle",
			fileName: null,
			error: null,
			preview: null,
			token: null,
			mode: "restore",
			cwd: "",
			cwdMode: "archive",
			projectId: null,
			permissionsMode: "preset",
			permission: "",
			attachWorkspace: true,
			importMedia: true,
			result: null,
		};

		/** Simplified-Chinese dialog copy. */
		const zh = {
			"action.label": "导入会话归档",
			"dialog.title": "导入会话归档",
			"dialog.description": "导入从 DSH 导出的会话日志 ZIP，并把对话恢复到本机。",
			"dialog.close": "关闭",
			"pick.title": "选择 DSH 导出的会话 ZIP",
			"pick.hint": "把 dsh-session-*.zip 拖到这里，或者点击选择文件。归档里是会话日志，可能还包含子会话、图片与附件。",
			"pick.choose": "选择文件",
			"pick.dropping": "松开鼠标即可选择该文件",
			"busy.uploading": "正在读取归档…",
			"busy.importing": "正在恢复会话…",
			"preview.heading": "归档内容",
			"preview.root": "根会话",
			"preview.subagent": "子会话",
			"preview.events": "{count} 条事件",
			"preview.conflict": "本机已存在",
			"preview.seeded": "含继承历史",
			"preview.legacy": "旧版压缩归档",
			"preview.cwdMissing": "工作区在本机不存在",
			"preview.cwdUnusable": "工作区路径在本平台不是绝对路径，需要指定目标工作区",
			"preview.attachments": "附件：{images} 张图片、{files} 个文件",
			"preview.attachmentsNone": "归档里没有附件",
			"preview.attachmentsMissing": "有 {count} 个附件引用在归档中缺失",
			"preview.noStore": "本部署没有挂载附件存储，图片与文件无法恢复",
			"preview.more": "另有 {count} 个子会话",
			"preview.warnings": "提示",
			"options.mode": "导入方式",
			"options.mode.restore": "原样恢复",
			"options.mode.copy": "作为副本",
			"options.modeHint.restore": "保留归档中的会话 ID 与工作区；如果本机已存在同 ID 会话，会自动改用副本模式。",
			"options.modeHint.copy": "为每个会话生成新的 ID，适合从另一台机器导入或避免任何冲突。",
			"options.cwd": "工作区",
			"options.cwd.archive": "归档工作区",
			"options.cwd.project": "已有项目",
			"options.cwd.custom": "自定义路径",
			"options.cwdPlaceholder": "填写本机的绝对路径",
			"options.workspaceMap": "归档工作区 {from} → 目标工作区 {to}",
			"options.workspaceArchive": "沿用归档中的工作区：{cwd}",
			"options.workspaceUnusable": "（该路径在本机不可用，请改选项目或自定义路径）",
			"options.projects": "选择项目",
			"options.permissions": "权限预设",
			"options.permissions.preset": "使用本机预设",
			"options.permissions.archive": "沿用归档",
			"options.permissionsHint": "导入的会话默认使用本机预设（当前为 {preset}），避免继承导出机器的权限设置。",
			"options.permissionsArchive": "归档中的权限：{label}（sandbox={sandbox}，approval={approval}）",
			"options.permissionsUnavailable": "本部署没有挂载权限预设，只能沿用归档。",
			"options.attachWorkspace": "归入对应项目（侧边栏按项目分组）",
			"options.media": "恢复图片与文件",
			"commit": "开始导入",
			"cancel": "取消",
			"cancelUpload": "取消上传",
			"done.heading": "导入完成",
			"done.open": "打开会话",
			"done.finish": "完成",
			"done.failed": "失败",
			"done.attachments": "已恢复 {count} 个附件",
			"done.workspace": "已归入项目「{title}」（{path}）",
			"done.workspaceCreated": "已新建并归入项目「{title}」（{path}）",
			"done.workspaceSkipped": "未归入项目：{reason}",
			"done.permissions": "权限：{archived} → {applied}",
			"done.permissionsKept": "权限：沿用归档（{archived}）",
			"error.heading": "导入失败",
			"error.retry": "重新选择文件",
			"error.upload": "上传失败",
		};

		/** English dialog copy. */
		const en = {
			"action.label": "Import session archive",
			"dialog.title": "Import session archive",
			"dialog.description": "Import a session-log ZIP exported by DSH and restore the conversation on this machine.",
			"dialog.close": "Close",
			"pick.title": "Choose a session ZIP exported by DSH",
			"pick.hint": "Drop dsh-session-*.zip here, or click to choose a file. The archive holds session logs and may include sub-sessions, images, and attachments.",
			"pick.choose": "Choose file",
			"pick.dropping": "Release to choose this file",
			"busy.uploading": "Reading the archive…",
			"busy.importing": "Restoring sessions…",
			"preview.heading": "Archive contents",
			"preview.root": "Root session",
			"preview.subagent": "Sub-session",
			"preview.events": "{count} events",
			"preview.conflict": "already exists here",
			"preview.seeded": "seeded history",
			"preview.legacy": "legacy compressed archive",
			"preview.cwdMissing": "workspace missing on this machine",
			"preview.cwdUnusable": "workspace path is not absolute on this platform — choose a target workspace",
			"preview.attachments": "Attachments: {images} images, {files} files",
			"preview.attachmentsNone": "The archive carries no attachments",
			"preview.attachmentsMissing": "{count} referenced attachments are missing from the archive",
			"preview.noStore": "This deployment mounts no attachment store, so images and files cannot be restored",
			"preview.more": "{count} more sub-sessions",
			"preview.warnings": "Notes",
			"options.mode": "Import as",
			"options.mode.restore": "Original identity",
			"options.mode.copy": "Copy",
			"options.modeHint.restore": "Keeps the archived session ids and workspaces; an identity that already exists here switches the import to copy mode.",
			"options.modeHint.copy": "Mints a new identity for every session — the safe choice for archives from another machine.",
			"options.cwd": "Workspace",
			"options.cwd.archive": "Archive workspace",
			"options.cwd.project": "Existing project",
			"options.cwd.custom": "Custom path",
			"options.cwdPlaceholder": "Absolute path on this machine",
			"options.workspaceMap": "Archive workspace {from} → target workspace {to}",
			"options.workspaceArchive": "Keeps the archived workspace: {cwd}",
			"options.workspaceUnusable": "(that path is not usable here — pick a project or type one)",
			"options.projects": "Choose a project",
			"options.permissions": "Permission preset",
			"options.permissions.preset": "This machine's preset",
			"options.permissions.archive": "Keep the archive's",
			"options.permissionsHint": "A restored session starts under this machine's preset ({preset}) instead of inheriting the exporting machine's settings.",
			"options.permissionsArchive": "Archived permissions: {label} (sandbox={sandbox}, approval={approval})",
			"options.permissionsUnavailable": "This deployment mounts no permission presets, so the archive's settings are kept.",
			"options.attachWorkspace": "Group under the matching project (sidebar grouping)",
			"options.media": "Restore images and files",
			"commit": "Start import",
			"cancel": "Cancel",
			"cancelUpload": "Cancel upload",
			"done.heading": "Import finished",
			"done.open": "Open session",
			"done.finish": "Done",
			"done.failed": "failed",
			"done.attachments": "Restored {count} attachments",
			"done.workspace": "Grouped under “{title}” ({path})",
			"done.workspaceCreated": "Created and grouped under “{title}” ({path})",
			"done.workspaceSkipped": "Left ungrouped: {reason}",
			"done.permissions": "Permissions: {archived} → {applied}",
			"done.permissionsKept": "Permissions: kept from the archive ({archived})",
			"error.heading": "Import failed",
			"error.retry": "Choose another file",
			"error.upload": "Upload failed",
		};

		/** Dialog styling; the theme tokens keep it consistent in both themes. */
		const css = [
			// The card is capped against the modal's own padded overlay box (never a
			// viewport calc of our own), and hands its content region the scroll, so
			// the footer — a sibling of that region — always stays in view.
			"div.ssr-dialog{box-sizing:border-box;width:min(560px,100%);max-height:100%;overflow:hidden}",
			"@supports (height:100dvh){div.ssr-dialog{max-height:calc(100dvh - 2 * max(24px,var(--dsh-frame-overlay-top,24px)))}}",
			"div.ssr-content{min-height:0;overflow-y:auto;overscroll-behavior:contain;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}",
			".ssr-drop{border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.4));border-radius:10px;padding:22px 16px;text-align:center;transition:background-color 120ms ease,border-color 120ms ease;cursor:pointer}",
			".ssr-drop[data-dragging='true']{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent)}",
			".ssr-dropTitle{font-size:13px;margin:0 0 6px}",
			".ssr-dropHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,inherit);margin:0 0 12px}",
			".ssr-section{margin-top:16px}",
			".ssr-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,inherit);margin:0 0 8px}",
			".ssr-card{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.25));border-radius:8px;padding:10px 12px;margin-bottom:8px}",
			".ssr-rowTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}",
			".ssr-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}",
			".ssr-excerpt{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);margin:6px 0 0;overflow-wrap:anywhere}",
			".ssr-meta{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);margin:6px 0 0}",
			".ssr-list{margin:0;padding-left:18px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,inherit)}",
			".ssr-list li{overflow-wrap:anywhere}",
			".ssr-busy{display:flex;align-items:center;gap:10px;padding:16px 0;font-size:13px}",
			".ssr-result{font-size:12px;line-height:1.6}",
			".ssr-input{width:100%}",
			".ssr-pills{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0;max-height:132px;overflow-y:auto}",
			".ssr-pillLabel{font-size:12px;line-height:1.55;margin:2px 0 0}",
		].join("");

		/** Inject the dialog stylesheet once per document. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-session-restore/dialog.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-restore";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** A one-line description of a caught value. */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/** Read the JSON envelope the host routes answer with. */
		async function readEnvelope(response) {
			const text = await response.text();
			if (response.status !== 200) {
				throw new Error(`HTTP ${String(response.status)}${text === "" ? "" : ` ${text.slice(0, 300)}`}`);
			}
			let payload;
			try {
				payload = JSON.parse(text);
			} catch {
				throw new Error(`the host answered with a malformed body: ${text.slice(0, 200)}`);
			}
			if (payload && payload.ok === true) return payload.value;
			const detail = payload && payload.error ? payload.error : {};
			throw new Error(`${detail.message ?? "the host refused the request"}${detail.code === undefined ? "" : ` [${detail.code}]`}`);
		}

		/** Owns one in-flight import and publishes everything the dialog renders. */
		class SessionRestoreController {
			constructor(fetcher) {
				this.fetcher = fetcher ?? ((input, init) => fetch(input, init));
				this.store = createSnapshotStore(INITIAL);
				this.abort = null;
				this.disposed = false;
			}

			/** Open the dialog, optionally bound to the Session whose workspace should be offered. */
			open(sessionId) {
				const current = this.store.getSnapshot();
				this.store.set({ ...INITIAL, open: true, sessionId: sessionId ?? current.sessionId ?? null });
			}

			/** Close the dialog and abandon an unfinished upload. */
			close() {
				const current = this.store.getSnapshot();
				if (!current.open) return;
				if (current.token !== null && (current.phase === "preview" || current.phase === "failed")) this.discard(current.token);
				this.abort?.abort();
				this.abort = null;
				this.store.set({ ...INITIAL, sessionId: current.sessionId });
			}

			/** Publish one partial state update. */
			publish(patch) {
				this.store.update((state) => {
					Object.assign(state, patch);
				});
			}

			/** Stop an in-flight upload and drop its staged archive. */
			cancel() {
				this.abort?.abort();
				this.abort = null;
				const current = this.store.getSnapshot();
				if (current.token !== null) this.discard(current.token);
				this.publish({ ...INITIAL, open: current.open, sessionId: current.sessionId });
			}

			/** Stage one uploaded archive and show its preview. */
			async upload(file, sessionId) {
				if (this.disposed || file === undefined || file === null) return;
				const abort = new AbortController();
				this.abort = abort;
				this.publish({
					...INITIAL,
					open: true,
					sessionId: sessionId ?? this.store.getSnapshot().sessionId ?? null,
					phase: "uploading",
					fileName: file.name ?? null,
				});
				try {
					const query = new URLSearchParams();
					if (file.name !== undefined && file.name !== "") query.set("name", file.name);
					const bound = this.store.getSnapshot().sessionId;
					if (bound !== null && bound !== undefined) query.set("sessionId", String(bound));
					const response = await this.fetcher(`${PREVIEW_ROUTE}?${query.toString()}`, {
						method: "POST",
						headers: { "content-type": "application/zip" },
						body: file,
						signal: abort.signal,
					});
					const value = await readEnvelope(response);
					if (abort.signal.aborted) return;
					const permissions = value.permissions ?? {};
					const archiveUsable = Boolean(value.root) && value.root.cwdExists === true && value.root.cwdUsable !== false;
					// The target defaults to the workspace the person is working in
					// (what the preview suggests); the archive's own workspace is
					// only the default when this host can actually use it.
					const suggested = value.suggestedCwd ?? "";
					const project = (value.workspaces ?? []).find((entry) => entry.path === suggested || entry.cwd === suggested);
					this.publish({
						phase: "preview",
						token: value.token,
						preview: value,
						mode: value.conflicts && value.conflicts.length > 0 ? "copy" : "restore",
						cwd: suggested,
						cwdMode: suggested === "" ? "archive" : archiveUsable && value.suggestedSource === "archive" ? "archive" : "project",
						projectId: project?.id ?? null,
						permissionsMode: permissions.configurable === false ? "archive" : "preset",
						permission: permissions.configurable === false ? "" : permissions.defaultPreset ?? permissions.available?.[0] ?? "",
						attachWorkspace: value.workspaceRegistryAvailable !== false,
						importMedia: Boolean(value.attachments && value.attachments.storeAvailable),
					});
				} catch (error) {
					if (abort.signal.aborted) return;
					this.publish({ phase: "failed", error: messageOf(error) });
				} finally {
					if (this.abort === abort) this.abort = null;
				}
			}

			/** Update one dialog option. */
			option(patch) {
				this.publish(patch);
			}

			/** Restore the staged archive. */
			async commit() {
				const current = this.store.getSnapshot();
				if (this.disposed || current.token === null) return;
				const abort = new AbortController();
				this.abort = abort;
				this.publish({ phase: "importing", error: null });
				try {
					const response = await this.fetcher(COMMIT_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							token: current.token,
							mode: current.mode,
							cwd: current.cwdMode === "archive" ? "" : current.cwd,
							importMedia: current.importMedia,
							attachWorkspace: current.attachWorkspace,
							permissions: current.permissionsMode === "archive" ? "keep-archive" : current.permission || "machine-default",
						}),
						signal: abort.signal,
					});
					const value = await readEnvelope(response);
					if (abort.signal.aborted) return;
					this.publish({ phase: "done", result: value, token: null });
				} catch (error) {
					if (abort.signal.aborted) return;
					this.publish({ phase: "failed", error: messageOf(error) });
				} finally {
					if (this.abort === abort) this.abort = null;
				}
			}

			/** Delete one staged archive without restoring it. */
			async discard(token) {
				try {
					await this.fetcher(DISCARD_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ token }),
					});
				} catch {
					// A staged upload that outlives the dialog expires on its own.
				}
			}

			/** Abort in-flight work and reach quiescence. */
			async dispose() {
				this.disposed = true;
				this.abort?.abort();
				this.abort = null;
			}
		}

		/** A small badge row. */
		function badges(children) {
			return h("div", { className: "ssr-rowTitle" }, children);
		}

		/** One session card in the preview. */
		function SessionCard({ entry, t }) {
			const tags = [
				h(primitives.Tag, { key: "role", tone: entry.root ? "brand" : "outline" }, t(entry.root ? "preview.root" : "preview.subagent")),
				h(primitives.Tag, { key: "events", tone: "outline" }, t("preview.events", { count: String(entry.events ?? 0) })),
			];
			if (entry.conflict) tags.push(h(primitives.Tag, { key: "conflict", tone: "warning" }, t("preview.conflict")));
			if (entry.isSeeded) tags.push(h(primitives.Tag, { key: "seeded", tone: "outline" }, t("preview.seeded")));
			if (entry.legacy) tags.push(h(primitives.Tag, { key: "legacy", tone: "outline" }, t("preview.legacy")));
			const meta = [];
			if (entry.title) meta.push(entry.title);
			if (entry.createdAt) meta.push(new Date(entry.createdAt).toLocaleString());
			if (entry.agentPreset) meta.push(`preset: ${entry.agentPreset}`);
			return h("div", { className: "ssr-card" }, [
				badges(tags),
				h("p", { className: "ssr-id", key: "id" }, entry.id),
				entry.excerpt ? h("p", { className: "ssr-excerpt", key: "excerpt" }, entry.excerpt) : null,
				meta.length > 0 ? h("p", { className: "ssr-meta", key: "meta" }, meta.join(" · ")) : null,
				entry.cwd
					? h("p", { className: "ssr-meta", key: "cwd" }, `${entry.cwd}${entry.cwdUsable === false ? ` · ${t("preview.cwdUnusable")}` : entry.cwdExists ? "" : ` · ${t("preview.cwdMissing")}`}`)
					: null,
			]);
		}

		/** The import dialog, rendered inside the Session header entry. */
		function SessionRestoreDialog(props) {
			const { sessionId, t } = props;
			const state = props.useSessionRestore((value) => value);
			const fileInput = React.useRef(null);
			const [dragging, setDragging] = React.useState(false);
			if (!state.open) return null;
			const phase = state.phase;
			const preview = state.preview;
			// A preview from an older host (or a half-filled one) must still render.
			const projects = preview?.workspaces ?? [];
			const permissions = preview?.permissions ?? {};
			const description = phase === "uploading"
				? t("busy.uploading")
				: phase === "importing"
					? t("busy.importing")
					: t("dialog.description");

			const pick = (file) => {
				if (file !== undefined && file !== null) props.select(file, sessionId);
			};

			const body = [];
			if (phase === "idle" || phase === "uploading" || phase === "failed") {
				if (phase === "failed" && state.error) {
					body.push(h("p", { className: "ssr-excerpt", key: "error" }, state.error));
				}
				body.push(h("div", {
					key: "drop",
					className: "ssr-drop",
					"data-dragging": String(dragging),
					onClick: () => fileInput.current?.click(),
					onDragOver: (event) => {
						event.preventDefault();
						setDragging(true);
					},
					onDragLeave: () => setDragging(false),
					onDrop: (event) => {
						event.preventDefault();
						setDragging(false);
						pick(event.dataTransfer?.files?.[0]);
					},
				}, [
					h("p", { className: "ssr-dropTitle", key: "title" }, phase === "uploading" ? t("busy.uploading") : t("pick.title")),
					h("p", { className: "ssr-dropHint", key: "hint" }, dragging ? t("pick.dropping") : t("pick.hint")),
					h(primitives.Button, {
						key: "choose",
						variant: "outline",
						size: "sm",
						disabled: phase === "uploading",
						onClick: (event) => {
							event.stopPropagation();
							fileInput.current?.click();
						},
					}, t("pick.choose")),
					h("input", {
						key: "input",
						ref: fileInput,
						type: "file",
						accept: ".zip,application/zip,application/x-zip-compressed",
						style: { display: "none" },
						onChange: (event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							pick(file);
						},
					}),
				]));
			}

			if ((phase === "preview" || phase === "importing") && preview) {
				body.push(h("div", { className: "ssr-section", key: "content" }, [
					h("p", { className: "ssr-sectionTitle", key: "title" }, t("preview.heading")),
					h(SessionCard, { key: "root", entry: preview.root, t }),
					preview.descendants.length > 0
						? h("div", { key: "descendants" }, [
							h("p", { className: "ssr-sectionTitle" }, t("preview.more", { count: String(preview.descendants.length) })),
							...preview.descendants.slice(0, LIST_LIMIT).map((entry) => h(SessionCard, { key: entry.id, entry, t })),
						])
						: null,
					h("p", { className: "ssr-meta", key: "attachments" }, preview.attachments.images + preview.attachments.files === 0
						? t("preview.attachmentsNone")
						: t("preview.attachments", { images: String(preview.attachments.images), files: String(preview.attachments.files) })),
					preview.attachments.missingImages + preview.attachments.missingFiles > 0
						? h("p", { className: "ssr-meta", key: "missing" }, t("preview.attachmentsMissing", { count: String(preview.attachments.missingImages + preview.attachments.missingFiles) }))
						: null,
					preview.attachments.storeAvailable === false
						? h("p", { className: "ssr-meta", key: "nostore" }, t("preview.noStore"))
						: null,
					preview.warnings.length > 0
						? h("div", { key: "warnings" }, [
							h("p", { className: "ssr-sectionTitle" }, t("preview.warnings")),
							h("ul", { className: "ssr-list" }, preview.warnings.slice(0, 6).map((warning, index) => h("li", { key: index }, warning))),
						])
						: null,
				]));
				body.push(h("div", { className: "ssr-section", key: "options" }, [
					h("p", { className: "ssr-sectionTitle", key: "mode" }, t("options.mode")),
					h(primitives.SegmentedControl, {
						key: "mode",
						id: "ssr-mode",
						label: t("options.mode"),
						value: state.mode,
						disabled: phase === "importing",
						options: [
							{ value: "restore", label: t("options.mode.restore") },
							{ value: "copy", label: t("options.mode.copy") },
						],
						onChange: (value) => props.option({ mode: value }),
					}),
					h("p", { className: "ssr-meta", key: "modeHint" }, t(state.mode === "copy" ? "options.modeHint.copy" : "options.modeHint.restore")),
					h("p", { className: "ssr-sectionTitle", key: "cwdTitle" }, t("options.cwd")),
					h(primitives.SegmentedControl, {
						key: "cwdMode",
						id: "ssr-cwd-mode",
						label: t("options.cwd"),
						value: state.cwdMode,
						disabled: phase === "importing",
						options: [
							{ value: "archive", label: t("options.cwd.archive") },
							{ value: "project", label: t("options.cwd.project") },
							{ value: "custom", label: t("options.cwd.custom") },
						],
						onChange: (value) => props.option({ cwdMode: value }),
					}),
					state.cwdMode === "project"
						? h("div", { className: "ssr-pills", key: "projects" },
							projects.slice(0, 12).map((entry) => h(primitives.Pill, {
								key: entry.id ?? entry.path,
								active: state.projectId !== null ? state.projectId === entry.id : state.cwd === entry.path,
								onClick: () => props.option({ projectId: entry.id ?? null, cwd: entry.path }),
							}, entry.title === "" ? entry.path : entry.title)))
						: null,
					state.cwdMode === "custom"
						? h(primitives.Input, {
							key: "cwdCustom",
							className: "ssr-input",
							value: state.cwd,
							placeholder: t("options.cwdPlaceholder"),
							disabled: phase === "importing",
							onChange: (event) => props.option({ cwd: event.target.value }),
						})
						: null,
					h("p", { className: "ssr-pillLabel", key: "cwdMap" }, state.cwdMode === "archive"
						? t("options.workspaceArchive", { cwd: preview.root.cwd ?? "" })
						: t("options.workspaceMap", { from: preview.root.cwd ?? "", to: state.cwd })),
					preview.root.cwd !== null && (preview.root.cwdUsable === false || preview.root.cwdExists === false)
						? h("p", { className: "ssr-meta", key: "cwdWarn" }, t("options.workspaceUnusable"))
						: null,
					h("p", { className: "ssr-sectionTitle", key: "permTitle" }, t("options.permissions")),
					h(primitives.SegmentedControl, {
						key: "permissionsMode",
						id: "ssr-permissions-mode",
						label: t("options.permissions"),
						value: state.permissionsMode,
						disabled: phase === "importing" || permissions.configurable === false,
						options: [
							{ value: "preset", label: t("options.permissions.preset") },
							{ value: "archive", label: t("options.permissions.archive") },
						],
						onChange: (value) => props.option({ permissionsMode: value }),
					}),
					state.permissionsMode === "preset"
						? h("div", { className: "ssr-pills", key: "presets" },
							(permissions.available ?? []).map((name) => h(primitives.Pill, {
								key: name,
								active: state.permission === name,
								onClick: () => props.option({ permission: name }),
							}, name)))
						: null,
					h("p", { className: "ssr-meta", key: "permHint" }, permissions.configurable === false
						? t("options.permissionsUnavailable")
						: t("options.permissionsHint", { preset: state.permission })),
					h("p", { className: "ssr-meta", key: "permArchive" }, t("options.permissionsArchive", {
						label: permissions.label,
						sandbox: String(permissions.sandbox),
						approval: String(permissions.approval),
					})),
					h(primitives.Checkbox, {
						key: "attach",
						checked: state.attachWorkspace,
						disabled: phase === "importing" || preview.workspaceRegistryAvailable === false,
						label: t("options.attachWorkspace"),
						onChange: (checked) => props.option({ attachWorkspace: checked }),
					}),
					h(primitives.Checkbox, {
						key: "media",
						checked: state.importMedia,
						disabled: phase === "importing" || preview.attachments.storeAvailable === false,
						label: t("options.media"),
						onChange: (checked) => props.option({ importMedia: checked }),
					}),
				]));
			}

			if (phase === "done" && state.result) {
				const rows = state.result.sessions.map((session) => h("li", { key: session.id },
					session.status === "restored"
						? `${session.role === "root" ? t("preview.root") : t("preview.subagent")} ${session.id} · ${t("preview.events", { count: String(session.events) })}${session.title ? ` · ${session.title}` : ""}`
						: `${session.originalId} · ${t("done.failed")}: ${session.error ?? ""}`));
				const root = state.result.sessions.find((session) => session.role === "root" && session.status === "restored");
				// A refused Session always earns a line; restored sub-Sessions are
				// summarized past the limit, so a large archive cannot bury the
				// outcome (the preview lists them the same way).
				const children = state.result.sessions.filter((session) => session.role !== "root" && session.status === "restored");
				const order = [
					...state.result.sessions.filter((session) => session.role === "root"),
					...state.result.sessions.filter((session) => session.status !== "restored"),
					...children.slice(0, LIST_LIMIT),
				];
				const shown = order.map((session) => rows[state.result.sessions.indexOf(session)]);
				const hidden = children.length - Math.min(children.length, LIST_LIMIT);
				const notes = [];
				if (root?.attachment?.attached === true) {
					notes.push(h("p", { className: "ssr-meta", key: "workspace" }, t(root.attachment.created === true ? "done.workspaceCreated" : "done.workspace", {
						title: root.attachment.workspace?.title ?? "",
						path: root.attachment.workspace?.path ?? "",
					})));
				} else if (root !== undefined) {
					notes.push(h("p", { className: "ssr-meta", key: "workspace" }, t("done.workspaceSkipped", { reason: String(root.attachment?.reason ?? "") })));
				}
				if (root?.permissions !== undefined) {
					notes.push(h("p", { className: "ssr-meta", key: "permissions" }, root.permissions.applied === null
						? t("done.permissionsKept", { archived: String(root.permissions.archived) })
						: t("done.permissions", { archived: String(root.permissions.archived), applied: String(root.permissions.applied) })));
				}
				body.push(h("div", { className: "ssr-section ssr-result", key: "result" }, [
					h("p", { className: "ssr-sectionTitle", key: "title" }, t("done.heading")),
					h("ul", { className: "ssr-list", key: "rows" }, shown),
					hidden > 0
						? h("p", { className: "ssr-meta", key: "more" }, t("preview.more", { count: String(hidden) }))
						: null,
					...notes,
					state.result.media && state.result.media.restored > 0
						? h("p", { className: "ssr-meta", key: "media" }, t("done.attachments", { count: String(state.result.media.restored) }))
						: null,
					...state.result.warnings.slice(0, 6).map((warning, index) => h("p", { className: "ssr-meta", key: `warning-${String(index)}` }, warning)),
				]));
			}

			let footer = null;
			if (phase === "preview" || phase === "importing") {
				footer = [
					h(primitives.Button, {
						key: "cancel",
						variant: "outline",
						onClick: () => props.cancel(sessionId),
						children: t("cancel"),
					}),
					h(primitives.Button, {
						key: "commit",
						variant: "primary",
						disabled: phase === "importing",
						onClick: () => props.commit(),
						children: t("commit"),
					}),
				];
			} else if (phase === "done") {
				const rootId = state.result?.rootId;
				footer = [
					rootId ? h(primitives.Button, {
						key: "open",
						variant: "outline",
						onClick: () => props.openSession(rootId),
						children: t("done.open"),
					}) : null,
					h(primitives.Button, {
						key: "finish",
						variant: "primary",
						onClick: () => props.closeDialog(),
						children: t("done.finish"),
					}),
				].filter(Boolean);
			} else if (phase === "uploading") {
				footer = [h(primitives.Button, { key: "cancel", variant: "outline", onClick: () => props.cancel(sessionId), children: t("cancelUpload") })];
			} else {
				footer = [h(primitives.Button, { key: "close", variant: "outline", onClick: () => props.closeDialog(), children: t("dialog.close") })];
			}

			return h(primitives.Modal, {
				open: true,
				onClose: () => props.closeDialog(),
				title: phase === "failed" ? t("error.heading") : phase === "done" ? t("done.heading") : t("dialog.title"),
				description,
				closeLabel: t("dialog.close"),
				// The primitive's own hooks: the card gets the height cap, the content
				// region gets the scroll (the footer sits outside it and stays put).
				className: "ssr-dialog",
				contentClassName: "ssr-content",
				footer: h(React.Fragment, null, footer),
			}, body);
		}

		/** The compact Session-header trigger; the dialog itself lives in the sidebar. */
		function SessionRestoreHeaderAction(props) {
			const { sessionId, t } = props;
			const state = props.useSessionRestore((value) => value);
			const busy = state.phase === "uploading" || state.phase === "importing";
			return h(primitives.Button, {
				size: "sm",
				variant: "ghost",
				"aria-label": t("action.label"),
				"aria-busy": busy,
				title: t("action.label"),
				onClick: () => props.open(sessionId ?? props.boundSessionId),
				icon: h(primitives.IconUnarchiveOutlineRegular, {}),
			});
		}

		/**
		 * The sidebar-foot entry. It owns the dialog, because the sidebar — unlike
		 * a Session header — is mounted whether or not a Session is open.
		 */
		function SessionRestoreFooterAction(props) {
			const { t, wide } = props;
			const state = props.useSessionRestore((value) => value);
			const busy = state.phase === "uploading" || state.phase === "importing";
			return h(React.Fragment, null, [
				h(primitives.Button, {
					key: "action",
					variant: "ghost",
					"aria-label": t("action.label"),
					"aria-busy": busy,
					title: t("action.label"),
					onClick: () => props.open(props.boundSessionId),
					icon: h(primitives.IconUnarchiveOutlineRegular, {}),
				}, wide === true ? t("action.label") : null),
				h(SessionRestoreDialog, { ...props, key: "dialog" }),
			]);
		}

		/** Required client services: the slot registry and the dictionaries. */
		const inject = ["slots", "locale"];

		/**
		 * Mount the header trigger, the sidebar entry with its dialog, and keep the
		 * Session list fresh after a `/import` command.
		 */
		function apply(ctx) {
			ensureStyles();
			const controller = new SessionRestoreController();
			ctx.provide("sessionRestore", controller);
			ctx.effect(() => async () => {
				await controller.dispose();
			}, "session-restore: browser lifecycle");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-restore: browser dictionaries");
			const serviceOf = (key) => {
				try {
					return ctx.get(key);
				} catch {
					return undefined;
				}
			};
			const refreshSessions = () => {
				const sessions = serviceOf("sessions");
				if (sessions !== undefined && typeof sessions.refresh === "function") void sessions.refresh();
			};
			// Attaching a restored Session to an existing project pushes an upsert
			// frame on its own; a project this import *created* is outside the
			// client's baseline, so ask the workspace model to re-pull when it can.
			const refreshWorkspaces = () => {
				const workspaces = serviceOf("workspaces");
				if (workspaces === undefined) return;
				for (const method of ["refresh", "reload", "refreshSnapshot"]) {
					if (typeof workspaces[method] === "function") {
						try {
							void workspaces[method]();
						} catch {
							// A failed re-pull leaves the baseline as it was; the next
							// reconnect re-reads it.
						}
						return;
					}
				}
			};
			const refreshAfterImport = () => {
				refreshSessions();
				refreshWorkspaces();
			};
			ctx.on("command/executed", (_sessionId, commandName, result) => {
				if (commandName === "import" && result !== undefined && result.kind === "success") refreshAfterImport();
			});
			/** The props both entries share; `boundSessionId` binds the Session header seat. */
			const face = (boundSessionId) => ({
				hooks: { sessionRestore: controller.store },
				boundSessionId,
				open: (sessionId) => controller.open(sessionId ?? boundSessionId),
				closeDialog: () => {
					const state = controller.store.getSnapshot();
					controller.close();
					if (state.phase === "done") refreshAfterImport();
				},
				cancel: () => controller.cancel(),
				select: (file, sessionId) => void controller.upload(file, sessionId ?? boundSessionId),
				option: (patch) => controller.option(patch),
				commit: () => void controller.commit(),
				openSession: (id) => {
					controller.close();
					refreshAfterImport();
					serviceOf("uiWorkspace")?.openSession(id);
				},
			});
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
				name: "conversation.session.header.utilities",
				id: "session-restore",
				order: 20,
				locale: NS,
				inject: (sessionId) => face(sessionId),
			}, SessionRestoreHeaderAction));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "session-restore",
				order: 30,
				locale: NS,
				inject: () => face(undefined),
			}, SessionRestoreFooterAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
