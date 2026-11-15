import { Clock3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ownGenerationTiming } from '../domain/generationTiming';
import { formatJobDuration } from '../domain/jobTiming';

export function TakeDuration({
  generation,
}: {
  generation: { id: string; generationTiming?: unknown };
}) {
  const { t } = useTranslation();
  const timing = ownGenerationTiming(generation);
  return (
    <small
      className="take-duration"
      title={t(timing ? 'generationTiming.savedHint' : 'generationTiming.unknownHint')}
    >
      <Clock3 size={12} aria-hidden="true" />
      {timing
        ? t('generationTiming.saved', { time: formatJobDuration(timing.elapsedMs) })
        : t('generationTiming.unknown')}
    </small>
  );
}
