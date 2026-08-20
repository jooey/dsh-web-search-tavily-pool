/**
 * dsh-web-search-tavily
 *
 * A tavily search provider for the DSH web capability seam (`ctx.web`), with
 * multi-key rotation: keys are read from the credentials service
 * (`TAVILY_API_KEYS`, comma/space separated; `TAVILY_API_KEY` as the
 * single-key fallback) and rotated round-robin. A key that answers with an
 * auth/quota/rate/server error is cooled down (432/433 plan-quota codes for
 * 30 minutes — monthly quotas do not recover in minutes; 429 for 1 minute;
 * other retryable codes for 5 minutes) and the next active key retries.
 *
 * A real (non-sandboxed) host plugin: uses native fetch directly.
 */

import z from "@deepseek-ai/schemastery";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-tavily";
/** The web seam this provider registers into. */
export const inject = ["web"];

const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com/search";
const KEY_REFS = ["TAVILY_API_KEYS", "TAVILY_API_KEY"];
const RETRYABLE = /^(401|402|403|408|429|432|433|500|502|503|504)$/;
const QUOTA_CODES = /^(432|433)$/;

/** All live provider instances (this package loads once; the strategy child
 *  and the standalone registration share the module). */
const INSTANCES = new Set();

/** Re-warm every live provider after a pool mutation. */
async function rewarmAllTavilyInstances() {
	await Promise.allSettled([...INSTANCES].map((provider) => provider.warmKeys()));
}

/** Per-key managed state file (authoritative once it exists). */
function keyStateFile() {
	const os = globalThis.process?.getBuiltinModule?.("node:os");
	const path = globalThis.process?.getBuiltinModule?.("node:path");
	if (os === undefined || path === undefined) return undefined;
	return path.join(os.homedir(), ".dsh", ".dsh-web-search-tavily.json");
}

/** Read managed entries [{key, disabled}]; undefined when the file is absent. */
function readKeyState() {
	const fs = globalThis.process?.getBuiltinModule?.("node:fs");
	const file = keyStateFile();
	if (fs === undefined || file === undefined || !fs.existsSync(file)) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!Array.isArray(parsed?.keys)) return undefined;
		const entries = parsed.keys
			.map((entry) => (typeof entry === "string" ? { key: entry, disabled: false } : {
				key: typeof entry?.key === "string" ? entry.key : "",
				disabled: entry?.disabled === true
			}))
			.filter((entry) => entry.key !== "");
		return entries.length > 0 ? entries : undefined;
	} catch {
		return undefined;
	}
}

/** Persist managed entries (JSON state + the credentials line, for coherence
 *  with the legacy read path), then re-warm every live provider. */
function writeKeyState(entries) {
	const fs = globalThis.process?.getBuiltinModule?.("node:fs");
	const os = globalThis.process?.getBuiltinModule?.("node:os");
	const path = globalThis.process?.getBuiltinModule?.("node:path");
	if (fs === undefined || os === undefined || path === undefined) throw new Error("node fs/os/path unavailable");
	const file = keyStateFile();
	fs.writeFileSync(file, `${JSON.stringify({ keys: entries }, null, 2)}\n`, "utf8");
	// keep TAVILY_API_KEYS in the credentials file mirroring the pool so the
	// fallback read path (and any external tooling) stays in sync
	const credFile = path.join(os.homedir(), ".dsh", ".credentials.yaml");
	try {
		const text = fs.readFileSync(credFile, "utf8");
		const line = `TAVILY_API_KEYS: ${entries.map((entry) => entry.key).join(",")}`;
		const next = /^TAVILY_API_KEYS:.*$/m.test(text)
			? text.replace(/^TAVILY_API_KEYS:.*$/m, line)
			: `${text.replace(/\n*$/, "\n")}${line}\n`;
		if (next !== text) {
			const tmp = `${credFile}.tavily-tmp`;
			fs.writeFileSync(tmp, next, { encoding: "utf8", mode: 0o600 });
			fs.chmodSync(tmp, 0o600);
			fs.renameSync(tmp, credFile);
			fs.chmodSync(credFile, 0o600);
		}
	} catch {
		// the JSON state file is authoritative; a stale mirror is not fatal
	}
}

export const Config = z.object({
	baseURL: z.string().default(TAVILY_DEFAULT_BASE_URL),
	timeoutMs: z.number().step(1).min(1000).default(20000),
	maxResults: z.number().step(1).min(1).default(8),
	searchDepth: z.string().default("basic")
});

/** Split a raw credential into deduped non-empty keys. */
function parseKeys(raw) {
	const seen = new Set();
	const keys = [];
	for (const part of String(raw).split(/[\s,;]+/)) {
		const key = part.trim();
		if (key === "" || seen.has(key)) continue;
		seen.add(key);
		keys.push(key);
	}
	return keys;
}

/** Stringify a Tavily error detail that may be a string, an object, or absent. */
function describeDetail(detail) {
	if (detail === undefined || detail === null) return "";
	if (typeof detail === "string") return detail.slice(0, 160);
	if (typeof detail === "object") {
		const inner = detail.error !== undefined ? detail.error : detail.message;
		if (typeof inner === "string") return inner.slice(0, 160);
		try {
			return JSON.stringify(detail).slice(0, 160);
		} catch {
			return String(detail);
		}
	}
	return String(detail).slice(0, 160);
}

/**
 * The tavily-backed search provider. Rotation state (key pool, cursor,
 * cooldowns, disabled flags) is provider-private; the options thunk is
 * snapshotted per operation so a settings change never mixes into one search.
 */
class TavilySearchProvider {
	constructor(resolveOptions) {
		this.resolveOptions = resolveOptions;
		this.id = "tavily";
		this.keys = [];
		this.cursor = 0;
		this.cooldown = new Map();
		this.disabled = new Set();
		this.warmed = false;
		// every constructed provider shares one key pool file; the admin gateway
		// re-warms all of them on mutation (the strategy package builds its own
		// tavily child from this same module instance)
		INSTANCES.add(this);
	}

	/** Always usable when configured: a missing key surfaces as a clear search error. */
	available() {
		return true;
	}

	/** Black-box flight recorder: the live process is hard to observe, so key
	 *  lifecycle events land in a file we can read back. No-op on failure. */
	debug(line) {
		try {
			const fs = globalThis.process?.getBuiltinModule?.("node:fs");
			if (fs !== undefined) fs.appendFileSync("/tmp/dsh-tavily-debug.log", `${new Date().toISOString()} [${this.id}] ${line}\n`);
		} catch {
			// diagnostics must never break the provider
		}
	}

	/** Re-read the key pool. Priority: managed JSON state (per-key disabled
	 *  flags, written by the settings UI) → credentials service → the
	 *  credentials file directly. Cooldowns and disabled flags survive. */
	async warmKeys() {
		let raw = "";
		let entries = readKeyState();
		if (entries !== undefined) {
			this.debug(`warmKeys: ${entries.length} managed entries from state file`);
			const seen = new Set();
			this.keys = [];
			this.disabled = new Set();
			for (const entry of entries) {
				if (seen.has(entry.key)) continue;
				seen.add(entry.key);
				this.keys.push(entry.key);
				if (entry.disabled) this.disabled.add(entry.key);
			}
			this.warmed = true;
			this.debug(`warmKeys done: ${this.keys.length} keys, ${this.disabled.size} disabled`);
			return this.keys;
		}
		const credentials = this.resolveOptions().credentials;
		this.debug(`warmKeys: credentials=${credentials === undefined ? "undefined" : typeof credentials}`);
		if (credentials !== undefined) {
			for (const ref of KEY_REFS) {
				try {
					const resolved = await credentials.resolve(ref);
					this.debug(`  resolve(${ref}) → ${resolved === undefined || resolved === null ? "null" : `${typeof resolved.value} len ${String(resolved.value).length} src ${String(resolved.source)}`}`);
					if (resolved !== undefined && resolved !== null && typeof resolved.value === "string" && resolved.value.length > 0) {
						raw = resolved.value;
						break;
					}
				} catch (error) {
					this.debug(`  resolve(${ref}) threw: ${String(error?.message ?? error).slice(0, 90)}`);
				}
			}
		}
		if (raw === "") {
			// last-resort fallback: the credentials file IS the source of truth for
			// source:"file" entries — read it directly when the service is not
			// reachable from this fiber (full Node plugin, no sandbox).
			try {
				const fs = globalThis.process?.getBuiltinModule?.("node:fs");
				const os = globalThis.process?.getBuiltinModule?.("node:os");
				const path = globalThis.process?.getBuiltinModule?.("node:path");
				if (fs !== undefined && os !== undefined && path !== undefined) {
					const file = path.join(os.homedir(), ".dsh", ".credentials.yaml");
					const text = fs.readFileSync(file, "utf8");
					const match = /^TAVILY_API_KEYS:[ \t]*(.+)$/m.exec(text);
					if (match !== null) {
						raw = match[1].replace(/^['"]|['"]$/g, "");
						this.debug(`  fs fallback read ${raw.length} chars from ${file}`);
					}
				}
			} catch (error) {
				this.debug(`  fs fallback failed: ${String(error?.message ?? error).slice(0, 90)}`);
			}
		}
		const keys = parseKeys(raw);
		const cooldown = new Map();
		for (const key of keys) if (this.cooldown.has(key)) cooldown.set(key, this.cooldown.get(key));
		this.cooldown = cooldown;
		const disabled = new Set([...this.disabled].filter((key) => keys.includes(key)));
		this.disabled = disabled;
		if (keys.length !== this.keys.length) console.log(`[web-search-tavily] configured keys: ${keys.length}`);
		this.keys = keys;
		this.warmed = true;
		this.debug(`warmKeys done: ${keys.length} keys`);
		return keys;
	}

	/** Keys eligible for rotation: not disabled and not cooling down. */
	activeKeys() {
		const now = Date.now();
		return this.keys.filter((key) => {
			if (this.disabled.has(key)) return false;
			const until = this.cooldown.get(key);
			return until === undefined || until <= now;
		});
	}

	/** One search attempt against one key. */
	async searchOnce(key, request, options, signal) {
		const payload = {
			query: request.query,
			max_results: request.maxResults ?? options.maxResults,
			search_depth: options.searchDepth,
			include_answer: false
		};
		const response = await fetch(options.baseURL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${key}`
			},
			body: JSON.stringify(payload),
			signal: signal !== undefined ? signal : AbortSignal.timeout(options.timeoutMs)
		});
		if (!response.ok) {
			let detail = "";
			try {
				const parsed = await response.json();
				detail = describeDetail(parsed.detail !== undefined ? parsed.detail : parsed.message);
			} catch {
				// non-JSON error bodies keep the status line only
			}
			throw new Error(`HTTP ${response.status}${detail !== "" ? `: ${detail}` : ""}`);
		}
		let parsed;
		try {
			parsed = await response.json();
		} catch (error) {
			throw new Error(`tavily returned a non-JSON response: ${String(error)}`);
		}
		const results = Array.isArray(parsed.results) ? parsed.results : [];
		if (results.length === 0) throw new Error("tavily returned 0 results for this query");
		const sources = [];
		for (const item of results) {
			if (item === null || typeof item !== "object" || typeof item.url !== "string" || item.url === "") continue;
			sources.push({
				url: item.url,
				...(typeof item.title === "string" && item.title !== "" ? { title: item.title } : {}),
				...(typeof item.content === "string" && item.content !== "" ? { snippet: item.content.slice(0, 400) } : {}),
				...(typeof item.published_date === "string" && item.published_date !== "" ? { publishedAt: item.published_date } : {})
			});
		}
		return { sources, truncated: false };
	}

	/** Run one search with rotation and cooldown failover. */
	async search(request, signal) {
		const options = this.resolveOptions();
		// Re-warm whenever the pool is empty, not only before the first warm:
		// an apply-time warm that ran before the credentials service was ready
		// must not lock the provider out for the process lifetime.
		if (this.keys.length === 0) await this.warmKeys();
		else this.debug(`search: pool already warm (${this.keys.length} keys, ${this.activeKeys().length} active)`);
		if (this.keys.length === 0) {
			throw new Error('tavily: no API keys configured — store TAVILY_API_KEYS (comma-separated enables rotation) or TAVILY_API_KEY in ~/.dsh/.credentials.yaml');
		}
		let lastError = "";
		for (let attempt = 0; attempt < this.keys.length; attempt++) {
			const pool = this.activeKeys();
			if (pool.length === 0) {
				const disabledCount = this.disabled.size;
				throw new Error(`tavily: no active key (${this.keys.length} configured, ${disabledCount} disabled, rest cooling down); last error: ${lastError}`);
			}
			const key = pool[this.cursor % pool.length];
			this.cursor = (this.cursor + 1) % pool.length;
			try {
				return await this.searchOnce(key, request, options, signal);
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
				const status = /^HTTP (\d+)/.exec(lastError);
				const code = status !== null ? status[1] : "";
				if (code !== "" && RETRYABLE.test(code)) {
					const ms = QUOTA_CODES.test(code) ? 1800000 : code === "429" ? 60000 : 300000;
					this.cooldown.set(key, Date.now() + ms);
					const index = this.keys.indexOf(key) + 1;
					console.log(`[web-search-tavily] key #${index} failed (${lastError.slice(0, 90)}); cooling ${ms / 1000}s, rotating`);
					continue;
				}
				throw error;
			}
		}
		throw new Error(`tavily: every configured key failed; last error: ${lastError}`);
	}
}

/**
 * Build a tavily provider from one options snapshot.
 * `options.credentials` may be the service itself or a () => service getter —
 * a getter keeps apply-time snapshots valid when the credentials service
 * activates after this provider was constructed.
 */
export function createTavilyProvider(options = {}) {
	return new TavilySearchProvider(() => ({
		baseURL: options.baseURL ?? TAVILY_DEFAULT_BASE_URL,
		timeoutMs: options.timeoutMs ?? 20000,
		maxResults: options.maxResults ?? 8,
		searchDepth: options.searchDepth ?? "basic",
		credentials: typeof options.credentials === "function" ? options.credentials() : options.credentials
	}));
}

/** Register the tavily search provider and the admin gateway with `ctx.web`. */
export async function apply(ctx, config = {}) {
	const provider = createTavilyProvider({ ...config, credentials: () => ctx.get("credentials") });
	provider.warmKeys();
	ctx.web.registerSearchProvider(provider);
	ctx.on("credentials/updated", (ref) => {
		if (ref === "TAVILY_API_KEYS" || ref === "TAVILY_API_KEY") {
			console.log("[web-search-tavily] credentials updated, re-warming keys");
			provider.warmKeys();
		}
	});
	await ctx.plugin(TavilyAdminGateway, { provider });
	console.log("[web-search-tavily] registered tavily search provider (multi-key rotation) + admin gateway");
}

// ── admin gateway (browser settings UI bridge) ────────────────────────────

import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

/** Mask one key for display: keep the head and tail only. */
function maskKey(key) {
	return key.length <= 14 ? `${key.slice(0, 4)}…` : `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Host-side remote service for the settings UI: per-key list/add/remove/
 * toggle/test operations plus pool-wide test and cooldown reset. Every
 * mutation persists to ~/.dsh/.dsh-web-search-tavily.json and re-warms ALL
 * live provider instances (including the strategy package's child), so
 * changes apply immediately without a restart.
 */
class TavilyAdminGateway extends TypertRemoteService {
	constructor(ctx, options) {
		super(ctx, "tavilyAdmin");
		this.provider = options.provider;
	}

	/** Managed entries snapshot derived from the live pool. */
	entries() {
		return this.provider.keys.map((key) => ({ key, disabled: this.provider.disabled.has(key) }));
	}

	/** Persist entries and re-warm every live provider instance. */
	async persist(entries) {
		writeKeyState(entries);
		await rewarmAllTavilyInstances();
	}

	/** Pool snapshot: masked keys with status. */
	async listKeys() {
		const now = Date.now();
		const keys = this.provider.keys.map((key, index) => {
			const until = this.provider.cooldown.get(key);
			const cooling = until !== undefined && until > now;
			const disabled = this.provider.disabled.has(key);
			return {
				index: index + 1,
				masked: maskKey(key),
				status: disabled ? "disabled" : cooling ? "cooling" : "active",
				cooldownSecondsLeft: cooling ? Math.ceil((until - now) / 1000) : 0
			};
		});
		return { keys, total: keys.length, active: keys.filter((k) => k.status === "active").length };
	}

	/** Append one new key (deduped). */
	async addKey(key) {
		if (typeof key !== "string" || key.trim() === "") throw new Error("key must be a non-empty string");
		const cleaned = key.trim();
		const entries = this.entries();
		if (entries.some((entry) => entry.key === cleaned)) throw new Error("这把 key 已在池中");
		entries.push({ key: cleaned, disabled: false });
		await this.persist(entries);
		return this.listKeys();
	}

	/** Remove one key by its 1-based index. */
	async removeKey(index) {
		const entries = this.entries();
		if (!Number.isInteger(index) || index < 1 || index > entries.length) throw new Error(`invalid key index ${index}`);
		entries.splice(index - 1, 1);
		await this.persist(entries);
		return this.listKeys();
	}

	/** Flip the disabled flag of one key by its 1-based index. */
	async toggleKey(index) {
		const entries = this.entries();
		if (!Number.isInteger(index) || index < 1 || index > entries.length) throw new Error(`invalid key index ${index}`);
		entries[index - 1].disabled = !entries[index - 1].disabled;
		await this.persist(entries);
		return this.listKeys();
	}

	/** Probe one key by its 1-based index with a real 1-result search. */
	async testKey(index) {
		if (!Number.isInteger(index) || index < 1 || index > this.provider.keys.length) throw new Error(`invalid key index ${index}`);
		const key = this.provider.keys[index - 1];
		const startedAt = Date.now();
		try {
			await this.provider.searchOnce(key, { query: "tavily key health check", maxResults: 1 }, this.provider.resolveOptions(), undefined);
			return { index, masked: maskKey(key), ok: true, ms: Date.now() - startedAt };
		} catch (error) {
			return { index, masked: maskKey(key), ok: false, ms: Date.now() - startedAt, error: String(error?.message ?? error).slice(0, 140) };
		}
	}

	/** Probe every configured key. */
	async testAll() {
		const results = [];
		for (let i = 1; i <= this.provider.keys.length; i++) results.push(await this.testKey(i));
		return { results, at: new Date().toISOString() };
	}

	/** Drop all cooldowns on every live instance so keys retry now. */
	async resetCooldowns() {
		for (const provider of INSTANCES) provider.cooldown.clear();
		return this.listKeys();
	}
}
