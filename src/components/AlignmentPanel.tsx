import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, ScanLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { applyAlignment, type Alignment } from '../domain/alignment';
import { cueBounds, type SubtitleRole } from '../domain/timing';
import type { Project } from '../domain/types';
import { formatTime } from '../domain/time';

export function AlignmentPanel({
  project,
  snapshot,
  applySnapshot,
  busy,
}: {
  project: Project;
  snapshot: () => Promise<Project>;
  applySnapshot: (before: Project, after: Project) => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [reference, setReference] = useState<SubtitleRole>('source');
  const [working, setWorking] = useState(false);
  const [proposal, setProposal] = useState<{ project: Project; alignment: Alignment } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const analyze = async () => {
    setWorking(true);
    setError(null);
    setProposal(null);
    setApplied(false);
    try {
      const before = await snapshot();
      const instance = new Worker(new URL('../workers/alignment.ts', import.meta.url), {
        type: 'module',
      });
      worker.current = instance;
      const alignment = await new Promise<Alignment>((resolve, reject) => {
        instance.onmessage = (event: MessageEvent<{ result?: Alignment; error?: string }>) =>
          event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error));
        instance.onerror = () => reject(new Error('ALIGNMENT_FAILED'));
        instance.postMessage({ project: before, reference });
      });
      instance.terminate();
      worker.current = null;
      setProposal({ project: before, alignment });
    } catch (cause) {
      setError(String(cause).replace(/^Error:\s*/, ''));
    } finally {
      setWorking(false);
    }
  };
  const data = proposal?.alignment;
  const stale =
    proposal &&
    (proposal.project.id !== project.id || proposal.project.revision !== project.revision);
  return (
    <div className="panel-body alignment-panel">
      <p className="panel-description">{t('alignmentHint')}</p>
      <label className="field">
        <span>{t('alignmentReference')}</span>
        <select
          value={reference}
          disabled={working || busy}
          onChange={(event) => {
            setReference(event.target.value as SubtitleRole);
            setProposal(null);
            setApplied(false);
          }}
        >
          <option value="source">{t('original')}</option>
          <option value="target">{t('displayedText')}</option>
        </select>
      </label>
      <button
        className="button accent wide"
        disabled={working || busy || !project.sourceCues.length || !project.targetCues.length}
        onClick={() => void analyze()}
      >
        {working ? <LoaderCircle className="spin" size={16} /> : <ScanLine size={16} />}
        {t('alignmentAnalyze')}
      </button>
      {error && (
        <p className="warning" role="alert">
          {t(`errors.${error}`, { defaultValue: t('errors.ALIGNMENT_FAILED') })}
        </p>
      )}
      {data && proposal && (
        <>
          <div className="alignment-metrics">
            <div>
              <strong>{Math.round(data.coverage * 100)}%</strong>
              <span>{t('alignmentCoverage')}</span>
            </div>
            <div>
              <strong>
                {data.offsetMs > 0 ? '+' : ''}
                {(data.offsetMs / 1000).toFixed(3)} s
              </strong>
              <span>{t('alignmentOffset')}</span>
            </div>
            <div>
              <strong>{((data.rate - 1) * 100).toFixed(3)}%</strong>
              <span>{t('alignmentDrift')}</span>
            </div>
          </div>
          <p>
            {t('alignmentSummary', {
              matches: data.matches.length,
              unmatched: data.unmatched,
              error: data.meanErrorMs,
            })}
          </p>
          {data.ambiguous && (
            <p className="warning" role="alert">
              {t('errors.ALIGNMENT_AMBIGUOUS')}
            </p>
          )}
          <p className="panel-description">{t('alignmentPreviewHint')}</p>
          <div className="alignment-preview">
            {data.matches
              .filter((_, index) => index % Math.max(1, Math.ceil(data.matches.length / 8)) === 0)
              .slice(0, 8)
              .map((match) => {
                const referenceCues = (
                  reference === 'source' ? proposal.project.sourceCues : proposal.project.targetCues
                ).filter((c) => match.referenceIds.includes(c.id));
                const movingCues = (
                  reference === 'source' ? proposal.project.targetCues : proposal.project.sourceCues
                ).filter((c) => match.movingIds.includes(c.id));
                const before = cueBounds(movingCues),
                  after = cueBounds(referenceCues);
                return (
                  <article key={match.referenceIds.join(',')}>
                    <strong>{movingCues.map((c) => c.text).join(' / ')}</strong>
                    <span>
                      {formatTime(before.startMs)} – {formatTime(before.endMs)}
                    </span>
                    <span className="alignment-after">
                      → {formatTime(after.startMs)} – {formatTime(after.endMs)}
                    </span>
                    <small>{referenceCues.map((c) => c.text).join(' / ')}</small>
                  </article>
                );
              })}
          </div>
          {stale && !applied && <p className="warning">{t('errors.STALE_REVISION')}</p>}
          <button
            className="button accent wide"
            disabled={working || busy || data.ambiguous || Boolean(stale) || applied}
            onClick={() => {
              setWorking(true);
              setError(null);
              void applySnapshot(proposal.project, applyAlignment(proposal.project, data))
                .then(() => setApplied(true))
                .catch((cause) => setError(String(cause).replace(/^Error:\s*/, '')))
                .finally(() => setWorking(false));
            }}
          >
            {t(applied ? 'alignmentApplied' : 'alignmentApply')}
          </button>
        </>
      )}
      <p className="panel-description">{t('alignmentLimit')}</p>
    </div>
  );
}
