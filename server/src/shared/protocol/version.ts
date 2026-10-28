/** Wire protocol spoken over the folder socket. The server accepts [MIN, CURRENT]. */
export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN = 1;

/**
 * Schema of the content stored in a share (tree semantics, document layouts). A folder
 * records the minimum writer schema; older clients get read-only access, not a refusal.
 */
export const SCHEMA_VERSION = 1;

export const SERVER_VERSION = "0.1.0";

/** Limits shared by both sides. */
export const LIMITS = {
	/** Largest single document update the server accepts. */
	maxUpdateBytes: 8 * 1024 * 1024,
	/** Text above this is treated as atomic (whole-text replace, no character merge). */
	atomicTextBytes: 2 * 1024 * 1024,
	/** Frames are kept below this when the server pages catch-up data. */
	frameSoftBytes: 256 * 1024,
	/** Entries per tree snapshot / events frame. */
	treePageSize: 500,
	/** Heads per heads frame. */
	headsPageSize: 2000,
} as const;
