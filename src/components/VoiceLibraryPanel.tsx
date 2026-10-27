import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Play, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Character, Project, VoiceSettings } from '../domain/types';
import {
  editLibrarySample,
  frenchVoicePhrases,
  libraryOf,
  type VoiceLibraryPhrase,
  type VoiceLibrarySegment,
} from '../domain/voiceLibrary';
import { defaultVoiceSettings } from '../domain/tts';
import { audioTracks, trackLabel } from '../domain/audio';
import { dialogueText } from '../domain/subtitles';
import { formatTime } from '../domain/time';
import { voiceMoods } from '../domain/voiceMoods';
import { VoiceQualityControls } from './VoiceQualityControls';
import * as bridge from '../services/bridge';

export function VoiceLibraryPanel({
  project,
  character,
  busy,
  onEdit,
  run,
  snapshot,
  onStarted,
  onModels,
  onError,
}: {
  project: Project;
  character: Character;
  busy: boolean;
  onEdit: (update: (p: Project) => Project) => void;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  snapshot: () => Promise<Project>;
  onStarted: () => void;
  onModels: () => void;
  onError: (error: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false),
    [working, setWorking] = useState(false),
    [status, setStatus] = useState<bridge.VoiceStatus | null>(null);
  const [segments, setSegments] = useState<VoiceLibrarySegment[]>([]),
    [pick, setPick] = useState(''),
    [search, setSearch] = useState('');
  const [label, setLabel] = useState(t('library.sourceDefault')),
    [sourceId, setSourceId] = useState('');
  const [phrases, setPhrases] = useState<VoiceLibraryPhrase[]>(() =>
    frenchVoicePhrases.map((p) => ({ ...p, id: crypto.randomUUID() })),
  );
  const [enabled, setEnabled] = useState<string[]>(() => [phrases[0].id]);
  const [settings, setSettings] = useState<VoiceSettings>({
    ...defaultVoiceSettings,
    variantId: 'voxcpm2-bf16',
    accent: 'fr-FR',
    referenceMode: 'character',
    mode: 'crossLingual',
  });
  const [filter, setFilter] = useState('all'),
    [page, setPage] = useState(0),
    [url, setUrl] = useState('');
  const player = useRef<HTMLAudioElement>(null),
    serial = useRef(0);
  const library = libraryOf(project, character.id),
    sources = library?.sources ?? [];
  const selectedSource = sources.find((s) => s.id === sourceId) ?? sources.at(-1);
  const invalidSegments = segments.some((s) => {
    const r = character.references.find((r) => r.id === s.referenceId),
      line = project.dialogues.find((l) => l.id === s.dialogueId);
    return (
      !Number.isSafeInteger(s.startMs) ||
      !Number.isSafeInteger(s.endMs) ||
      s.endMs - s.startMs < 100 ||
      (r
        ? s.startMs < 0 || s.endMs > r.durationMs
        : !line || s.startMs < line.startMs || s.endMs > line.endMs)
    );
  });
  const locked = busy || working,
    total = segments.reduce((n, s) => n + s.endMs - s.startMs, 0);
  const samples = [...(library?.samples ?? [])]
    .reverse()
    .filter((s) => filter === 'all' || s.status === filter);
  const index = Math.min(page, Math.max(0, Math.ceil(samples.length / 8) - 1));
  const ready = status?.variants.some((v) => v.id === 'voxcpm2-bf16' && v.installed);
  useEffect(() => {
    if (!open || !bridge.native) return;
    let disposed = false;
    void bridge
      .voiceStatus(true)
      .then((s) => {
        if (!disposed) setStatus(s);
      })
      .catch((e) => onError(String(e)));
    return () => {
      disposed = true;
    };
  }, [open, onError]);
  useEffect(() => {
    if (url) void player.current?.play().catch((e) => onError(String(e)));
  }, [url, onError]);
  useEffect(
    () => () => {
      serial.current++;
      player.current?.pause();
    },
    [],
  );
  const audition = async (id: string) => {
    const request = ++serial.current;
    try {
      const audio = await bridge.voiceLibraryAudioUrl(character.id, id);
      if (request === serial.current) {
        if (audio === url && player.current) {
          player.current.currentTime = 0;
          await player.current.play();
        } else setUrl(audio);
      }
    } catch (error) {
      onError(String(error));
    }
  };
  const candidates = useMemo(
    () =>
      project.dialogues
        .filter((l) => l.characterId === character.id)
        .map((line) => ({
          line,
          text: dialogueText(project, line, 'source'),
          translation: dialogueText(project, line, 'target'),
        }))
        .filter(
          ({ line, text, translation }) =>
            !search ||
            `${formatTime(line.startMs)} ${text} ${translation}`
              .toLocaleLowerCase()
              .includes(search.toLocaleLowerCase()),
        )
        .slice(0, 100),
    [project, character.id, search],
  );
  const phraseEdit = (id: string, change: Partial<VoiceLibraryPhrase>) =>
    setPhrases((rows) => rows.map((p) => (p.id === id ? { ...p, ...change } : p)));
  return (
    <details
      className="voice-library settings-section"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{t('library.title')}</summary>
      {open && (
        <>
          <p className="panel-description">{t('library.hint')}</p>
          <h4>{t('library.sources')}</h4>
          <input
            aria-label={t('library.search')}
            placeholder={t('library.search')}
            value={search}
            disabled={locked}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="library-source-pick">
            <select
              aria-label={t('library.excerpt')}
              value={pick}
              disabled={locked}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">{t('library.chooseExcerpt')}</option>
              <optgroup label={t('library.existingReferences')}>
                {character.references.map((r) => (
                  <option key={r.id} value={`reference:${r.id}`}>
                    {r.label} · {(r.durationMs / 1000).toFixed(1)} s
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('library.assignedDialogues')}>
                {candidates.map(({ line: l, text }) => (
                  <option key={l.id} value={`dialogue:${l.id}`}>
                    {formatTime(l.startMs)} · {text.slice(0, 60)}
                  </option>
                ))}
              </optgroup>
            </select>
            <button
              className="button subtle"
              disabled={locked || !pick || segments.length >= 16}
              onClick={() => {
                const [kind, id] = pick.split(':');
                const line = project.dialogues.find((l) => l.id === id),
                  ref = character.references.find((r) => r.id === id);
                if (kind === 'dialogue' && line)
                  setSegments((rows) => [
                    ...rows,
                    {
                      referenceId: null,
                      dialogueId: id,
                      startMs: line.startMs,
                      endMs: Math.min(line.endMs, line.startMs + 20000),
                      trackId: 'auto',
                    },
                  ]);
                if (kind === 'reference' && ref)
                  setSegments((rows) => [
                    ...rows,
                    { referenceId: id, dialogueId: null, startMs: 0, endMs: ref.durationMs },
                  ]);
              }}
            >
              <Plus size={13} />
              {t('library.addExcerpt')}
            </button>
          </div>
          {segments.map((s, i) => (
            <div className="library-segment" key={i}>
              <span>
                {s.referenceId
                  ? character.references.find((r) => r.id === s.referenceId)?.label
                  : formatTime(project.dialogues.find((l) => l.id === s.dialogueId)?.startMs ?? 0)}
              </span>
              <label>
                {t('library.startSeconds')}
                <input
                  type="number"
                  step=".1"
                  min="0"
                  aria-label={`${t('library.startSeconds')} ${i + 1}`}
                  value={s.startMs / 1000}
                  disabled={locked}
                  onChange={(e) =>
                    setSegments((rows) =>
                      rows.map((r, n) =>
                        n === i ? { ...r, startMs: Math.round(Number(e.target.value) * 1000) } : r,
                      ),
                    )
                  }
                />
              </label>
              <label>
                {t('library.endSeconds')}
                <input
                  type="number"
                  step=".1"
                  min="0"
                  aria-label={`${t('library.endSeconds')} ${i + 1}`}
                  value={s.endMs / 1000}
                  disabled={locked}
                  onChange={(e) =>
                    setSegments((rows) =>
                      rows.map((r, n) =>
                        n === i ? { ...r, endMs: Math.round(Number(e.target.value) * 1000) } : r,
                      ),
                    )
                  }
                />
              </label>
              {s.dialogueId && (
                <select
                  aria-label={`${t('referenceTrack')} ${i + 1}`}
                  disabled={locked}
                  value={s.trackId ?? 'auto'}
                  onChange={(e) =>
                    setSegments((rows) =>
                      rows.map((r, n) => (n === i ? { ...r, trackId: e.target.value } : r)),
                    )
                  }
                >
                  <option value="auto">{t('referenceTrackDefault')}</option>
                  {audioTracks(project)
                    .filter((r) => r.kind !== 'dubbing')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {t(trackLabel(r))}
                      </option>
                    ))}
                </select>
              )}
              <button
                className="icon-button"
                aria-label={`${t('library.removeExcerpt')} ${i + 1}`}
                disabled={locked}
                onClick={() => setSegments((rows) => rows.filter((_, n) => n !== i))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <label className="field">
            <span>{t('library.sourceLabel')}</span>
            <input value={label} disabled={locked} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <small className={total < 5000 || total > 20000 ? 'warning' : 'panel-description'}>
            {t('library.sourceDuration', { seconds: (total / 1000).toFixed(2) })}
          </small>
          <button
            className="button subtle wide"
            disabled={
              !bridge.native ||
              locked ||
              !label.trim() ||
              total < 5000 ||
              total > 20000 ||
              invalidSegments
            }
            onClick={() => {
              setWorking(true);
              void run(async () => {
                const result = await bridge.prepareVoiceLibrarySource({
                  characterId: character.id,
                  label,
                  segments,
                });
                setSourceId(libraryOf(result, character.id)!.sources.at(-1)!.id);
                setSegments([]);
                return result;
              }).finally(() => setWorking(false));
            }}
          >
            {t('library.prepareSource')}
          </button>
          <h4>{t('library.frenchPhrases')}</h4>
          <label className="field">
            <span>{t('library.sourceToUse')}</span>
            <select
              value={selectedSource?.id ?? ''}
              disabled={locked}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="" disabled>
                {t('library.noSource')}
              </option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.reference.label} · {(s.reference.durationMs / 1000).toFixed(1)} s
                </option>
              ))}
            </select>
          </label>
          {selectedSource && (
            <button className="text-button" onClick={() => void audition(selectedSource.id)}>
              <Play size={13} />
              {t('library.listenSource')}
            </button>
          )}
          <audio
            ref={player}
            controls
            src={url || undefined}
            aria-label={t('library.player')}
            preload="none"
          />
          <p className="panel-description">{t('library.phraseHint')}</p>
          <div className="library-actions">
            <button
              className="text-button"
              disabled={locked}
              onClick={() => setEnabled(phrases.map((p) => p.id))}
            >
              {t('library.checkAll')}
            </button>
            <button className="text-button" disabled={locked} onClick={() => setEnabled([])}>
              {t('library.checkNone')}
            </button>
          </div>
          {phrases.map((p) => (
            <details className="library-phrase" key={p.id}>
              <summary>
                <label onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={enabled.includes(p.id)}
                    disabled={locked}
                    onChange={(e) =>
                      setEnabled((ids) =>
                        e.target.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.label}
                </label>
              </summary>
              <label className="field">
                <span>{t('library.phraseLabel')}</span>
                <input
                  value={p.label}
                  disabled={locked}
                  onChange={(e) => phraseEdit(p.id, { label: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('library.phraseText')}</span>
                <textarea
                  value={p.text}
                  maxLength={500}
                  disabled={locked}
                  onChange={(e) => phraseEdit(p.id, { text: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('ttsMood')}</span>
                <select
                  disabled={locked}
                  value={p.mood}
                  onChange={(e) => phraseEdit(p.id, { mood: e.target.value as typeof p.mood })}
                >
                  {voiceMoods.map((m) => (
                    <option key={m} value={m}>
                      {t(`moods.${m}`)}
                    </option>
                  ))}
                </select>
              </label>
            </details>
          ))}
          <button
            className="text-button"
            disabled={locked || phrases.length >= 12}
            onClick={() => {
              const id = crypto.randomUUID();
              setPhrases((rows) => [
                ...rows,
                { id, label: t('library.customPhrase'), text: '', mood: 'default' },
              ]);
              setEnabled((ids) => [...ids, id]);
            }}
          >
            <Plus size={13} />
            {t('library.addPhrase')}
          </button>
          <details>
            <summary>{t('library.generationSettings')}</summary>
            <label className="field">
              <span>{t('ttsDevice')}</span>
              <select
                disabled={locked}
                value={settings.device}
                onChange={(e) => setSettings((s) => ({ ...s, device: e.target.value }))}
              >
                <option value="auto">{t('ttsDeviceAuto')}</option>
                <option value="cpu">CPU</option>
                {status?.cudaDevices
                  .filter((d) => d.id.startsWith('cuda:'))
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span>{t('ttsAccent')}</span>
              <select
                disabled={locked}
                value={settings.accent}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, accent: e.target.value as VoiceSettings['accent'] }))
                }
              >
                {['auto', 'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'].map((a) => (
                  <option key={a} value={a}>
                    {a === 'auto' ? t('accents.auto') : a}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('ttsSeed')}</span>
              <input
                type="number"
                min="0"
                max="4294967295"
                disabled={locked}
                value={settings.seed}
                onChange={(e) =>
                  setSettings((s) => ({
                    ...s,
                    seed: Math.min(
                      4294967295,
                      Math.max(0, Math.round(Number(e.target.value) || 0)),
                    ),
                  }))
                }
              />
            </label>
            <VoiceQualityControls
              variant="voxcpm2-bf16"
              value={settings.quality}
              disabled={locked}
              onChange={(quality) => setSettings((s) => ({ ...s, quality }))}
            />
          </details>
          {!ready && (
            <button className="text-button" onClick={onModels}>
              {t('library.installVox')}
            </button>
          )}
          <button
            className="button accent wide"
            disabled={
              !bridge.native ||
              locked ||
              !ready ||
              !selectedSource ||
              !enabled.length ||
              phrases
                .filter((p) => enabled.includes(p.id))
                .some((p) => !p.text.trim() || !p.label.trim())
            }
            onClick={() => {
              setWorking(true);
              void snapshot()
                .then(() =>
                  bridge.generateVoiceLibrary({
                    characterId: character.id,
                    sourceId: selectedSource!.id,
                    phrases: phrases.filter((p) => enabled.includes(p.id)),
                    options: settings,
                  }),
                )
                .then(onStarted)
                .catch((e) => onError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            {t('library.generate', { count: enabled.length })}
          </button>
          <p className="panel-description">{t('library.preserveHint')}</p>
          <h4>{t('library.generated', { count: library?.samples.length ?? 0 })}</h4>
          <label className="field">
            <span>{t('library.filter')}</span>
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              {['all', 'pending', 'approved', 'rejected'].map((s) => (
                <option key={s} value={s}>
                  {t(`library.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          {samples.slice(index * 8, index * 8 + 8).map((sample) => (
            <div className="library-sample" data-status={sample.status} key={sample.id}>
              <strong>{sample.reference.label}</strong>
              <small>
                {t(`library.status.${sample.status}`)} ·{' '}
                {(sample.reference.durationMs / 1000).toFixed(1)} s · {sample.deviceName}
              </small>
              <p>{sample.text}</p>
              <button className="text-button" onClick={() => void audition(sample.id)}>
                <Play size={13} />
                {t('library.listenPhrase')}
              </button>
              <label className="field">
                <span>{t('library.actualTranscript')}</span>
                <textarea
                  value={sample.reference.transcript}
                  disabled={locked}
                  onChange={(e) =>
                    onEdit((p) =>
                      editLibrarySample(p, character.id, sample.id, { transcript: e.target.value }),
                    )
                  }
                />
              </label>
              <div className="library-actions">
                <button
                  className="button subtle"
                  disabled={
                    locked || !sample.reference.transcript.trim() || sample.status === 'approved'
                  }
                  onClick={() =>
                    onEdit((p) =>
                      editLibrarySample(p, character.id, sample.id, { status: 'approved' }),
                    )
                  }
                >
                  <Check size={13} />
                  {t('library.approve')}
                </button>
                <button
                  className="text-button"
                  disabled={locked || sample.status === 'pending'}
                  onClick={() =>
                    onEdit((p) =>
                      editLibrarySample(p, character.id, sample.id, { status: 'pending' }),
                    )
                  }
                >
                  {t('library.withdraw')}
                </button>
                <button
                  className="text-button"
                  disabled={locked || sample.status === 'rejected'}
                  onClick={() =>
                    onEdit((p) =>
                      editLibrarySample(p, character.id, sample.id, { status: 'rejected' }),
                    )
                  }
                >
                  {t('library.reject')}
                </button>
                <button
                  className="button subtle"
                  disabled={
                    locked || sample.status !== 'approved' || library?.defaultSampleId === sample.id
                  }
                  onClick={() =>
                    onEdit((p) =>
                      editLibrarySample(p, character.id, sample.id, { useDefault: true }),
                    )
                  }
                >
                  {library?.defaultSampleId === sample.id
                    ? t('library.isDefault')
                    : t('library.setDefault')}
                </button>
              </div>
            </div>
          ))}
          {samples.length > 8 && (
            <div className="library-actions">
              <button
                className="text-button"
                disabled={index === 0}
                onClick={() => setPage(index - 1)}
              >
                {t('characterPrevious')}
              </button>
              <span>
                {index + 1}/{Math.ceil(samples.length / 8)}
              </span>
              <button
                className="text-button"
                disabled={(index + 1) * 8 >= samples.length}
                onClick={() => setPage(index + 1)}
              >
                {t('characterNext')}
              </button>
            </div>
          )}
        </>
      )}
    </details>
  );
}
