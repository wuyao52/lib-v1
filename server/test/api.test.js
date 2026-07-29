import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { createApp } from '../app.js';

async function createDocxBuffer(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.folder('_rels').file('.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function register(baseUrl, name, email, sentCodes) {
  const codeResponse = await fetch(`${baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, purpose: 'register' }),
  });
  assert.equal(codeResponse.status, 202);
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'strong-pass-123', verificationCode: sentCodes.at(-1).code }),
  });
  return response.headers.get('set-cookie').split(';')[0];
}

test('skill and director APIs require auth and isolate user data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ads-api-'));
  const sentCodes = [];
  const { app } = await createApp({
    databasePath: join(directory, 'database.json'),
    secureCookies: false,
    sendEmailCode: async (message) => sentCodes.push(message),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthenticated = await fetch(`${baseUrl}/api/skills`);
  assert.equal(unauthenticated.status, 401);

  const invalidOrigin = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Blocked User', email: 'blocked@example.com', password: 'strong-pass-123' }),
  });
  assert.equal(invalidOrigin.status, 403);

  const sameOriginCode = await fetch(`${baseUrl}/api/auth/email-code`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'same-origin@example.com', purpose: 'register' }),
  });
  assert.equal(sameOriginCode.status, 202);
  const sameOrigin = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Same Origin', email: 'same-origin@example.com', password: 'strong-pass-123', verificationCode: sentCodes.at(-1).code }),
  });
  assert.equal(sameOrigin.status, 201);

  const firstCookie = await register(baseUrl, 'First User', 'first@example.com', sentCodes);
  const secondCookie = await register(baseUrl, 'Second User', 'second@example.com', sentCodes);
  const docxForm = new FormData();
  docxForm.append('file', new Blob([await createDocxBuffer('雨夜车站的广播突然响起。')]), 'script.docx');
  const docxImport = await fetch(`${baseUrl}/api/director/script-import`, { method: 'POST', headers: { cookie: firstCookie }, body: docxForm });
  assert.equal(docxImport.status, 200);
  assert.match((await docxImport.json()).text, /雨夜车站/);
  const oversizedWordForm = new FormData();
  oversizedWordForm.append('file', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)]), 'oversized.docx');
  const oversizedWordImport = await fetch(`${baseUrl}/api/director/script-import`, { method: 'POST', headers: { cookie: firstCookie }, body: oversizedWordForm });
  assert.equal(oversizedWordImport.status, 400);
  assert.equal((await oversizedWordImport.json()).error, 'FILE_TOO_LARGE');
  const createSkill = await fetch(`${baseUrl}/api/skills`, {
    method: 'POST',
    headers: { cookie: firstCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: '动作节奏', description: '控制动作节奏', tags: ['motion'], instructions: '每个镜头只保留一个主要动作，动作结束必须形成清晰的静止状态。' }),
  });
  assert.equal(createSkill.status, 201);
  const skill = (await createSkill.json()).skill;

  const otherUserList = await fetch(`${baseUrl}/api/skills`, { headers: { cookie: secondCookie } });
  assert.deepEqual((await otherUserList.json()).skills, []);
  const otherUserDelete = await fetch(`${baseUrl}/api/skills/${skill.id}`, { method: 'DELETE', headers: { cookie: secondCookie } });
  assert.equal(otherUserDelete.status, 404);

  const directorResponse = await fetch(`${baseUrl}/api/director/storyboard`, {
    method: 'POST',
    headers: { cookie: firstCookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      story: '男孩走进废弃剧院。他在舞台中央找到母亲留下的录音机。录音响起后，他慢慢坐在第一排。',
      targetDurationSec: 18,
      clipBudgetSec: 6,
      skillIds: [skill.id],
    }),
  });
  assert.equal(directorResponse.status, 201);
  const storyboard = (await directorResponse.json()).storyboard;
  assert.equal(storyboard.customSkills[0].id, skill.id);
  assert.ok(storyboard.shots[0].prompt.includes('清晰的静止状态'));
});
