import { path } from '../deps.ts';

export function openKv() {
	const dbPath = path.resolve(path.dirname(path.fromFileUrl(import.meta.url)), '.db/kv.sqlite');
	Deno.mkdirSync(path.dirname(dbPath), { recursive: true });
	return Deno.openKv(dbPath);
}
