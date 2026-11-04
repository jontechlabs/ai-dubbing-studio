const formatters = new Map<string, { short: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();
export function takeCreatedAt(value: string, language: string, timeZone?: string) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return null;
  const locale = language.startsWith('fr') ? 'fr-FR' : 'en-GB';
  const key = locale + ':' + (timeZone ?? 'local');
  let formats = formatters.get(key);
  if (!formats) {
    if (formatters.size >= 8) formatters.clear();
    formats = {
      short: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'medium', timeZone }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'long', timeZone }),
    };
    formatters.set(key, formats);
  }
  return {
    text: formats.short.format(date),
    title: formats.full.format(date),
  };
}
