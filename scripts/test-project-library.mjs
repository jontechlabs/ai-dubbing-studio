// Packaged WebView + filesystem + FFmpeg; only diagnostic-owned project folders.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
export async function verifyProjectLibrary({ call, context, args, job }) {
  const transition = async (tool, parameters = {}) => {
    const until = Date.now() + 30_000;
    for (;;) {
      try {
        return await call(tool, parameters);
      } catch (error) {
        if (String(error) !== 'Error: BUSY' || Date.now() >= until) throw error;
        const jobs = await call('studio_list_jobs');
        console.log(
          'PROJECT_LIBRARY_WAITING_FOR_BACKGROUND_WORK',
          jobs
            .filter((j) => ['queued', 'running', 'paused'].includes(j.status))
            .map((j) => ({ type: j.type, stage: j.stage, status: j.status })),
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  };
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const screen = async (expected) => {
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const s = await call('studio_get_state');
      if (s.screen === expected) return s;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error('Wrong library/editor screen');
  };
  const manifest = async (root) => {
    const result = {};
    const walk = async (dir, rel = '') => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const name = path.join(rel, e.name);
        if (e.isDirectory()) await walk(path.join(dir, e.name), name);
        else if (e.isFile()) result[name] = hash(await fs.readFile(path.join(dir, e.name)));
        else throw Error('Unexpected link in diagnostic project');
      }
    };
    await walk(root);
    return result;
  };
  const before = await call('studio_get_project');
  assert(before.generations.length > 0);
  let list = await call('studio_list_projects');
  let row = list.entries.find((e) => e.key === list.activeKey);
  assert(row?.available);
  assert.equal(row.projectId, before.id);
  const key = row.key,
    root = row.path;
  await assert.rejects(
    call('studio_trash_registered_project', {
      key,
      expectedRevision: before.revision,
      confirmed: true,
    }),
    /PROJECT_IS_OPEN/,
  );
  await transition('studio_close_project');
  await screen('home');
  assert.equal(await call('studio_current_project'), null);
  const projectBytes = await fs.readFile(path.join(root, 'project.json'));
  const media = path.resolve(root, before.media.previewPath ?? before.media.path);
  const sourceHash = hash(await fs.readFile(media));
  const cover = await call('studio_project_cover', { key, atMs: null });
  assert.equal(cover.atMs, Math.min(120000, Math.floor((before.media.durationMs * 2) / 5)));
  const png = await fs.readFile(cover.path);
  assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert(png.readUInt32BE(16) > 0 && png.readUInt32BE(16) <= 640);
  assert(png.readUInt32BE(20) > 0 && png.readUInt32BE(20) <= 640);
  const ffmpeg = path.join(path.dirname(args.exe), 'binaries/ffmpeg.exe');
  const expected = path.join(args['test-root'], 'expected-library-cover.png');
  execFileSync(
    ffmpeg,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-ss',
      (cover.atMs / 1000).toFixed(3),
      '-protocol_whitelist',
      'file,pipe',
      '-i',
      media,
      '-map',
      '0:v:0',
      '-frames:v',
      '1',
      '-vf',
      'scale=640:640:force_original_aspect_ratio=decrease,setsar=1',
      '-n',
      expected,
    ],
    { windowsHide: true },
  );
  assert.equal(hash(png), hash(await fs.readFile(expected)));
  assert.equal((await call('studio_project_cover', { key, atMs: null })).path, cover.path);
  const custom = await call('studio_project_cover', { key, atMs: 0 });
  assert.equal(custom.atMs, 0);
  assert.equal((await call('studio_project_cover', { key, atMs: null })).path, custom.path);
  await assert.rejects(
    call('studio_project_cover', { key, atMs: before.media.durationMs }),
    /INVALID_COVER_TIME/,
  );
  assert.deepEqual(await fs.readFile(path.join(root, 'project.json')), projectBytes);
  assert.equal(hash(await fs.readFile(media)), sourceHash);
  assert.equal((await call('studio_get_state')).screen, 'home');
  row = await call('studio_rename_registered_project', {
    key,
    expectedRevision: before.revision,
    name: '  Projet renommé 日本語  ',
  });
  assert.equal(row.name, 'Projet renommé 日本語');
  assert.equal(row.projectId, before.id);
  assert.equal(row.path, root);
  await assert.rejects(
    call('studio_rename_registered_project', {
      key,
      expectedRevision: before.revision,
      name: 'Stale',
    }),
    /STALE_REVISION/,
  );
  const renamed = JSON.parse(await fs.readFile(path.join(root, 'project.json'), 'utf8'));
  for (const field of [
    'generations',
    'sourceCues',
    'targetCues',
    'voiceReferences',
    'media',
    'voiceEdits',
    'tracks',
  ])
    assert.deepEqual(renamed[field], before[field]);
  const bytesBeforeTrash = await manifest(root);
  await assert.rejects(
    call('studio_trash_registered_project', {
      key,
      expectedRevision: row.revision,
      confirmed: false,
    }),
    /PROJECT_DELETE_CONFIRMATION/,
  );
  const trashed = await call('studio_trash_registered_project', {
    key,
    expectedRevision: row.revision,
    confirmed: true,
  });
  assert(trashed.trashedAt);
  await assert.rejects(fs.stat(root), (e) => e.code === 'ENOENT');
  assert.deepEqual(await manifest(trashed.path), bytesBeforeTrash);
  await assert.rejects(call('studio_open_registered_project', { key }), /PROJECT_NOT_FOUND/);
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'keep.txt'), 'Collision sentinel');
  await assert.rejects(
    call('studio_restore_registered_project', { key, parentPath: null }),
    /PROJECT_EXISTS/,
  );
  assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'Collision sentinel');
  await fs.unlink(path.join(root, 'keep.txt'));
  await fs.rmdir(root);
  const restored = await call('studio_restore_registered_project', { key, parentPath: null });
  assert.equal(restored.path, root);
  assert.equal(restored.trashedAt, null);
  assert.deepEqual(await manifest(root), bytesBeforeTrash);
  const reopened = await call('studio_open_registered_project', { key });
  assert.equal(reopened.id, before.id);
  assert.deepEqual(reopened.generations, before.generations);
  await screen('editor');
  const activeRename = await call('studio_rename_registered_project', {
    key,
    expectedRevision: reopened.revision,
    name: 'Renommage dans l’éditeur',
  });
  assert.equal((await call('studio_get_project')).name, activeRename.name);
  const name = 'Accueil vide 日本語';
  const fresh = await call('studio_create_library_project', {
    parentPath: args['test-root'],
    name,
    source: 'ja',
    target: 'fr',
  });
  assert.equal(fresh.media, null);
  assert.equal(fresh.name, name);
  assert.equal(fresh.dialogues.length, 0);
  await job(
    await call('studio_import_media', {
      context: await context(),
      path: args.movie,
      audioStreamIndex: 1,
      forceProxy: false,
    }),
  );
  const imported = await call('studio_get_project');
  assert.equal(imported.id, fresh.id);
  assert(imported.media.durationMs > 0);
  list = await call('studio_list_projects');
  const freshRow = list.entries.find((e) => e.key === list.activeKey);
  assert.equal(freshRow.projectId, fresh.id);
  await transition('studio_close_project');
  await screen('home');
  const copy = path.join(args['test-root'], 'Projet copié 日本語.dubproject');
  await fs.cp(freshRow.path, copy, { recursive: true, errorOnExist: true, force: false });
  await call('studio_open_project', { path: copy });
  list = await call('studio_list_projects');
  const copies = list.entries.filter((e) => e.projectId === fresh.id);
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].key, copies[1].key);
  const copyRow = copies.find((e) => path.resolve(e.path) === path.resolve(copy));
  assert(copyRow);
  await transition('studio_close_project');
  await screen('home');
  const copyBytes = await manifest(copy);
  await assert.rejects(
    call('studio_forget_registered_project', { key: copyRow.key, confirmed: false }),
    /PROJECT_DELETE_CONFIRMATION/,
  );
  await call('studio_forget_registered_project', { key: copyRow.key, confirmed: true });
  assert.deepEqual(await manifest(copy), copyBytes);
  assert(!(await call('studio_list_projects')).entries.some((e) => e.key === copyRow.key));
  await call('studio_open_registered_project', { key });
  assert.deepEqual((await call('studio_get_project')).generations, before.generations);
  assert.equal(hash(await fs.readFile(media)), sourceHash);
  return {
    homeAndEditor: true,
    actualFfmpegFrame: true,
    cachedAndCustomCover: true,
    listingAndCoverReadOnly: true,
    renameRetainsAssets: true,
    staleRevisionRejected: true,
    explicitRecoverableTrash: true,
    restoredEveryFileAndTake: true,
    restoreCollisionRejected: true,
    activeProjectProtected: true,
    createAndImportSameProject: true,
    copiedIdsHaveDistinctKeys: true,
    forgetKeepsFiles: true,
    coverAtMs: cover.atMs,
  };
}
