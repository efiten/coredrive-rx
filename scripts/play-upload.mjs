// Uploads a signed Android App Bundle to a Google Play test track as a DRAFT release, or
// puts a bundle that is already on Play on another track (promote), also as a DRAFT.
//
// The draft holds the bundle and English release notes; rolling it out stays a click in
// Play Console. Auth is a service account JSON key kept outside the repo (default
// ~/.coredrive-rx-signing/play-api.json, override with PLAY_API_KEY). No dependencies:
// the OAuth token comes from a JWT signed with node:crypto.
//
// Usage:
//   node scripts/play-upload.mjs tracks                       list tracks and their releases
//   node scripts/play-upload.mjs upload <file.aab> [--track alpha] [--notes vX.Y.Z] [--mapping mapping.txt]
//   node scripts/play-upload.mjs promote <versionCode> [--track production] [--notes vX.Y.Z]
// promote reuses the name and release notes the versionCode has on the track it is on now;
// --notes replaces them with the summary of that docs/releases file.
// --mapping uploads R8's mapping file with the bundle, so Play's crash reports show real names.
// The notes default to the one-line summary of docs/releases/v<package.json version>.md.
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
export const NOTES_MAX = 500; // Play's limit per language

// releaseSummary returns the one-line summary under the "# CoreDrive RX vX.Y.Z" heading.
export function releaseSummary(markdown) {
  const paras = markdown.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const summary = paras.find((p) => !p.startsWith('#'));
  if (!summary) throw new Error('release notes have no summary line');
  const text = summary.replace(/\s*\n\s*/g, ' ').replace(/\*\*/g, '').replace(/`/g, '');
  if (text.length > NOTES_MAX) throw new Error('summary is ' + text.length + ' chars, Play allows ' + NOTES_MAX);
  return text;
}

// withDraft returns the track's releases with `draft` added. Earlier drafts are dropped,
// because a track holds one draft; live and halted releases stay, because tracks.update
// replaces the whole list and leaving them out would end them.
export function withDraft(releases, draft) {
  return [...(releases || []).filter((r) => r.status !== 'draft'), draft];
}

export function draftRelease(versionCode, versionName, notes) {
  return {
    name: versionCode + ' (' + versionName + ')',
    versionCodes: [String(versionCode)],
    status: 'draft',
    releaseNotes: [{ language: 'en-US', text: notes }],
  };
}

// promotedDraft builds the draft for `versionCode` on another track from the release
// that already holds it (tracks as GET /tracks returns them), keeping its name and notes.
export function promotedDraft(tracks, versionCode) {
  const code = String(versionCode);
  for (const t of tracks || []) {
    const r = (t.releases || []).find((x) => (x.versionCodes || []).includes(code));
    if (r) return { name: r.name, versionCodes: [code], status: 'draft', releaseNotes: r.releaseNotes || [] };
  }
  throw new Error('versionCode ' + code + ' is on no track; upload it first');
}

// mappingPath is where R8's mapping file for one versionCode goes (edits.deobfuscationfiles).
export function mappingPath(versionCode) {
  return '/apks/' + versionCode + '/deobfuscationFiles/proguard?uploadType=media';
}

const b64url = (s) => Buffer.from(s).toString('base64url');

export function signedJwt(key, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPE, aud: key.token_uri, iat: nowSec, exp: nowSec + 3600,
  }));
  const sig = createSign('RSA-SHA256').update(header + '.' + claims).sign(key.private_key, 'base64url');
  return header + '.' + claims + '.' + sig;
}

async function accessToken(key) {
  const res = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: signedJwt(key, Math.floor(Date.now() / 1000)),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('token: ' + res.status + ' ' + JSON.stringify(body));
  return body.access_token;
}

function client(token, pkg) {
  return async function call(method, path, { body, upload, raw } = {}) {
    const res = await fetch((upload ? UPLOAD : API) + pkg + path, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': raw ? 'application/octet-stream' : 'application/json',
      },
      body: raw || (body ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(method + ' ' + path + ': ' + res.status + ' ' + text);
    return text ? JSON.parse(text) : {};
  };
}

async function main(argv) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(readFileSync(join(root, 'capacitor.config.json'), 'utf8')).appId;
  const keyPath = process.env.PLAY_API_KEY || join(homedir(), '.coredrive-rx-signing', 'play-api.json');
  const key = JSON.parse(readFileSync(keyPath, 'utf8'));
  const call = client(await accessToken(key), pkg);
  const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };

  const edit = await call('POST', '/edits', { body: {} });
  const e = '/edits/' + edit.id;
  let committed = false;
  try {
    if (argv[0] === 'tracks') {
      const { tracks } = await call('GET', e + '/tracks');
      for (const t of tracks || []) {
        console.log(t.track);
        for (const r of t.releases || []) console.log('  ', r.status, r.name, (r.versionCodes || []).join(','));
      }
      return;
    }
    const usage = 'usage: play-upload.mjs tracks | upload <file.aab> [--track alpha] [--notes vX.Y.Z] [--mapping mapping.txt]'
      + ' | promote <versionCode> [--track production] [--notes vX.Y.Z]';
    if (!['upload', 'promote'].includes(argv[0]) || !argv[1]) throw new Error(usage);
    const summaryOf = (tag) => releaseSummary(readFileSync(join(root, 'docs', 'releases', tag + '.md'), 'utf8'));

    if (argv[0] === 'promote') {
      const track = opt('--track', 'production');
      const { tracks } = await call('GET', e + '/tracks');
      const draft = promotedDraft(tracks, argv[1]);
      if (opt('--notes')) draft.releaseNotes = [{ language: 'en-US', text: summaryOf(opt('--notes')) }];
      const current = (tracks || []).find((t) => t.track === track) || { releases: [] };
      await call('PUT', e + '/tracks/' + track, { body: { track, releases: withDraft(current.releases, draft) } });
      await call('POST', e + ':commit');
      committed = true;
      console.log('draft "' + draft.name + '" on track ' + track + ', notes: ' + draft.releaseNotes.map((n) => n.text).join(' | '));
      console.log('roll it out in Play Console > Testen en releasen');
      return;
    }

    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const tag = opt('--notes', 'v' + version);
    const notes = summaryOf(tag);
    const track = opt('--track', 'alpha');

    const bundle = await call('POST', e + '/bundles?uploadType=media', { upload: true, raw: readFileSync(argv[1]) });
    console.log('uploaded versionCode', bundle.versionCode);
    const mapping = opt('--mapping');
    if (mapping) {
      await call('POST', e + mappingPath(bundle.versionCode), { upload: true, raw: readFileSync(mapping) });
      console.log('uploaded mapping file for', bundle.versionCode);
    }
    const current = await call('GET', e + '/tracks/' + track);
    const draft = draftRelease(bundle.versionCode, tag.replace(/^v/, ''), notes);
    await call('PUT', e + '/tracks/' + track, { body: { track, releases: withDraft(current.releases, draft) } });
    await call('POST', e + ':commit');
    committed = true;
    console.log('draft "' + draft.name + '" on track ' + track + ', notes: ' + notes);
    console.log('roll it out in Play Console > Testen en releasen');
  } finally {
    if (!committed) await call('DELETE', e).catch(() => {}); // an open edit would block the next one

  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exit(1); });
}
