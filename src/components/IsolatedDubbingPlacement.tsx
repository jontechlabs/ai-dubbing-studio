import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Project } from '../domain/types';
import { dubbingLanes } from '../domain/dubbingLanes';
import { voiceGenerations } from '../domain/tts';
import type { SpeakerDubbingPlacement } from '../domain/speakerDubbing';
import * as bridge from '../services/bridge';

/** Shared review step for dialogue-bound and free-region speaker separation. */
export function IsolatedDubbingPlacement({
  project,
  result,
  urls,
  busy,
  snapshot,
  run,
  onError,
  onAudition,
}: {
  project: Project;
  result: { id: string; outputs: string[]; stale: boolean };
  urls: Record<string, string>;
  busy: boolean;
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  onError: (error: string) => void;
  onAudition: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [working, setWorking] = useState(false);
  const [language, setLanguage] = useState(project.languages.source);
  const [rows, setRows] = useState<SpeakerDubbingPlacement[]>(() =>
    result.outputs.map((outputId, i) => {
      const voice = project.speakerDubbings
        ?.find((g) => g.separationId === result.id)
        ?.voices.find((v) => v.outputId === outputId);
      return {
        outputId,
        label: voice?.label ?? t('overlap.voice', { number: i + 1 }),
        characterId: voice
          ? (project.dialogues.find((l) => l.id === voice.lineId)?.characterId ?? null)
          : null,
        sourceText: voice?.sourceText ?? '',
        targetText: voice?.translations[project.languages.target] ?? '',
        laneId: null,
        laneName: voice?.label.slice(0, 80) ?? t('overlap.voice', { number: i + 1 }),
      };
    }),
  );
  const [skip, setSkip] = useState<string[]>([]),
    [done, setDone] = useState<string[]>([]);
  const placed = new Set([
    ...done,
    ...voiceGenerations(project)
      .filter((g) => g.takeOrigin?.type === 'separation' && g.takeOrigin.separationId === result.id)
      .map((g) => g.takeOrigin!.outputId!),
  ]);
  const chosen = rows.filter((r) => !skip.includes(r.outputId) && !placed.has(r.outputId));
  const locked = busy || working || result.stale;
  const patch = (outputId: string, edit: Partial<SpeakerDubbingPlacement>) =>
    setRows((rows) => rows.map((r) => (r.outputId === outputId ? { ...r, ...edit } : r)));
  return (
    <details
      className="isolated-dubbing-placement"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{t('isolatedPlacement.title')}</summary>
      {open && (
        <>
          <p className="panel-description">{t('isolatedPlacement.hint')}</p>
          <label className="field">
            <span>{t('isolatedPlacement.language')}</span>
            <select
              disabled={locked}
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {[...new Set([project.languages.source, project.languages.target])].map(
                (language) => (
                  <option key={language} value={language}>
                    {language.toUpperCase()}
                  </option>
                ),
              )}
            </select>
          </label>
          {rows.map((row) => (
            <fieldset key={row.outputId} disabled={locked || placed.has(row.outputId)}>
              <legend>{row.label}</legend>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={!skip.includes(row.outputId)}
                  onChange={(e) =>
                    setSkip((s) =>
                      e.target.checked
                        ? s.filter((id) => id !== row.outputId)
                        : [...s, row.outputId],
                    )
                  }
                />
                {t(
                  placed.has(row.outputId) ? 'isolatedPlacement.placed' : 'isolatedPlacement.keep',
                )}
              </label>
              <audio
                controls
                src={urls[row.outputId]}
                preload="metadata"
                aria-label={row.label}
                onPlay={(e) => {
                  document.querySelectorAll('audio').forEach((a) => {
                    if (a !== e.currentTarget) a.pause();
                  });
                  onAudition();
                }}
              />
              <label className="field">
                <span>{t('character')}</span>
                <select
                  value={row.characterId ?? ''}
                  onChange={(e) => patch(row.outputId, { characterId: e.target.value || null })}
                >
                  <option value="">{t('unassigned')}</option>
                  {project.characters.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{t('isolatedPlacement.lane')}</span>
                <select
                  value={row.laneId ?? ''}
                  onChange={(e) => patch(row.outputId, { laneId: e.target.value || null })}
                >
                  <option value="">{t('isolatedPlacement.newLane')}</option>
                  {dubbingLanes(project).map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              {!row.laneId && (
                <label className="field">
                  <span>{t('isolatedPlacement.name')}</span>
                  <input
                    maxLength={80}
                    value={row.laneName}
                    onChange={(e) =>
                      patch(row.outputId, { laneName: e.target.value, label: e.target.value })
                    }
                  />
                </label>
              )}
            </fieldset>
          ))}
          <button
            className="button accent wide"
            disabled={
              locked ||
              !chosen.length ||
              chosen.some((r) => !r.label.trim() || (!r.laneId && !r.laneName.trim()))
            }
            onClick={() => {
              const submitted = chosen;
              setWorking(true);
              void run(async () => {
                await snapshot();
                const p = await bridge.placeSpeakerDubbings(result.id, language, submitted);
                setDone((ids) => [...ids, ...submitted.map((r) => r.outputId)]);
                return p;
              })
                .catch((e) => onError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            {t('isolatedPlacement.place')}
          </button>
          {result.stale && <p className="warning">{t('isolatedPlacement.stale')}</p>}
        </>
      )}
    </details>
  );
}
