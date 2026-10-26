import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ImagePlus, Play, Users, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Character, Dialogue, Project } from '../domain/types';
import {
  editCharacterProfile,
  mergeCharacters,
  similarCharacterPortraits,
  type CharacterPortrait,
} from '../domain/characterReview';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import * as bridge from '../services/bridge';

const assets = new Map<string, Promise<string>>();
export function CharacterAvatar({
  project,
  portrait,
  name = '',
  small = false,
}: {
  project: Project;
  portrait?: CharacterPortrait;
  name?: string;
  small?: boolean;
}) {
  const [asset, setAsset] = useState<{ key: string; url: string } | null>(null);
  const key = `${project.id}:${portrait?.path ?? ''}`;
  useEffect(() => {
    if (!portrait) return;
    let disposed = false;
    let pending = assets.get(key);
    if (!pending) {
      pending = bridge.characterAssetUrl(portrait.path);
      assets.set(key, pending);
      if (assets.size > 256) assets.delete(assets.keys().next().value!);
    }
    void pending
      .then((url) => {
        if (!disposed) setAsset({ key, url });
      })
      .catch(() => assets.delete(key));
    return () => {
      disposed = true;
    };
  }, [key, portrait, project.revision]);
  return (
    <span className={`character-thumbnail ${small ? 'small' : ''}`}>
      {asset?.key === key ? (
        <img src={asset.url} alt={name} loading="lazy" />
      ) : (
        <UserRound size={small ? 14 : 30} />
      )}
    </span>
  );
}

export function CharacterSamples({
  project,
  character,
  busy,
  onError,
  onNavigate,
}: {
  project: Project;
  character: Character;
  busy: boolean;
  onError: (message: string) => void;
  onNavigate: (line: Dialogue) => void;
}) {
  const { t } = useTranslation();
  const [trackId, setTrackId] = useState('auto'),
    [page, setPage] = useState(0),
    [url, setUrl] = useState(''),
    [working, setWorking] = useState(false);
  const player = useRef<HTMLAudioElement>(null),
    serial = useRef(0);
  useEffect(() => {
    if (url) void player.current?.play().catch((error) => onError(String(error)));
  }, [url, onError]);
  useEffect(
    () => () => {
      serial.current++;
      player.current?.pause();
    },
    [character.id, project.id],
  );
  const rows = useMemo(
    () => project.dialogues.filter((line) => line.characterId === character.id),
    [project.dialogues, character.id],
  );
  const index = Math.min(page, Math.max(0, Math.ceil(rows.length / 6) - 1));
  const play = async (line: Dialogue) => {
    const request = ++serial.current;
    setWorking(true);
    try {
      const value = await bridge.characterSampleUrl(line.id, trackId);
      if (request !== serial.current) return;
      setUrl(value);
    } catch (error) {
      if (request === serial.current) onError(String(error));
    } finally {
      if (request === serial.current) setWorking(false);
    }
  };
  return (
    <details className="character-samples" open>
      <summary>{t('characterSamples', { count: rows.length })}</summary>
      <label className="field">
        <span>{t('characterSampleTrack')}</span>
        <select
          aria-label={t('characterSampleTrack')}
          value={trackId}
          onChange={(e) => {
            player.current?.pause();
            serial.current++;
            setWorking(false);
            setTrackId(e.target.value);
          }}
        >
          <option value="auto">{t('characterSampleAuto')}</option>
          {audioTracks(project)
            .filter((track) => track.kind !== 'dubbing')
            .map((track) => (
              <option key={track.id} value={track.id}>
                {t(trackLabel(track))}
              </option>
            ))}
        </select>
      </label>
      <audio
        ref={player}
        controls
        src={url || undefined}
        aria-label={t('characterSamplePlayer')}
        preload="none"
      />
      <small>{t('characterSampleHint')}</small>
      {rows.slice(index * 6, index * 6 + 6).map((line) => (
        <div className="character-sample" key={line.id}>
          <span>
            {formatTime(line.startMs)} → {formatTime(line.endMs)}
          </span>
          <button
            className="button subtle"
            aria-label={t('characterListenSample', { time: formatTime(line.startMs) })}
            disabled={busy || working}
            onClick={() => void play(line)}
          >
            <Play size={13} />
            {t('characterListen')}
          </button>
          <button className="text-button" onClick={() => onNavigate(line)}>
            {t('characterGoToLine')}
          </button>
        </div>
      ))}
      {rows.length > 6 && (
        <div className="character-pagination">
          <button className="text-button" disabled={index === 0} onClick={() => setPage(index - 1)}>
            {t('characterPrevious')}
          </button>
          <span>
            {index + 1}/{Math.ceil(rows.length / 6)}
          </span>
          <button
            className="text-button"
            disabled={(index + 1) * 6 >= rows.length}
            onClick={() => setPage(index + 1)}
          >
            {t('characterNext')}
          </button>
        </div>
      )}
    </details>
  );
}

export function CharacterMetadata({
  project,
  character,
  selectedId,
  busy,
  onEdit,
  run,
  onError,
}: {
  project: Project;
  character: Character;
  selectedId: string | null;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
  run: (action: () => Promise<Project | null>) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const profile = project.characterProfiles?.[character.id];
  const [lineId, setLineId] = useState(
    selectedId ?? project.dialogues.find((l) => l.characterId === character.id)?.id ?? '',
  );
  const [time, setTime] = useState(''),
    [automatic, setAutomatic] = useState(true),
    [crop, setCrop] = useState({ x: 0, y: 0, width: 100, height: 100 }),
    [working, setWorking] = useState(false);
  const validLineId = project.dialogues.some((l) => l.id === lineId) ? lineId : '';
  const register = profile?.vocalRegister;
  return (
    <section className="character-metadata">
      <div className="character-profile-head">
        <CharacterAvatar project={project} portrait={profile?.portrait} name={character.name} />
        <label className="field">
          <span>{t('characterGenderManual')}</span>
          <select
            aria-label={t('characterGenderManual')}
            value={profile?.gender ?? 'unspecified'}
            disabled={busy}
            onChange={(e) =>
              onEdit((p) =>
                editCharacterProfile(p, character.id, {
                  gender: e.target.value as 'man' | 'woman' | 'other' | 'unspecified',
                }),
              )
            }
          >
            {['unspecified', 'man', 'woman', 'other'].map((value) => (
              <option value={value} key={value}>
                {t(`characterGender.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {register && (
          <span className="character-register" title={t('characterRegisterHint')}>
            {t(
              `characterRegister.${register.medianHz < 160 ? 'low' : register.medianHz > 240 ? 'high' : 'mid'}`,
            )}{' '}
            · {Math.round(register.medianHz)} Hz
          </span>
        )}
      </div>
      {profile?.portrait && !profile.portrait.confirmed && (
        <div className="character-portrait-proposal">
          <small>{t('characterPortraitProposal')}</small>
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              onEdit((p) =>
                editCharacterProfile(p, character.id, {
                  portrait: { ...profile.portrait!, confirmed: true },
                }),
              )
            }
          >
            <Check size={13} />
            {t('characterConfirmPortrait')}
          </button>
        </div>
      )}
      <details>
        <summary>
          <ImagePlus size={14} /> {t('characterPortraitSettings')}
        </summary>
        <label className="field">
          <span>{t('characterPortraitLine')}</span>
          <select
            aria-label={t('characterPortraitLine')}
            value={validLineId}
            onChange={(e) => setLineId(e.target.value)}
          >
            <option value="">{t('characterChooseLine')}</option>
            {project.dialogues
              .filter(
                (l) =>
                  l.characterId === character.id || l.id === selectedId || l.id === validLineId,
              )
              .slice(0, 100)
              .map((l) => (
                <option value={l.id} key={l.id}>
                  {formatTime(l.startMs)}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{t('characterPortraitTime')}</span>
          <input
            aria-label={t('characterPortraitTime')}
            type="number"
            min="0"
            max={(project.media?.durationMs ?? 0) / 1000}
            step="0.001"
            placeholder={t('characterPortraitMidpoint')}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          {t('characterPortraitAuto')}
        </label>
        {!automatic && (
          <div className="character-crop-inputs">
            {(['x', 'y', 'width', 'height'] as const).map((key) => (
              <label key={key}>
                {t(`characterCrop.${key}`)} %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  aria-label={t(`characterCrop.${key}`)}
                  value={crop[key]}
                  onChange={(e) => setCrop({ ...crop, [key]: Number(e.target.value) })}
                />
              </label>
            ))}
          </div>
        )}
        <button
          className="button subtle"
          disabled={
            busy ||
            working ||
            !validLineId ||
            (time !== '' && (!Number.isFinite(Number(time)) || Number(time) < 0))
          }
          onClick={() => {
            setWorking(true);
            void run(() =>
              bridge.captureCharacterPortrait({
                characterId: character.id,
                lineId: validLineId,
                ...(time === '' ? {} : { atMs: Math.round(Number(time) * 1000) }),
                ...(automatic
                  ? {}
                  : {
                      crop: {
                        x: crop.x / 100,
                        y: crop.y / 100,
                        width: crop.width / 100,
                        height: crop.height / 100,
                      },
                    }),
              }),
            )
              .catch((error) => onError(String(error)))
              .finally(() => setWorking(false));
          }}
        >
          <ImagePlus size={14} />
          {t('characterCapturePortrait')}
        </button>
        {profile?.portrait && (
          <button
            className="text-button"
            disabled={busy}
            onClick={() =>
              onEdit((p) => editCharacterProfile(p, character.id, { portrait: undefined }))
            }
          >
            {t('characterRemovePortrait')}
          </button>
        )}
      </details>
    </section>
  );
}

export function CharacterGallery({
  project,
  activeId,
  onActive,
  busy,
  onEdit,
  snapshot,
  applySnapshot,
  onError,
}: {
  project: Project;
  activeId: string;
  onActive: (id: string) => void;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
  snapshot: () => Promise<Project>;
  applySnapshot: (before: Project, after: Project) => Promise<void>;
  onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [keep, setKeep] = useState(''),
    [portraitOwner, setPortraitOwner] = useState(''),
    [referenceIds, setReferenceIds] = useState<string[]>([]),
    [segments, setSegments] = useState<Record<string, { startMs: number; endMs: number }>>({}),
    [working, setWorking] = useState(false),
    [referencePage, setReferencePage] = useState(0);
  const ids = selected.filter((id) => project.characters.some((c) => c.id === id));
  const keeper = ids.includes(keep) ? keep : ids[0];
  const pairs = useMemo(() => similarCharacterPortraits(project), [project]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of project.dialogues)
      if (l.characterId) map.set(l.characterId, (map.get(l.characterId) ?? 0) + 1);
    return map;
  }, [project.dialogues]);
  const groups = useMemo(() => {
    const parent = new Map(project.characters.map((c) => [c.id, c.id]));
    const root = (id: string): string => (parent.get(id) === id ? id : root(parent.get(id)!));
    for (const pair of pairs) parent.set(root(pair.secondId), root(pair.firstId));
    const grouped = new Map<string, Character[]>();
    for (const c of project.characters) {
      const key = root(c.id);
      grouped.set(key, [...(grouped.get(key) ?? []), c]);
    }
    return [...grouped.values()].sort((a, b) => b.length - a.length);
  }, [project.characters, pairs]);
  const references = project.characters
    .filter((c) => ids.includes(c.id))
    .flatMap((c) =>
      c.references.map((r) => ({ character: c, reference: r, key: `${c.id}:${r.id}` })),
    );
  const selectedReferences = references.filter((r) => referenceIds.includes(r.key));
  const total = selectedReferences.reduce(
    (sum, r) =>
      sum + (segments[r.key]?.endMs ?? r.reference.durationMs) - (segments[r.key]?.startMs ?? 0),
    0,
  );
  const invalid = selectedReferences.some((r) => {
    const s = segments[r.key] ?? { startMs: 0, endMs: r.reference.durationMs };
    return (
      !Number.isSafeInteger(s.startMs) ||
      !Number.isSafeInteger(s.endMs) ||
      s.startMs < 0 ||
      s.endMs > r.reference.durationMs ||
      s.endMs - s.startMs < 100
    );
  });
  const renderReference =
    selectedReferences.length > 1 ||
    selectedReferences.some(
      (r) =>
        segments[r.key] &&
        (segments[r.key].startMs !== 0 || segments[r.key].endMs !== r.reference.durationMs),
    );
  const merge = async () => {
    if (ids.length < 2 || !keeper) return;
    setWorking(true);
    try {
      const options = {
        ids,
        keepId: keeper,
        ...(selectedReferences.length === 1
          ? { defaultReferenceId: selectedReferences[0].reference.id }
          : {}),
        ...(ids.includes(portraitOwner) ? { portraitFromId: portraitOwner } : {}),
      };
      if (renderReference) {
        const before = await snapshot();
        const prepared = await bridge.prepareCharacterReference(
          selectedReferences.map((r) => ({
            characterId: r.character.id,
            referenceId: r.reference.id,
            ...(segments[r.key] ?? { startMs: 0, endMs: r.reference.durationMs }),
          })),
          t('characterCombinedReference'),
        );
        await applySnapshot(
          before,
          mergeCharacters(before, { ...options, preparedReference: prepared }),
        );
      } else onEdit((p) => mergeCharacters(p, options));
      onActive(keeper);
      setSelected([]);
      setReferenceIds([]);
    } catch (error) {
      onError(String(error));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="character-gallery-section">
      <label className="field">
        <span>{t('characterSearch')}</span>
        <input
          type="search"
          aria-label={t('characterSearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <small>{t('characterSimilarityHint')}</small>
      <div className="character-gallery" role="list" aria-label={t('characterGallery')}>
        {groups.map((group) => {
          const rows = group.filter((c) =>
            c.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          );
          return (
            rows.length > 0 && (
              <div className="character-visual-group" key={group[0].id}>
                {group.length > 1 && (
                  <small className="character-group-label">
                    {t('characterSimilarThumbnails', { count: group.length })}
                  </small>
                )}
                <div className="character-visual-cards">
                  {rows.map((c) => (
                    <div
                      key={c.id}
                      role="listitem"
                      className={`character-card ${activeId === c.id ? 'active' : ''}`}
                    >
                      <input
                        type="checkbox"
                        aria-label={t('characterSelectMerge', { name: c.name })}
                        checked={ids.includes(c.id)}
                        disabled={busy || working}
                        onChange={(e) => {
                          setSelected(
                            e.target.checked
                              ? [...new Set([...ids, c.id])]
                              : ids.filter((id) => id !== c.id),
                          );
                          setReferencePage(0);
                        }}
                      />
                      <button
                        className="character-card-open"
                        onClick={() => onActive(c.id)}
                        aria-label={t('characterOpen', { name: c.name })}
                      >
                        <CharacterAvatar
                          project={project}
                          portrait={project.characterProfiles?.[c.id]?.portrait}
                          name={c.name}
                        />
                        <strong>{c.name}</strong>
                        <small>
                          {t('characterAssignedCount', { count: counts.get(c.id) ?? 0 })}
                        </small>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          );
        })}
      </div>
      {pairs.length > 0 && (
        <details>
          <summary>{t('characterSimilarProposals', { count: pairs.length })}</summary>
          {pairs.slice(0, 8).map((pair) => (
            <div className="character-similarity-pair" key={`${pair.firstId}:${pair.secondId}`}>
              <span>
                {project.characters.find((c) => c.id === pair.firstId)?.name} ↔{' '}
                {project.characters.find((c) => c.id === pair.secondId)?.name} ·{' '}
                {Math.round(pair.similarity * 100)}%
              </span>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setSelected([pair.firstId, pair.secondId]);
                  setKeep(pair.firstId);
                  setReferenceIds([]);
                  setReferencePage(0);
                }}
              >
                {t('characterCompareMerge')}
              </button>
            </div>
          ))}
        </details>
      )}
      {ids.length >= 2 && (
        <div className="character-merge" role="group" aria-label={t('characterMergeTitle')}>
          <h3>
            <Users size={15} />
            {t('characterMergeCount', { count: ids.length })}
          </h3>
          <label className="field">
            <span>{t('characterKeepProfile')}</span>
            <select
              aria-label={t('characterKeepProfile')}
              value={keeper}
              onChange={(e) => setKeep(e.target.value)}
            >
              {project.characters
                .filter((c) => ids.includes(c.id))
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <p className="panel-description">{t('characterMergeHint')}</p>
          <label className="field">
            <span>{t('characterMergePortrait')}</span>
            <select
              aria-label={t('characterMergePortrait')}
              value={ids.includes(portraitOwner) ? portraitOwner : ''}
              onChange={(e) => setPortraitOwner(e.target.value)}
            >
              <option value="">{t('characterKeepCurrentPortrait')}</option>
              {project.characters
                .filter((c) => ids.includes(c.id) && project.characterProfiles?.[c.id]?.portrait)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="character-merge-references">
            {references.slice(referencePage * 16, referencePage * 16 + 16).map((r) => {
              const range = segments[r.key] ?? { startMs: 0, endMs: r.reference.durationMs };
              return (
                <div key={r.key}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t('characterMergeReference', {
                        name: r.character.name,
                        label: r.reference.label,
                      })}
                      checked={referenceIds.includes(r.key)}
                      onChange={(e) =>
                        setReferenceIds(
                          e.target.checked
                            ? [...referenceIds, r.key]
                            : referenceIds.filter((id) => id !== r.key),
                        )
                      }
                    />
                    {r.character.name} · {r.reference.label} ·{' '}
                    {(r.reference.durationMs / 1000).toFixed(2)} s
                  </label>
                  {referenceIds.includes(r.key) && (
                    <div className="character-reference-trim">
                      {(['startMs', 'endMs'] as const).map((key) => (
                        <label key={key}>
                          {t(key === 'startMs' ? 'characterRefStart' : 'characterRefEnd')}
                          <input
                            type="number"
                            aria-label={`${t(key === 'startMs' ? 'characterRefStart' : 'characterRefEnd')} ${r.reference.id}`}
                            min="0"
                            max={r.reference.durationMs / 1000}
                            step="0.001"
                            value={range[key] / 1000}
                            onChange={(e) =>
                              setSegments({
                                ...segments,
                                [r.key]: {
                                  ...range,
                                  [key]: Math.round(Number(e.target.value) * 1000),
                                },
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  {referenceIds.includes(r.key) && (
                    <ReferenceAudition
                      characterId={r.character.id}
                      referenceId={r.reference.id}
                      startMs={range.startMs}
                      endMs={range.endMs}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {references.length > 16 && (
            <div className="character-pagination">
              <button
                className="text-button"
                disabled={referencePage === 0}
                onClick={() => setReferencePage(referencePage - 1)}
              >
                {t('characterPrevious')}
              </button>
              <button
                className="text-button"
                disabled={(referencePage + 1) * 16 >= references.length}
                onClick={() => setReferencePage(referencePage + 1)}
              >
                {t('characterNext')}
              </button>
            </div>
          )}
          {renderReference && (
            <p className={invalid || total < 1000 || total > 20000 ? 'warning' : ''}>
              {t('characterCombinedDuration', { seconds: (total / 1000).toFixed(2) })}
            </p>
          )}
          <button
            className="button accent"
            disabled={
              busy ||
              working ||
              invalid ||
              selectedReferences.length > 16 ||
              (renderReference && (total < 1000 || total > 20000))
            }
            onClick={() => void merge()}
          >
            {t(renderReference ? 'characterMergeAndCombine' : 'characterMergeAction')}
          </button>
        </div>
      )}
    </section>
  );
}
function ReferenceAudition({
  characterId,
  referenceId,
  startMs,
  endMs,
}: {
  characterId: string;
  referenceId: string;
  startMs: number;
  endMs: number;
}) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let disposed = false;
    void bridge
      .voiceReferenceUrl(characterId, referenceId)
      .then((value) => {
        if (!disposed) setUrl(value);
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [characterId, referenceId]);
  return (
    <audio
      controls
      preload="none"
      src={url || undefined}
      onPlay={(e) => {
        const audio = e.currentTarget;
        if (audio.currentTime < startMs / 1000 || audio.currentTime >= endMs / 1000)
          audio.currentTime = startMs / 1000;
      }}
      onTimeUpdate={(e) => {
        if (e.currentTarget.currentTime >= endMs / 1000) e.currentTarget.pause();
      }}
    />
  );
}
