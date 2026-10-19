import type { VoiceEdit } from './voiceEdit';

// The original WAV and the edited waveform have different clocks after a cut,
// silence insertion or stretch. Removed source samples have no edited position.
export function sourceToEditedTime(plan: VoiceEdit, sourceMs: number): number | null {
  if (!Number.isFinite(sourceMs) || sourceMs < 0) return null;
  let offset = 0;
  for (const piece of plan.pieces) {
    if (
      piece.sourceStartMs !== null &&
      piece.sourceEndMs !== null &&
      sourceMs >= piece.sourceStartMs &&
      sourceMs <= piece.sourceEndMs
    )
      return (
        offset +
        ((sourceMs - piece.sourceStartMs) / (piece.sourceEndMs - piece.sourceStartMs)) *
          piece.durationMs
      );
    offset += piece.durationMs;
  }
  return null;
}
