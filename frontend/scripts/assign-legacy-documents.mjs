import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const [rawUsername, selector] = process.argv.slice(2);
if (!rawUsername || !selector || (selector !== '--all' && !/^[0-9a-f-]{36}$/i.test(selector))) {
  console.error('Usage: node scripts/assign-legacy-documents.mjs <username> <--all|document-id>');
  process.exit(2);
}
const path=join(process.env.PROOFFLOW_DATA_DIR ?? join(process.cwd(),'data'),'proofflow.sqlite');
if (!existsSync(path)) { console.error('Database not found. Start the app and register first.'); process.exit(1); }
const db=new DatabaseSync(path);
try {
  db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  const user=db.prepare('SELECT id FROM users WHERE username=?').get(rawUsername.toLowerCase());
  if(!user) throw new Error('Register this username first.');
  const result=selector==='--all'
    ? db.prepare('UPDATE documents SET owner_id=? WHERE owner_id IS NULL').run(user.id)
    : db.prepare('UPDATE documents SET owner_id=? WHERE owner_id IS NULL AND id=?').run(user.id,selector);
  db.exec('COMMIT');
  console.log(`Assigned ${result.changes} unowned document(s). Existing owners were not changed.`);
} catch(error) { db.exec('ROLLBACK'); console.error(error.message); process.exitCode=1; }
finally { db.close(); }
