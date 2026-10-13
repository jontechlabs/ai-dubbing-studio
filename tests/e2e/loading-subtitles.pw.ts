import { test, expect } from '@playwright/test';
import { blankProject } from '../../src/domain/project';

test('loading remains visible until the first video frame is available', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/demo.mp4', async (route) => {
    await pending;
    await route.fulfill({ path: 'public/demo.mp4', contentType: 'video/mp4' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Explorer l’exemple' }).click();
  await expect(page.locator('.video-loading')).toContainText('Chargement de la vidéo');
  await expect(page.locator('.video-stage')).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeDisabled();
  release();
  await expect(page.locator('.video-loading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
});

test('failed media loading stops the spinner and offers proxy preparation', async ({ page }) => {
  await page.route('**/demo.mp4', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Explorer l’exemple' }).click();
  await expect(page.locator('.video-load-error')).toContainText('La vidéo n’a pas pu être chargée');
  await expect(page.locator('.video-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.video-load-error .spin')).toHaveCount(0);
});

test('native import opens processing; embedded source and target tracks are selectable', async ({ page }) => {
  const seed = blankProject('Embedded test', 'ja', 'fr');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(({ initial }) => {
    const runtime = window as unknown as Record<string, any>;
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number>();
    let counter = 0;
    let project = structuredClone(initial);
    const info = {
      originalName: 'two-tracks.mkv', durationMs: 16000,
      streams: [
        { index: 0, kind: 'video', codec: 'h264', language: 'und', title: '', bitmap: false, channels: null, width: 1280, height: 720 },
        { index: 1, kind: 'subtitle', codec: 'subrip', language: 'jpn', title: 'Original', bitmap: false, channels: null, width: null, height: null },
        { index: 2, kind: 'subtitle', codec: 'ass', language: 'fra', title: 'Traduction', bitmap: false, channels: null, width: null, height: null },
        { index: 3, kind: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng', title: 'Bitmap', bitmap: true, channels: null, width: null, height: null },
      ],
    };
    let job: any;
    const emit = (name: string, payload: unknown) => {
      const handler = listeners.get(name);
      if (handler) callbacks.get(handler)?.({ event: name, id: handler, payload });
    };
    runtime.__subtitleCalls = [];
    runtime.__finishImport = () => {
      project.media = { ...info, id: 'media-1', path: 'media/two-tracks.mkv', previewPath: 'cache/preview.mp4', audioStreamIndex: null };
      project.revision += 1;
      job = { ...job, status: 'succeeded', stage: 'done', progress: 1 };
      emit('project-changed', structuredClone(project));
      emit('job-changed', structuredClone(job));
    };
    runtime.isTauri = true;
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' } },
      convertFileSrc: () => '/demo.mp4',
      transformCallback: (callback: (event: unknown) => void) => { const id = ++counter; callbacks.set(id, callback); return id; },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (command: string, args: any = {}) => {
        if (command === 'plugin:event|listen') { listeners.set(args.event, args.handler); return args.handler; }
        if (command === 'plugin:event|unlisten') return;
        if (command === 'restore_project') return null;
        if (command === 'list_jobs') return [];
        if (command === 'plugin:dialog|open') return args.options.directory ? 'C:/Projects' : 'C:/two-tracks.mkv';
        if (command === 'probe_media') return info;
        if (command === 'create_project') return structuredClone(project);
        if (command === 'import_media') {
          job = { id: 'import-1', projectId: project.id, kind: 'import', status: 'running', stage: 'copy', progress: 0.35, error: null, logs: [] };
          emit('job-changed', structuredClone(job));
          return job.id;
        }
        if (command === 'media_path') return 'C:/Projects/media/preview.mp4';
        if (command === 'get_waveform') return null;
        if (command === 'import_embedded_subtitles') {
          runtime.__subtitleCalls.push({ role: args.role, streamIndex: args.streamIndex });
          job = { id: `subtitles-${args.role}`, projectId: project.id, kind: 'subtitles', status: 'running', stage: 'extract', progress: null, error: null, logs: [] };
          emit('job-changed', structuredClone(job));
          await new Promise<void>((resolve) => { runtime.__finishSubtitles = resolve; });
          const cue = { id: `${args.role}-1`, startMs: 200, endMs: 1600, text: args.role === 'source' ? 'こんにちは' : 'Bonjour !' };
          if (args.role === 'source') project.sourceCues = [cue]; else project.targetCues = [cue];
          project.dialogues = [{ id: 'dialogue-1', startMs: 200, endMs: 1600, sourceCueIds: project.sourceCues.map((c) => c.id), targetCueIds: project.targetCues.map((c) => c.id), ttsText: null, characterId: null, status: 'ungenerated', warnings: [], selectedGenerationIds: {} }];
          project.revision += 1;
          emit('job-changed', { ...job, status: 'succeeded', stage: 'done', progress: 1 });
          return structuredClone(project);
        }
        throw new Error(`Unexpected mock command: ${command}`);
      },
    };
  }, { initial: seed });
  await page.goto('/');
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await page.getByRole('button', { name: /Choisir une vidéo/ }).click();
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page.getByRole('dialog', { name: 'Traitements' })).toBeVisible();
  await expect(page.locator('.job-card')).toContainText('35%');
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.video-loading')).toContainText('Préparation de la vidéo');
  await expect(page.getByRole('heading', { name: /Une nouvelle voix/ })).toHaveCount(0);
  await page.evaluate(() => (window as any).__finishImport());
  await expect(page.locator('.video-loading')).toHaveCount(0);
  for (const [button, index, role] of [['SRT original', '1', 'source'], ['SRT traduit', '2', 'target']]) {
    await page.getByRole('button', { name: button, exact: true }).click();
    await expect(page.locator('input[value="3"]')).toBeDisabled();
    await expect(page.getByText(/Sous-titres bitmap : une conversion OCR/)).toBeVisible();
    await page.locator(`input[value="${index}"]`).check();
    await page.getByRole('button', { name: 'Utiliser cette piste' }).click();
    await expect(page.getByRole('button', { name: 'Extraction des sous-titres…', exact: true })).toBeDisabled();
    await page.evaluate(() => (window as any).__finishSubtitles());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.count-badge')).toHaveText('1');
    expect(await page.evaluate(() => (window as any).__subtitleCalls.at(-1))).toEqual({ role, streamIndex: Number(index) });
  }
  await expect(page.locator('.original-text').first()).toContainText('こんにちは');
  await expect(page.locator('.target-text').first()).toContainText('Bonjour !');
  expect(errors).toEqual([]);
});
