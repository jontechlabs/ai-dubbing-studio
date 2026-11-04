import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../components/Modal';
import type { Project } from '../domain/types';
import { approveTranslation, translationState } from '../domain/translation';
import { reviewGeneration } from '../domain/tts';
import { sameReview } from '../domain/jointReview';
import { changedReviewTakes, reviewDecisionSnapshot } from '../domain/reviewChanges';

export function useTakeReview(
  project: Project | null,
  onEdit: (update: (p: Project) => Project) => void,
  busy: boolean,
) {
  const { t } = useTranslation();
  const [pending, setPending] = useState<{
    id: string;
    kind: 'translation' | 'take';
    snapshot: ReturnType<typeof reviewDecisionSnapshot>;
    takes: ReturnType<typeof changedReviewTakes>;
  } | null>(null);
  const request = (id: string, approved: boolean, kind: 'translation' | 'take' = 'translation') => {
    if (!project || busy) return;
    const line = project.dialogues.find((l) => l.id === id);
    if (!line || (approved && translationState(project, line) === 'approved')) return;
    const takes = approved ? changedReviewTakes(project, line) : [];
    if (takes.length) {
      setPending({
        id,
        kind,
        snapshot: structuredClone(reviewDecisionSnapshot(project, id)),
        takes,
      });
      return;
    }
    onEdit((p) =>
      kind === 'take' ? reviewGeneration(p, id, approved) : approveTranslation(p, id, approved),
    );
  };
  const changed =
    !!pending && !sameReview(pending.snapshot, reviewDecisionSnapshot(project, pending.id));
  const dialog = pending && (
    <Modal title={t('reviewChanged.title')} onClose={() => setPending(null)}>
      <p>{t('reviewChanged.explain')}</p>
      {pending.takes.map((take, index) => (
        <section className="review-changed-take" key={take.id}>
          {pending.takes.length > 1 && <h3>{t('reviewChanged.voice', { number: index + 1 })}</h3>}
          <ul>
            {take.reasons.map((reason) => (
              <li key={reason}>{t(`reviewChanged.reasons.${reason}`)}</li>
            ))}
          </ul>
          {take.generatedText !== take.currentText && (
            <>
              <label className="field">
                {t('reviewChanged.generated')}
                <textarea readOnly value={take.generatedText} />
              </label>
              <label className="field">
                {t('reviewChanged.current')}
                <textarea readOnly value={take.currentText} />
              </label>
            </>
          )}
        </section>
      ))}
      <p className="muted">{t('reviewChanged.keep')}</p>
      {changed && <p role="alert">{t('reviewChanged.changed')}</p>}
      <div className="dialogue-manage-actions">
        <button className="button subtle" onClick={() => setPending(null)}>
          {t('cancel')}
        </button>
        <button
          className="button accent"
          disabled={busy || changed}
          onClick={() => {
            onEdit((p) => {
              if (!sameReview(pending.snapshot, reviewDecisionSnapshot(p, pending.id)))
                throw Error('REVIEW_CHANGED');
              return pending.kind === 'take'
                ? reviewGeneration(p, pending.id, true, true)
                : approveTranslation(p, pending.id, true, true);
            });
            setPending(null);
          }}
        >
          {t('reviewChanged.accept')}
        </button>
      </div>
    </Modal>
  );
  return { request, dialog };
}
