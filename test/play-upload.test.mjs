// The Play upload script builds a draft release without ending the live one, and takes its
// notes from the release file's summary line.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { releaseSummary, withDraft, draftRelease, signedJwt, NOTES_MAX } from '../scripts/play-upload.mjs';

test('the notes are the summary line, without markdown', () => {
  const md = '# CoreDrive RX v1.2.3\r\n\r\nThe **Android app** keeps\n`capturing`.\r\n\r\n## What\'s new\n\n- x\n';
  assert.equal(releaseSummary(md), 'The Android app keeps capturing.');
});

test('notes over the Play limit or a missing summary fail instead of uploading', () => {
  assert.throws(() => releaseSummary('# T\n\n' + 'a'.repeat(NOTES_MAX + 1)), /Play allows/);
  assert.throws(() => releaseSummary('# T\n\n## Only headings\n'), /no summary/);
});

test('a new draft replaces an old draft and keeps the live release', () => {
  const live = { status: 'completed', versionCodes: ['12403'] };
  const old = { status: 'draft', versionCodes: ['12404'] };
  const draft = draftRelease(12405, '1.24.5', 'n');
  assert.deepStrictEqual(withDraft([live, old], draft), [live, draft]);
  assert.deepStrictEqual(withDraft(undefined, draft), [draft]);
  assert.deepStrictEqual(draft, {
    name: '12405 (1.24.5)', versionCodes: ['12405'], status: 'draft',
    releaseNotes: [{ language: 'en-US', text: 'n' }],
  });
});

test('the token request is a JWT signed with the service account key', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'sa@x.iam.gserviceaccount.com', token_uri: 'https://oauth2.example/token',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const [h, c, s] = signedJwt(key, 1000).split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.deepStrictEqual(claims, { iss: key.client_email, scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: key.token_uri, iat: 1000, exp: 4600 });
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  assert.ok(createVerify('RSA-SHA256').update(h + '.' + c).verify(publicKey, s, 'base64url'));
});
