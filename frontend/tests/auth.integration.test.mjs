import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
const base = process.env.PROOFFLOW_TEST_URL ?? 'http://127.0.0.1:3001';
const password = 'Test-password-123!';
const empty = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
async function request(path, method='GET', body, cookie='', extra={}) {
  const response = await fetch(base+path, { method, headers: { ...(body ? {'Content-Type':'application/json'} : {}), ...(cookie ? {Cookie:cookie}:{}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status:response.status, body:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0], headers:response.headers };
}
test('password authentication, persistent sessions, ownership, logout and rate limits', async () => {
  assert.equal((await request('/api/documents')).status,401);
  assert.equal((await request('/api/documents','POST',{title:'x',editorSchemaVersion:1,contentJson:empty})).status,401);
  const username='a_'+randomUUID().replaceAll('-','').slice(0,20);
  assert.equal((await request('/api/auth/register','POST',{username,password:'short'})).status,400);
  const a=await request('/api/auth/register','POST',{username,password});
  assert.equal(a.status,201);
  assert.match(a.headers.get('set-cookie'),/HttpOnly/);
  assert.match(a.headers.get('set-cookie'),/SameSite=Lax/);
  assert.equal('password_hash' in a.body.user,false);
  assert.equal((await request('/api/auth/register','POST',{username:username.toUpperCase(),password})).status,409);
  assert.equal((await request('/api/auth/login','POST',{username,password:'wrong-password'})).status,401);
  const login=await request('/api/auth/login','POST',{username:username.toUpperCase(),password},a.cookie);
  assert.equal(login.status,200);
  assert.equal((await request('/api/auth/me','GET',undefined,a.cookie)).body.user,null);
  const cookie=login.cookie;
  assert.equal((await request('/api/auth/me','GET',undefined,cookie)).body.user.id,a.body.user.id);
  const created=await request('/api/documents','POST',{title:'Private',editorSchemaVersion:1,contentJson:empty},cookie);
  assert.equal(created.status,201); const id=created.body.id;
  const b=await request('/api/auth/register','POST',{username:'b_'+randomUUID().replaceAll('-','').slice(0,20),password});
  assert.equal(b.status,201);
  for (const suffix of ['', '/events','/verify','/bundle']) {
    assert.equal((await request(`/api/documents/${id}${suffix}`,'GET',undefined,b.cookie)).status,404);
    assert.equal((await request(`/api/documents/${id}${suffix}`)).status,401);
  }
  for(const suffix of ['/events','/finalize']) assert.equal((await request(`/api/documents/${id}${suffix}`,'POST',{},b.cookie)).status,404);
  assert.equal((await request('/api/documents','GET',undefined,b.cookie)).body.documents.length,0);
  assert.equal((await request('/api/documents','GET',undefined,cookie)).body.documents[0].id,id);
  assert.equal((await request(`/api/documents/${id}/finalize`,'POST',{expectedVersion:0},cookie,{Origin:'https://evil.example'})).status,403);
  assert.equal((await request(`/api/documents/${id}/finalize`,'POST',{expectedVersion:0},cookie)).status,200);
  assert.equal((await request(`/api/documents/${id}/bundle`,'GET',undefined,cookie)).status,200);
  if (process.env.PROOFFLOW_DATA_DIR) {
    const db=new DatabaseSync(join(process.env.PROOFFLOW_DATA_DIR,'proofflow.sqlite'));
    const stored=db.prepare('SELECT password_hash FROM users WHERE id=?').get(a.body.user.id).password_hash;
    assert.match(stored,/^scrypt-v1\$/); assert.equal(stored.includes(password),false);
    assert.equal(db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(a.body.user.id).token_hash.includes(cookie.split('=')[1]),false);
    db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(b.body.user.id);
    assert.equal((await request('/api/documents','GET',undefined,b.cookie)).status,401);
    db.close();
  }
  assert.equal((await request('/api/auth/logout','POST',{},cookie)).status,200);
  assert.equal((await request('/api/documents','GET',undefined,cookie)).status,401);
  assert.equal((await request('/api/auth/login','POST',{username,password})).status,200);
  const absent='none_'+randomUUID().slice(0,8);
  for(let i=0;i<10;i++) assert.equal((await request('/api/auth/login','POST',{username:absent,password})).status,401);
  assert.equal((await request('/api/auth/login','POST',{username:absent,password})).status,429);
});
