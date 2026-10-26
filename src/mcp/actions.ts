import type { Project } from '../domain/types';
import { validateProject } from '../domain/project';
import { editDialogue } from '../domain/subtitles';
import { approveTranslation, approveTranslations } from '../domain/translation';
import {
  editCharacterProfile,
  mergeCharacters,
  type CharacterProfile,
  type CharacterMerge,
} from '../domain/characterReview';
import { applySpeakers } from '../domain/characters';
import { retimeDialogue, splitDialogue, mergeDialogue } from '../domain/timing';
import { moveDubbing, resizeDubbing } from '../domain/mix';
import { editVoice, type VoiceOperation } from '../domain/voiceEdit';
import { paintAudioRegion, editTrack, setAllAudio, removeAudioRegion } from '../domain/audio';
import { selectGeneration, deleteGeneration, reviewGeneration } from '../domain/tts';
import { selectLipVideo } from '../domain/inpaint';
import catalog from './catalog.json';
const projectSchema = catalog.schemas.Project as {
  $ref: string;
  $defs: Record<string, { properties: Record<string, unknown> }>;
};
const projectFields = new Set(
  Object.keys(projectSchema.$defs[projectSchema.$ref.split('/').at(-1)!].properties),
);

export interface Context {
  projectId: string;
  expectedRevision: number;
}
export function checkContext(project: Project | null, context: Context) {
  if (!project) throw Error('NO_PROJECT');
  if (project.id !== context.projectId || project.revision !== context.expectedRevision)
    throw Error('STALE_REVISION');
  return project;
}
export interface Patch {
  op: 'add' | 'replace' | 'remove' | 'test';
  path: string;
  value?: unknown;
}
export function patchProject(project: Project, patches: Patch[]): Project {
  if (!Array.isArray(patches) || patches.length < 1 || patches.length > 500)
    throw Error('MCP_INVALID_PATCH');
  const next = structuredClone(project);
  for (const patch of patches) {
    if (patch.op !== 'remove' && !Object.hasOwn(patch, 'value')) throw Error('MCP_INVALID_PATCH');
    if (typeof patch.path !== 'string' || !patch.path.startsWith('/'))
      throw Error('MCP_INVALID_PATCH');
    const parts = patch.path
      .slice(1)
      .split('/')
      .map((part) => {
        if (/~(?![01])/u.test(part)) throw Error('MCP_INVALID_PATCH');
        return part.replaceAll('~1', '/').replaceAll('~0', '~');
      });
    if (
      !projectFields.has(parts[0]) ||
      parts.some((part) => ['__proto__', 'constructor', 'prototype'].includes(part)) ||
      ['id', 'revision', 'createdAt', 'updatedAt', 'appVersion'].includes(parts[0])
    )
      throw Error('MCP_INVALID_PATCH');
    let target: unknown = next;
    for (const part of parts.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, part))
        throw Error('MCP_INVALID_PATCH');
      target = (target as Record<string, unknown>)[part];
    }
    if (!target || typeof target !== 'object') throw Error('MCP_INVALID_PATCH');
    const last = parts.at(-1)!;
    const record = target as Record<string, unknown>;
    const exists = Object.hasOwn(record, last);
    if (patch.op === 'test') {
      if (!exists || JSON.stringify(record[last]) !== JSON.stringify(patch.value))
        throw Error('MCP_PATCH_TEST_FAILED');
    } else if (Array.isArray(target)) {
      const index = last === '-' && patch.op === 'add' ? target.length : Number(last);
      if (
        !Number.isSafeInteger(index) ||
        (String(index) !== last && last !== '-') ||
        index < 0 ||
        index > target.length ||
        (patch.op !== 'add' && index === target.length)
      )
        throw Error('MCP_INVALID_PATCH');
      if (patch.op === 'add') target.splice(index, 0, structuredClone(patch.value));
      else if (patch.op === 'remove') target.splice(index, 1);
      else if (patch.op === 'replace') target[index] = structuredClone(patch.value);
      else throw Error('MCP_INVALID_PATCH');
    } else if (patch.op === 'remove') {
      if (!exists) throw Error('MCP_INVALID_PATCH');
      delete record[last];
    } else if (patch.op === 'add' || patch.op === 'replace') {
      if (patch.op === 'replace' && !exists) throw Error('MCP_INVALID_PATCH');
      record[last] = structuredClone(patch.value);
    } else throw Error('MCP_INVALID_PATCH');
  }
  return validateProject(next);
}

// All saved edits share the desktop's pure domain functions and native save/
// undo path. MCP cannot evaluate code or replace the filesystem asset resolver.
export function editProject(
  project: Project,
  tool: string,
  args: Record<string, unknown>,
): Project {
  const id = String(args.lineId ?? args.id ?? '');
  const line = () => {
    const found = project.dialogues.find((line) => line.id === id);
    if (!found) throw Error('MCP_UNKNOWN_DIALOGUE');
    return found;
  };
  let next: Project;
  switch (tool) {
    case 'studio_set_character_profile':
      next = editCharacterProfile(project, id, args.changes as CharacterProfile);
      break;
    case 'studio_merge_characters':
      next = mergeCharacters(project, args.options as CharacterMerge);
      break;
    case 'studio_apply_speaker_analysis':
      next = applySpeakers(
        project,
        String(args.referenceLabel ?? 'Voice sample'),
        String(args.temporaryPrefix ?? 'Character'),
      );
      break;
    case 'studio_approve_translations': {
      if (
        !Array.isArray(args.ids) ||
        !args.ids.length ||
        args.ids.some((id) => typeof id !== 'string') ||
        typeof args.approved !== 'boolean'
      )
        throw Error('MCP_INVALID_ARGUMENTS');
      const existing = new Set(project.dialogues.map((line) => line.id));
      if (args.ids.some((id) => !existing.has(id))) throw Error('MCP_UNKNOWN_DIALOGUE');
      next = approveTranslations(project, args.ids as string[], args.approved);
      break;
    }
    case 'studio_project_patch':
      return patchProject(project, args.patches as Patch[]);
    case 'studio_edit_dialogue': {
      line();
      next = editDialogue(project, id, args.role as 'source' | 'target' | 'tts', String(args.text));
      if (typeof args.approved === 'boolean') next = approveTranslation(next, id, args.approved);
      break;
    }
    case 'studio_retime_dialogue':
      line();
      next = retimeDialogue(
        project,
        id,
        args.startMs as number,
        args.endMs as number,
        args.role as 'source' | 'target' | 'both',
      );
      break;
    case 'studio_split_dialogue':
      line();
      next = splitDialogue(project, id, args.atMs as number);
      break;
    case 'studio_merge_dialogue':
      line();
      next = mergeDialogue(project, id);
      break;
    case 'studio_move_voice':
      line();
      next = moveDubbing(project, id, args.offsetMs as number);
      break;
    case 'studio_resize_voice':
      line();
      next = resizeDubbing(project, id, args.durationMs as number);
      break;
    case 'studio_edit_voice':
      next = editVoice(
        project,
        id,
        args.startMs as number,
        args.endMs as number,
        args.operation as VoiceOperation,
      );
      break;
    case 'studio_set_track':
      next = editTrack(project, id, args.changes as Parameters<typeof editTrack>[2]);
      break;
    case 'studio_audio_region':
      next = paintAudioRegion(project, id, {
        startMs: args.startMs as number,
        endMs: args.endMs as number,
        gain: args.gain as number,
        mute: args.mute as boolean,
      });
      break;
    case 'studio_remove_audio_region':
      next = removeAudioRegion(project, id, String(args.regionId));
      break;
    case 'studio_set_all_audio':
      next = setAllAudio(project, args.audible as boolean, args.trackId as string | undefined);
      break;
    case 'studio_select_take':
      next = selectGeneration(project, id);
      break;
    case 'studio_delete_take':
      next = deleteGeneration(project, id);
      break;
    case 'studio_review_take':
      line();
      next = reviewGeneration(project, id, args.validated as boolean);
      break;
    case 'studio_set_lip_variant':
      next = selectLipVideo(project, id, args.enabled as boolean);
      break;
    default:
      throw Error('MCP_UNKNOWN_TOOL');
  }
  return validateProject(next);
}
