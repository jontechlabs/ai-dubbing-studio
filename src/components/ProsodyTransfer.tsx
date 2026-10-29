import { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Generation, Job, Project } from '../domain/types';
import type { ProsodyOptions } from '../domain/prosody';
import { audioTracks, trackLabel } from '../domain/audio';
import * as bridge from '../services/bridge';
export function ProsodyTransfer({
  project,
  line,
  takes,
  chosen,
  jobs,
  snapshot,
  startTask,
  onError,
}: {
  project: Project;
  line: Dialogue;
  takes: Generation[];
  chosen: Generation | undefined;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  startTask: (operation: () => Promise<string>) => Promise<string>;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const previous = chosen?.prosodyTransfer;
  const previousOptions = previous?.options;
  const [sourceId, setSourceId] = useState(
    takes.some((g) => g.id === previous?.sourceGenerationId)
      ? previous!.sourceGenerationId
      : (chosen?.id ?? takes.at(-1)?.id ?? ''),
  );
  const [guide, setGuide] = useState(
      previousOptions?.referenceMode === 'reference'
        ? previousOptions.characterId
          ? `character:${previousOptions.characterId}:${previousOptions.referenceId}`
          : `file:${previousOptions.referenceId}`
        : 'dialogue',
    ),
    [track, setTrack] = useState(previousOptions?.referenceTrackId ?? 'auto');
  const [strength, setStrength] = useState(previousOptions?.strength ?? 0.5),
    [parts, setParts] = useState({
      pitch: previousOptions?.pitch ?? true,
      rhythm: previousOptions?.rhythm ?? true,
      energy: previousOptions?.energy ?? true,
    });
  const [available, setAvailable] = useState<boolean | null>(null),
    [working, setWorking] = useState(false);
  useEffect(() => {
    let disposed = false;
    if (bridge.native)
      void bridge
        .prosodyStatus()
        .then((s) => {
          if (!disposed) setAvailable(s.available);
        })
        .catch((error) => {
          if (!disposed) onError(String(error));
        });
    return () => {
      disposed = true;
    };
  }, [onError]);
  const busy = working || jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const selected = takes.find((g) => g.id === sourceId) ?? chosen ?? takes.at(-1);
  const refs = [
    ...(project.voiceReferences ?? []).map((r) => ({
      ...r,
      owner: null as string | null,
      value: `file:${r.id}`,
    })),
    ...project.characters.flatMap((c) =>
      c.references.map((r) => ({
        ...r,
        owner: c.id,
        label: `${c.name} · ${r.label}`,
        value: `character:${c.id}:${r.id}`,
      })),
    ),
  ];
  const reference = refs.find((r) => r.value === guide);
  const length =
    selected &&
    (project.voiceEdits?.[selected.id]?.pieces.reduce((sum, p) => sum + p.durationMs, 0) ??
      selected.durationMs);
  const guideLength = guide === 'dialogue' ? line.endMs - line.startMs : reference?.durationMs;
  const tooLong = [length, guideLength].some(
    (duration) => duration != null && (duration < 150 || duration > 30000),
  );
  const noGuide = guide === 'dialogue' ? !project.media : !reference;
  return (
    <details className="prosody-transfer">
      <summary>
        <AudioLines size={15} />
        {t('prosody.title')}
      </summary>
      <p className="panel-description">{t('prosody.hint')}</p>
      <label className="field">
        <span>{t('prosody.source')}</span>
        <select
          value={selected?.id ?? ''}
          disabled={busy || !takes.length}
          onChange={(e) => setSourceId(e.target.value)}
        >
          {!takes.length && <option value="">{t('ttsNoGeneration')}</option>}
          {takes.map((g, i) => (
            <option key={g.id} value={g.id}>
              {t('ttsGenerationNumber', { number: i + 1 })} · {(g.durationMs / 1000).toFixed(2)} s ·{' '}
              {project.voiceReferences?.find((r) => r.id === g.referenceId)?.label ?? g.modelId}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>{t('prosody.guide')}</span>
        <select value={guide} disabled={busy} onChange={(e) => setGuide(e.target.value)}>
          <option value="dialogue">{t('prosody.originalGuide')}</option>
          {refs.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      {guide === 'dialogue' && (
        <label className="field">
          <span>{t('prosody.guideTrack')}</span>
          <select value={track} disabled={busy} onChange={(e) => setTrack(e.target.value)}>
            <option value="auto">{t('ttsReferenceCurrent')}</option>
            {audioTracks(project)
              .filter((t) => t.kind !== 'dubbing')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {t(trackLabel(item))}
                </option>
              ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>
          {t('prosody.strength')} · {Math.round(strength * 100)} %
        </span>
        <input
          aria-label={t('prosody.strength')}
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={strength}
          disabled={busy}
          onChange={(e) => setStrength(Number(e.target.value))}
        />
      </label>
      <div className="prosody-parts">
        {(['pitch', 'rhythm', 'energy'] as const).map((part) => (
          <label key={part} className="checkbox-field">
            <input
              type="checkbox"
              checked={parts[part]}
              disabled={busy}
              onChange={(e) => setParts({ ...parts, [part]: e.target.checked })}
            />
            {t(`prosody.${part}`)}
          </label>
        ))}
      </div>
      <p className="panel-description">{t('prosody.limits')}</p>
      {available === false && <p className="warning">{t('errors.PROSODY_UNAVAILABLE')}</p>}
      {tooLong && <p className="warning">{t('errors.PROSODY_TOO_LONG')}</p>}
      <button
        className="button accent wide"
        disabled={
          !bridge.native ||
          !available ||
          busy ||
          !selected ||
          noGuide ||
          tooLong ||
          !Object.values(parts).some(Boolean)
        }
        onClick={() => {
          if (!selected) return;
          const options: ProsodyOptions = {
            generationId: selected.id,
            referenceMode: guide === 'dialogue' ? 'dialogue' : 'reference',
            referenceId: reference?.id ?? null,
            characterId: reference?.owner ?? null,
            referenceTrackId: track,
            strength,
            ...parts,
          };
          setWorking(true);
          void startTask(async () => {
            await snapshot();
            return bridge.transferVoiceProsody(options);
          })
            .catch((error) => onError(String(error)))
            .finally(() => setWorking(false));
        }}
      >
        <AudioLines size={15} />
        {t('prosody.create')}
      </button>
    </details>
  );
}
