import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal';
import { formatTime, parseTime } from '../domain/time';
import type { NewDialogueOptions } from '../domain/dialogueEditing';
export type DialogueAction =
  { kind: 'add'; startMs: number; endMs: number } | { kind: 'delete'; ids: string[] };
export function DialogueManageModal({
  action,
  onClose,
  onAdd,
  onDelete,
  busy,
}: {
  action: DialogueAction;
  onClose: () => void;
  onAdd: (options: NewDialogueOptions) => void;
  onDelete: (ids: string[]) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [start, setStart] = useState(action.kind === 'add' ? formatTime(action.startMs) : '');
  const [end, setEnd] = useState(action.kind === 'add' ? formatTime(action.endMs) : '');
  const [sourceText, setSource] = useState(''),
    [targetText, setTarget] = useState(''),
    [error, setError] = useState('');
  return (
    <Modal
      title={t(action.kind === 'add' ? 'dialogueAdd' : 'dialogueDeleteTitle')}
      onClose={onClose}
    >
      {action.kind === 'delete' ? (
        <>
          <p>{t('dialogueDeleteConfirm', { count: action.ids.length })}</p>
          <p className="muted">{t('dialogueDeleteKeep')}</p>
          <div className="dialogue-manage-actions">
            <button className="button subtle" onClick={onClose}>
              {t('cancel')}
            </button>
            <button className="button danger" disabled={busy} onClick={() => onDelete(action.ids)}>
              {t('dialogueDeleteTitle')}
            </button>
          </div>
        </>
      ) : (
        <form
          className="dialogue-manage-form"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              onAdd({ startMs: parseTime(start), endMs: parseTime(end), sourceText, targetText });
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          <div className="dialogue-manage-times">
            <label>
              {t('dialogueStart')}
              <input
                autoFocus
                aria-label={t('dialogueStart')}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              {t('dialogueEnd')}
              <input
                aria-label={t('dialogueEnd')}
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
          <label>
            {t('original')}
            <textarea
              aria-label={t('dialogueSource')}
              value={sourceText}
              onChange={(e) => setSource(e.target.value)}
            />
          </label>
          <label>
            {t('translated')}
            <textarea
              aria-label={t('dialogueTarget')}
              value={targetText}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          <p className="muted">{t('dialogueAddHint')}</p>
          {error && <p role="alert">{error}</p>}
          <div className="dialogue-manage-actions">
            <button type="button" className="button subtle" onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              className="button accent"
              disabled={busy || (!sourceText.trim() && !targetText.trim())}
            >
              {t('dialogueAdd')}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
