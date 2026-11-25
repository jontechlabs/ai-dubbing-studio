import type { VoiceSettings } from './types';

export interface ScriptTurn {
  speaker: number;
  label: string;
  text: string;
}
export interface ScriptSlot {
  startMs: number;
  endMs: number;
}
export interface ScriptSpeaker {
  speaker: number;
  name: string;
  characterId: string | null;
  referenceMode: 'custom' | 'file' | 'library';
  referenceId: string;
}
export interface ScriptedDubbingOptions {
  script: string;
  startMs: number;
  durationMs: number;
  slots?: ScriptSlot[];
  speakers: ScriptSpeaker[];
  options: VoiceSettings;
}
export interface ScriptedDubbingGeneration {
  lineIds: string[];
  takeCount: 1 | 2 | 3 | 4;
}
export interface ScriptPreview {
  turns: (ScriptTurn & ScriptSlot)[];
}

/** Speaker labels are editor syntax, never instructions sent to a TTS model. */
export function parseSpeakerScript(script: string): ScriptTurn[] {
  if (new TextEncoder().encode(script).length > 65_536) throw Error('SCRIPT_INVALID');
  const turns: ScriptTurn[] = [];
  for (const raw of script.replaceAll('\r\n', '\n').split('\n')) {
    const line = raw.trim();
    if (/^\[speaker/i.test(line)) {
      const match = /^\[speaker ([1-9]\d?)(?::\s*([^\]\r\n]{1,80}))?\]\s*(.*)$/i.exec(line);
      if (!match || (match[2] !== undefined && !match[2].trim())) throw Error('SCRIPT_INVALID');
      turns.push({ speaker: Number(match[1]), label: match[2]?.trim() ?? '', text: match[3] });
    } else if (line) {
      if (!turns.length) throw Error('SCRIPT_INVALID');
      turns.at(-1)!.text += (turns.at(-1)!.text ? '\n' : '') + line;
    }
  }
  if (
    !turns.length ||
    turns.length > 128 ||
    new Set(turns.map((t) => t.speaker)).size > 16 ||
    turns.some((t) => !t.text.trim() || [...t.text].length > 1000 || /\[speaker/i.test(t.text))
  )
    throw Error('SCRIPT_INVALID');
  return turns.map((t) => ({ ...t, text: t.text.trim() }));
}

export function scriptSlots(
  turns: ScriptTurn[],
  startMs: number,
  durationMs: number,
): ScriptSlot[] {
  return turns.map((_, i) => ({
    startMs: startMs + i * durationMs,
    endMs: startMs + (i + 1) * durationMs,
  }));
}
