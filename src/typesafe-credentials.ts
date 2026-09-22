import { createHash } from "node:crypto";

/**
 * One global TypeSafe credential shared by every prjct extension. The store and
 * the record format live next to `openSecretPrompt` on purpose: a second
 * implementation of this encoding would silently stop reading the key its
 * sibling extension saved, and the user would be asked to paste it again with
 * no way to tell why.
 */
export const KEYRING_SERVICE = "ai.typesafe";
export const KEYRING_ACCOUNT = "api-key";

export const CREDENTIAL_STATES = ["missing", "invalid", "usable", "inaccessible"] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

export type SecretStore = {
	get: (account: string) => Promise<string | null>;
	set: (account: string, secret: string) => Promise<void>;
	delete: (account: string) => Promise<void>;
};

export type ResolvedKey = {
	key?: string;
	state: CredentialState;
	source: "env" | "keyring" | "none";
	detail: string;
	verified?: boolean;
	verifiedAt?: string;
	fingerprint?: string;
};

type KeyRecord = {
	version: 1;
	key: string;
	verifiedAt?: string;
};

/** Stable global OS-keyring identity, independent of extension build and install paths. */
export type KeyringEntry = {
	getPassword: () => Promise<string | null | undefined>;
	setPassword: (secret: string) => Promise<unknown>;
	deletePassword: () => Promise<unknown>;
};

/**
 * The keyring entries are injected rather than constructed here so this kit
 * keeps no runtime dependency; each extension brings its own `@napi-rs/keyring`.
 */
export function keyringStoreFromEntries(globalEntry: KeyringEntry, legacyEntries: KeyringEntry[] = []): SecretStore {
	const read = async (entry: KeyringEntry): Promise<string | null> => {
		try { return (await entry.getPassword()) ?? null; }
		catch (error) { if (isMissing(error)) return null; throw inaccessible(); }
	};
	const remove = async (entry: KeyringEntry): Promise<void> => {
		try { await entry.deletePassword(); }
		catch (error) { if (!isMissing(error)) throw inaccessible(); }
	};
	const migrateLegacy = async (): Promise<string | null> => {
		const candidates = await Promise.all(legacyEntries.map(read));
		const index = candidates.findIndex(Boolean);
		const secret = index >= 0 ? candidates[index] ?? null : null;
		if (!secret) return null;
		if (secret === "typesafe-api-key") {
			await remove(legacyEntries[index]!);
			return null;
		}
		try {
			await globalEntry.setPassword(secret);
			await remove(legacyEntries[index]!);
			return secret;
		} catch {
			throw inaccessible();
		}
	};
	return {
		get: async () => (await read(globalEntry)) ?? migrateLegacy(),
		set: async (_account, secret) => {
			try { await globalEntry.setPassword(secret); }
			catch { throw inaccessible(); }
		},
		delete: async () => { await Promise.all([remove(globalEntry), ...legacyEntries.map(remove)]); },
	};
}

/**
 * Environment first, keyring second. A key exported for one process is a
 * deliberate override and is never copied into the shared keyring.
 */
export async function resolveKey(store: SecretStore, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedKey> {
	const fromEnv = env.TYPESAFE_API_KEY?.trim();
	if (fromEnv) {
		return keyHasValidShape(fromEnv)
			? { key: fromEnv, state: "usable", source: "env", detail: `TYPESAFE_API_KEY is set for this process and is not copied into the keyring. Fingerprint ${fingerprintOf(fromEnv)}.`, verified: false, fingerprint: fingerprintOf(fromEnv) }
			: { state: "invalid", source: "env", detail: "TYPESAFE_API_KEY is set but is not a usable key.", verified: false };
	}
	try {
		const stored = await store.get(KEYRING_ACCOUNT);
		if (!stored) return { state: "missing", source: "none", detail: "No TypeSafe key in the OS keyring.", verified: false };
		const record = decode(stored);
		if (!record || !keyHasValidShape(record.key)) {
			return { state: "invalid", source: "keyring", detail: "The stored TypeSafe key is not usable.", verified: false };
		}
		return {
			key: record.key,
			state: "usable",
			source: "keyring",
			detail: record.verifiedAt ? `TypeSafe key ${fingerprintOf(record.key)} verified ${record.verifiedAt}.` : `TypeSafe key ${fingerprintOf(record.key)} is stored in the OS keyring; test it once to persist verification.`,
			verified: Boolean(record.verifiedAt),
			verifiedAt: record.verifiedAt,
			fingerprint: fingerprintOf(record.key),
		};
	} catch (error) {
		return { state: "inaccessible", source: "keyring", detail: error instanceof Error ? error.message : "OS keyring is inaccessible.", verified: false };
	}
}

export async function saveKey(store: SecretStore, key: string, verified = false): Promise<ResolvedKey> {
	if (!keyHasValidShape(key)) return { state: "invalid", source: "keyring", detail: "That value is not a usable TypeSafe API key.", verified: false };
	const verifiedAt = verified ? new Date().toISOString() : undefined;
	await store.set(KEYRING_ACCOUNT, encode({ version: 1, key, verifiedAt }));
	return { key, state: "usable", source: "keyring", detail: `TypeSafe key ${fingerprintOf(key)} stored in the OS keyring.`, verified, verifiedAt, fingerprint: fingerprintOf(key) };
}

/** Persist successful verification only when the tested value is still the stored key. */
export async function markKeyVerified(store: SecretStore, key: string): Promise<void> {
	const current = decode(await store.get(KEYRING_ACCOUNT));
	if (!current || current.key !== key) return;
	await store.set(KEYRING_ACCOUNT, encode({ ...current, verifiedAt: new Date().toISOString() }));
}

export async function markKeyRejected(store: SecretStore, key: string): Promise<void> {
	const current = decode(await store.get(KEYRING_ACCOUNT));
	if (!current || current.key !== key || !current.verifiedAt) return;
	await store.set(KEYRING_ACCOUNT, encode({ version: 1, key: current.key }));
}

export async function removeKey(store: SecretStore): Promise<ResolvedKey> {
	await store.delete(KEYRING_ACCOUNT);
	return { state: "missing", source: "none", detail: "TypeSafe key removed from the OS keyring.", verified: false };
}

/** The shape safe to show a user or write to a status panel. Never carries the key. */
export const publicStatus = (resolved: ResolvedKey): { state: CredentialState; source: ResolvedKey["source"]; detail: string; verified: boolean; verifiedAt?: string; fingerprint?: string } => ({
	state: resolved.state,
	source: resolved.source,
	detail: resolved.detail,
	verified: resolved.verified === true,
	verifiedAt: resolved.verifiedAt,
	fingerprint: resolved.fingerprint,
});

export const keyHasValidShape = (key: string): boolean => key !== "typesafe-api-key" && key !== KEYRING_ACCOUNT && key.length >= 16 && key.length <= 512 && !/\s/.test(key);

export const keyFingerprint = (key: string): string => fingerprintOf(key);

const decode = (stored: string | null): KeyRecord | undefined => {
	if (!stored) return undefined;
	try {
		const value = JSON.parse(stored) as Partial<KeyRecord>;
		if (value.version === 1 && typeof value.key === "string") {
			return { version: 1, key: value.key, verifiedAt: typeof value.verifiedAt === "string" ? value.verifiedAt : undefined };
		}
	} catch {
		// Legacy records stored the raw key; keep reading them until the next successful verification.
	}
	return { version: 1, key: stored };
};

const encode = (record: KeyRecord): string => JSON.stringify(record);
const fingerprintOf = (key: string): string => createHash("sha256").update(key).digest("hex").slice(0, 12);
const isMissing = (error: unknown): boolean => /not found|no such|not exist|password not found/i.test(String(error));
const inaccessible = (): Error => new Error("Cannot access the OS keyring. Unlock it and try again; no plaintext fallback is used.");
