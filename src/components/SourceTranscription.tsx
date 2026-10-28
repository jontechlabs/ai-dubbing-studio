import { useEffect, useRef, useState } from 'react';
import { FileText, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Dialogue, Job, Project } from '../domain/types';
import { audioTracks, trackLabel } from '../domain/audio';
import { formatTime } from '../domain/time';
import {
  sourceProposalCurrent,
  type SourceTranscriptionProposal,
} from '../domain/sourceTranscription';
import * as bridge from '../services/bridge';
import { JobDuration } from './JobDuration';

export function SourceTranscription({
  project,
  line,
  jobs,
  snapshot,
  run,
  busy,
}: {
  project: Project;
  line: Dialogue;
  jobs: Job[];
  snapshot: () => Promise<Project>;
  run: (operation: () => Promise<Project | null>) => Promise<void>;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation();
  const requestSerial = useRef(0);
  const [open, setOpen] = useState(false),
    [key, setKey] = useState<string | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState(
    ['ja', 'fr', 'en', 'zh', 'ko', 'de', 'es', 'it', 'ru'].includes(project.languages.source)
      ? project.languages.source
      : 'auto',
  );
  const [track, setTrack] = useState('auto'),
    [proposal, setProposal] = useState<SourceTranscriptionProposal | null>(null),
    [applied, setApplied] = useState(false);
  const job = jobs.find((j) => j.id === key),
    active = !!job && ['queued', 'running', 'paused'].includes(job.status),
    otherActive = jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status));
  const locked = busy || working || otherActive;
  useEffect(() => {
    if (!open || !bridge.native) return;
    const serial = requestSerial.current;
    let disposed = false;
    void bridge
      .latestSourceTranscription(line.id)
      .then((id) => {
        if (!disposed && serial === requestSerial.current && id) setKey(id);
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [open, line.id]);
  useEffect(() => {
    if (!key || job?.status !== 'succeeded') return;
    let disposed = false;
    void bridge
      .sourceTranscriptionResult(key)
      .then((result) => {
        if (!disposed && result)
          setProposal((previous) =>
            previous?.id === result.id ? { ...previous, stale: result.stale } : result,
          );
      })
      .catch((e) => {
        if (!disposed) setError(String(e));
      });
    return () => {
      disposed = true;
    };
  }, [key, job?.status, project.revision]);
  const current = proposal && sourceProposalCurrent(project, proposal);
  const changed = proposal?.segments.some(
    (s, i) => s.text.trim() !== proposal.basis.slots[i]?.text,
  );
  const message = error ?? job?.error;
  return (
    <details
      className="source-transcription"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <FileText size={14} />
        {t('sourceAsr.title')}
      </summary>
      {open && (
        <div>
          <p className="panel-description">{t('sourceAsr.hint')}</p>
          <div className="source-asr-options">
            <label className="field">
              <span>{t('sourceAsr.language')}</span>
              <select
                aria-label={t('sourceAsr.language')}
                value={language}
                disabled={locked}
                onChange={(e) => setLanguage(e.target.value)}
              >
                <option value="auto">{t('asrLanguageAuto')}</option>
                {['ja', 'fr', 'en', 'zh', 'ko', 'de', 'es', 'it', 'ru'].map((code) => (
                  <option key={code} value={code}>
                    {new Intl.DisplayNames([i18n.resolvedLanguage ?? 'fr'], {
                      type: 'language',
                    }).of(code)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t('sourceAsr.track')}</span>
              <select
                aria-label={t('sourceAsr.track')}
                value={track}
                disabled={locked}
                onChange={(e) => setTrack(e.target.value)}
              >
                <option value="auto">{t('referenceTrackProject')}</option>
                {audioTracks(project)
                  .filter((t) => t.kind !== 'dubbing')
                  .map((track) => (
                    <option key={track.id} value={track.id}>
                      {t(trackLabel(track))}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <button
            className="button subtle wide"
            disabled={!bridge.native || locked || !project.media}
            onClick={() => {
              requestSerial.current++;
              setWorking(true);
              setError(null);
              setProposal(null);
              setApplied(false);
              void snapshot()
                .then(() =>
                  bridge.transcribeDialogueSource({ lineId: line.id, language, trackId: track }),
                )
                .then(setKey)
                .catch((e) => setError(String(e)))
                .finally(() => setWorking(false));
            }}
          >
            <FileText size={14} />
            {t('sourceAsr.start')}
          </button>
          <p className="panel-description">{t('sourceAsr.modelHint')}</p>
          {(active || working) && (
            <p role="status">
              <LoaderCircle className="spin" size={14} />
              {t(job ? `jobStages.${job.stage}` : 'llmChecking', {
                defaultValue: t('llmChecking'),
              })}{' '}
              {active && (
                <button
                  className="text-button"
                  onClick={() => void bridge.cancelJob(key!).catch((e) => setError(String(e)))}
                >
                  {t('cancel')}
                </button>
              )}
            </p>
          )}
          {job && <JobDuration job={job} />}
          {job?.status === 'cancelled' && <p role="status">{t('jobCancelled')}</p>}
          {message && (
            <p role="alert" className="warning">
              {t(
                `errors.${message
                  .replace(/^Error:\s*/, '')
                  .split(':')[0]
                  .trim()}`,
                { defaultValue: message },
              )}
            </p>
          )}
          {proposal && !applied && (
            <div className="source-asr-proposal">
              {proposal.segments.map((segment, i) => (
                <div key={i}>
                  <small>
                    {formatTime(proposal.basis.slots[i].startMs)} →{' '}
                    {formatTime(proposal.basis.slots[i].endMs)}
                  </small>
                  <p className="source-asr-original">
                    <strong>{t('original')}</strong>{' '}
                    {proposal.basis.slots[i].text || t('sourceAsr.absent')}
                  </p>
                  {segment.noSpeech && <p className="warning">{t('sourceAsr.noSpeech')}</p>}
                  <label className="field">
                    <span>{t('sourceAsr.proposal', { number: i + 1 })}</span>
                    <textarea
                      aria-label={t('sourceAsr.proposal', { number: i + 1 })}
                      value={segment.text}
                      rows={3}
                      maxLength={10000}
                      disabled={busy || working}
                      onChange={(e) =>
                        setProposal({
                          ...proposal,
                          segments: proposal.segments.map((s, n) =>
                            n === i ? { ...s, text: e.target.value } : s,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              ))}
              {!current && (
                <p className="warning" role="alert">
                  {t('sourceAsr.stale')}
                </p>
              )}
              <p className="panel-description">{t('sourceAsr.applyHint')}</p>
              <button
                className="button accent"
                disabled={
                  locked || !current || !changed || proposal.segments.some((s) => !s.text.trim())
                }
                onClick={() => {
                  setWorking(true);
                  setError(null);
                  void run(async () => {
                    try {
                      const saved = await bridge.applySourceTranscription(
                        proposal.id,
                        proposal.segments.map((s) => s.text.trim()),
                      );
                      setApplied(true);
                      return saved;
                    } catch (e) {
                      setError(String(e));
                      throw e;
                    }
                  }).finally(() => setWorking(false));
                }}
              >
                {t('sourceAsr.apply')}
              </button>
              <button className="text-button" disabled={working} onClick={() => setProposal(null)}>
                {t('llmDiscard')}
              </button>
            </div>
          )}
          {applied && <p role="status">{t('sourceAsr.applied')}</p>}
        </div>
      )}
    </details>
  );
}
