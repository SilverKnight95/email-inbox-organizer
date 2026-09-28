import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
export async function database() {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema vault;
    create table vault.decrypted_secrets(id uuid, decrypted_secret text);`);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).sort()) {
    await db.exec(await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'));
  }
  return db;
}
export async function rpc(db, name, args) {
  const keys = Object.keys(args);
  const result = await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as value`, Object.values(args));
  return result.rows[0].value;
}
