import { useTranslation } from 'react-i18next';
import { takeCreatedAt } from '../domain/takeDate';
export function TakeDate({ value }: { value: string }) {
  const { t, i18n } = useTranslation();
  const date = takeCreatedAt(value, i18n.resolvedLanguage ?? 'fr');
  return date ? (
    <time className="take-created-at" dateTime={value} title={date.title}>
      {t('takeDate.created', { date: date.text })}
    </time>
  ) : (
    <small>{t('takeDate.unknown')}</small>
  );
}
