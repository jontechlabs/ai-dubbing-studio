import { describe, it, expect } from 'vitest';
import { demoProject, validateProject } from './project';
import { defaultVoiceSettings, spokenText } from './tts';
import { applyLipAnalysis, type LipAnalysis } from './lips';
import type { Generation } from './types';
function fixture() {
  const project = demoProject(),
    line = project.dialogues[0];
  project.formatVersion = 5;
  line.selectedGenerationIds.fr = 'take';
  const generation: Generation = {
    id: 'take',
    kind: 'tts',
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: 'generations/take.wav',
    createdAt: new Date().toISOString(),
    sourcePath: project.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: spokenText(project, line),
    language: 'fr',
    characterId: line.characterId,
    durationMs: 2000,
    sampleRate: 24000,
    options: defaultVoiceSettings,
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'fixture',
  };
  project.generations = [generation];
  const analysis: LipAnalysis = {
    projectId: project.id,
    revision: project.revision,
    sourcePath: project.media!.path,
    language: 'fr',
    options: {
      lineId: line.id,
      generationId: 'take',
      startMs: 0,
      endMs: 4000,
      region: { x: 0.4, y: 0.3, width: 0.2, height: 0.2 },
    },
    startMs: 1000,
    durationMs: 2500,
    score: 0.9,
    currentScore: 0.5,
    reliable: true,
    warnings: [],
    stepMs: 40,
    mouth: [],
    voice: [],
  };
  return { project, analysis };
}
describe('visual alignment proposals', () => {
  it('applies start and duration as a single project edit without altering subtitles or original takes', () => {
    const { project, analysis } = fixture(),
      before = JSON.stringify([
        project.sourceCues,
        project.targetCues,
        project.dialogues,
        project.generations,
      ]);
    const after = applyLipAnalysis(project, analysis),
      id = project.dialogues[0].id;
    expect(after.dubbingTiming!.offsetsMs[id].fr).toBe(250);
    expect(after.dubbingTiming!.durationsMs![id].fr).toBe(2500);
    expect(
      JSON.stringify([after.sourceCues, after.targetCues, after.dialogues, after.generations]),
    ).toBe(before);
    expect(validateProject(JSON.parse(JSON.stringify(after)))).toEqual(after);
    expect(project.dubbingTiming).toBeUndefined();
  });
  it('rejects stale projects, replaced media/languages/takes and invalid output windows', () => {
    const { project, analysis } = fixture();
    expect(() =>
      applyLipAnalysis({ ...project, revision: project.revision + 1 }, analysis),
    ).toThrow('STALE_REVISION');
    expect(() =>
      applyLipAnalysis(
        { ...project, media: { ...project.media!, path: 'media/other.mkv' } },
        analysis,
      ),
    ).toThrow('STALE_REVISION');
    expect(() =>
      applyLipAnalysis({ ...project, languages: { ...project.languages, target: 'en' } }, analysis),
    ).toThrow('STALE_REVISION');
    expect(() =>
      applyLipAnalysis(project, {
        ...analysis,
        options: { ...analysis.options, generationId: 'another' },
      }),
    ).toThrow('STALE_REVISION');
    expect(() => applyLipAnalysis(project, { ...analysis, startMs: 5000 })).toThrow(
      'LIPS_ANALYSIS_FAILED',
    );
    expect(() => applyLipAnalysis(project, { ...analysis, durationMs: NaN })).toThrow(
      'LIPS_ANALYSIS_FAILED',
    );
  });
});
