import type { ControlPlane } from "./controlPlane";
import type { FolderRoom } from "./folderRoom";

export interface Env {
	CONTROL: DurableObjectNamespace<ControlPlane>;
	FOLDERS: DurableObjectNamespace<FolderRoom>;
	RESERVED: DurableObjectNamespace;
	/** Optional: attachments and folder snapshots need R2. */
	BLOBS?: R2Bucket;
	/** Optional: required to claim the server (otherwise a one-time code is logged). */
	SETUP_PASSPHRASE?: string;
}

export function controlStub(env: Env) {
	return env.CONTROL.get(env.CONTROL.idFromName("control"));
}

export function folderStub(env: Env, folderId: string) {
	return env.FOLDERS.get(env.FOLDERS.idFromName(folderId));
}
