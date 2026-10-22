import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AudioSelection, Project } from '../domain/types';
import { audioTracks, trackLabel } from '../domain/audio';
import { EffectsChainEditor } from './EffectsChainEditor';
import * as bridge from '../services/bridge';
import type { AudioEffect } from '../domain/audioEffects';
export function AudioEffectsPanel({
  project,
  selection,
  busy,
  run,
  onError,
}: {
  project: Project;
  selection: AudioSelection | null;
  busy: boolean;
  run: (op: () => Promise<Project | null>) => Promise<void>;
  onError: (s: string) => void;
}) {
  const { t } = useTranslation();
  const tracks = audioTracks(project);
  const [trackId, setTrackId] = useState(selection?.trackId ?? tracks[0]?.id ?? 'original');
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const [scope, setScope] = useState<'track' | 'selection'>(
    selection && track.kind !== 'dubbing' ? 'selection' : 'track',
  );
  const [start, setStart] = useState(selection?.startMs ?? 0),
    [end, setEnd] = useState(selection?.endMs ?? Math.min(5000, project.media!.durationMs));
  const [working, setWorking] = useState(false);
  const invalid =
    scope === 'selection' &&
    (!Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end > project.media!.durationMs ||
      end - start > 120000 ||
      track.kind === 'dubbing');
  const [replace, setReplace] = useState(true);
  const candidates = project.generations as {
    id: string;
    kind?: string;
    trackId?: string;
    operation?: string;
    startMs?: number;
    endMs?: number;
    effects?: AudioEffect[];
  }[];
  const previous = [...candidates]
    .reverse()
    .find(
      (g) =>
        g.trackId === track.id &&
        (scope === 'track'
          ? g.kind === 'audioEffects'
          : g.kind === 'audioPatch' &&
            g.operation === 'effects' &&
            g.startMs === start &&
            g.endMs === end),
    );
  const savedEffects = previous?.effects as AudioEffect[] | undefined;

  return (
    <details className="audio-effects-panel">
      <summary>{t('fxTitle')}</summary>
      <p className="panel-description">{t('fxTrackHint')}</p>
      <label className="field">
        <span>{t('fxTrack')}</span>
        <select
          aria-label={t('fxTrack')}
          value={track.id}
          disabled={busy || working}
          onChange={(e) => {
            setTrackId(e.target.value);
            if (tracks.find((t) => t.id === e.target.value)?.kind === 'dubbing') setScope('track');
          }}
        >
          {tracks.map((tk) => (
            <option key={tk.id} value={tk.id}>
              {t(trackLabel(tk))}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('fxScope')}</span>
        <select
          aria-label={t('fxScope')}
          value={scope}
          disabled={busy || working}
          onChange={(e) => setScope(e.target.value as 'track' | 'selection')}
        >
          <option value="track">{t('fxWholeTrack')}</option>
          <option value="selection" disabled={track.kind === 'dubbing'}>
            {t('fxSelection')}
          </option>
        </select>
      </label>
      {scope === 'selection' && (
        <div className="effects-range">
          <label>
            {t('voiceSelectionStart')}
            <input
              type="number"
              aria-label={t('fxRangeStart')}
              min={0}
              max={project.media!.durationMs}
              value={start}
              disabled={busy || working}
              onChange={(e) => setStart(Number(e.target.value))}
            />
          </label>
          <label>
            {t('voiceSelectionEnd')}
            <input
              type="number"
              aria-label={t('fxRangeEnd')}
              min={0}
              max={project.media!.durationMs}
              value={end}
              disabled={busy || working}
              onChange={(e) => setEnd(Number(e.target.value))}
            />
          </label>
        </div>
      )}
      {invalid && <p role="alert">{t('errors.AUDIO_EFFECTS_SELECTION_LIMIT')}</p>}
      {scope === 'track' && !previous && (
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={replace}
            disabled={busy || working}
            onChange={(e) => setReplace(e.target.checked)}
          />
          {t('fxReplaceInMix')}
        </label>
      )}
      <EffectsChainEditor
        key={`${track.id}:${scope}:${start}:${end}:${JSON.stringify(savedEffects ?? [])}`}
        initial={savedEffects ?? []}
        allowEmpty={!!previous}
        disabled={busy || working || invalid || !bridge.native}
        applyLabel={t(
          scope === 'track' ? (previous ? 'fxUpdateTrack' : 'fxRenderTrack') : 'fxApplySelection',
        )}
        onApply={(effects) => {
          setWorking(true);
          void run(async () => {
            try {
              await bridge.applyAudioEffects({
                trackId: track.id,
                scope,
                startMs: scope === 'track' ? 0 : start,
                endMs: scope === 'track' ? project.media!.durationMs : end,
                effects,
                replaceInMix: replace,
                name: `${t(trackLabel(track)).slice(0, 145)} · FX`,
              });
            } catch (e) {
              onError(String(e));
            }
            return null;
          }).finally(() => setWorking(false));
        }}
      />
    </details>
  );
}
