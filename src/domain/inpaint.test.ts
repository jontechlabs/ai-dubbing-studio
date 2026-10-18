import { it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, spokenText } from './tts';
import { dubbingClips, moveDubbing, resizeDubbing } from './mix';
import { currentLipVideo, selectLipVideo, lipVideos, type LipVideo } from './inpaint';
import { editVoice } from './voiceEdit';
function fixture() {
  const p = demoProject(),
    line = p.dialogues[0];
  p.formatVersion = 8;
  line.selectedGenerationIds.fr = 'take';
  p.generations = [
    {
      id: 'take',
      kind: 'tts',
      dialogueId: line.id,
      providerId: 'cosyvoice3',
      modelId: 'cosy3-official',
      path: 'generations/take.wav',
      createdAt: new Date().toISOString(),
      sourcePath: p.media!.path,
      startMs: line.startMs,
      endMs: line.endMs,
      text: spokenText(p, line),
      language: 'fr',
      characterId: null,
      durationMs: 2000,
      sampleRate: 24000,
      options: defaultVoiceSettings,
      referenceTranscript: 'Hello',
      device: 'cpu',
      deviceName: 'CPU',
      peakVramMb: 0,
      inputHash: 'fixture',
    },
  ];
  const clip = dubbingClips(p)[0];
  const e: LipVideo = {
    id: 'edit',
    kind: 'lipVideo',
    dialogueId: line.id,
    generationId: 'take',
    sourcePath: p.media!.path,
    language: 'fr',
    path: 'generations/lips-edit.mp4',
    createdAt: new Date().toISOString(),
    modelRevision: 'fixed',
    startMs: clip.startMs,
    durationMs: Math.floor((clip.endMs - clip.startMs) / 40) * 40,
    slotMs: clip.slotMs,
    exactDuration: clip.exactDuration,
    fingerprint: 'a'.repeat(64),
    enabled: false,
    options: {
      lineId: line.id,
      generationId: 'take',
      device: 'cuda:0',
      face: { x: 0.1, y: 0.1, width: 0.5, height: 0.8 },
      endX: 0.2,
      endY: 0.1,
      mask: { x: 0.2, y: 0.6, width: 0.6, height: 0.3 },
      blend: 0.7,
      feather: 0.12,
      style: 'anime',
      seed: 0,
    },
  };
  p.generations.push(e as unknown as (typeof p.generations)[number]);
  return { p, e, line };
}
it('invalidates a retouched mouth after an audio edit, including equal-length gain changes', () => {
  const { p, e } = fixture();
  const changed = editVoice(p, 'take', 0, 500, { kind: 'gain', gain: 0.5 });
  const clip = dubbingClips(changed)[0];
  const edited = {
    ...e,
    startMs: clip.startMs,
    slotMs: clip.slotMs,
    exactDuration: clip.exactDuration,
  };
  expect(currentLipVideo(changed, edited)).toBe(false);
  edited.voiceEditKey = JSON.stringify(changed.voiceEdits!.take).replace('"gain":1', '"gain":1.0');
  expect(currentLipVideo(changed, edited)).toBe(true);
  expect(selectLipVideo(changed, e.id, false).formatVersion).toBe(11);
});
it('activates one non-destructive variant and keeps it through project serialization', () => {
  const { p, e } = fixture();
  const q = selectLipVideo(p, e.id, true);
  expect(lipVideos(q)[0].enabled).toBe(true);
  expect(lipVideos(p)[0].enabled).toBe(false);
  expect(validateProject(JSON.parse(JSON.stringify(q)))).toEqual(q);
  expect(currentLipVideo(q, e)).toBe(true);
});
it('rejects stale variants after take movement, resizing, replacement media or language', () => {
  const { p, e, line } = fixture();
  for (const q of [
    moveDubbing(p, line.id, 100),
    resizeDubbing(p, line.id, 1000),
    { ...p, languages: { source: 'ja', target: 'en' } },
    { ...p, media: { ...p.media!, path: 'media/new.mkv' } },
  ]) {
    expect(currentLipVideo(q, e)).toBe(false);
    expect(() => selectLipVideo(q, e.id, true)).toThrow('INPAINT_STALE');
  }
});
it('rejects overlapping active retouches, CPU profile, malformed mask and unsafe assets', () => {
  const { p, e } = fixture();
  const active = selectLipVideo(p, e.id, true);
  const other = {
    ...e,
    id: 'other',
    path: 'generations/lips-other.mp4',
    dialogueId: 'other',
    options: { ...e.options, lineId: 'other' },
    enabled: true,
  };
  expect(() => validateProject({ ...active, generations: [...active.generations, other] })).toThrow(
    'INPAINT_OVERLAP',
  );
  for (const e2 of [
    { ...e, path: '../bad.mp4' },
    { ...e, options: { ...e.options, device: 'cpu' } },
    { ...e, options: { ...e.options, mask: { x: 0.8, y: 0.6, width: 0.6, height: 0.3 } } },
  ])
    expect(() => validateProject({ ...p, generations: [p.generations[0], e2] })).toThrow();
});
