import { expect, it } from 'vitest';
import { takeCreatedAt } from './takeDate';
it('shows the stored instant with date, hours, minutes and seconds in the local time zone', () => {
  const stamp = '2026-11-04T10:15:16Z';
  expect(takeCreatedAt(stamp, 'fr', 'Indian/Reunion')?.text).toMatch(/04\/11\/2026.*14:15:16/);
  expect(takeCreatedAt(stamp, 'en', 'UTC')?.text).toMatch(/04\/11\/2026.*10:15:16/);
  expect(takeCreatedAt(stamp, 'fr', 'Indian/Reunion')?.title).toMatch(/GMT\+4|UTC\+4/);
});
it('never fabricates a current timestamp for legacy or invalid creation dates', () => {
  for (const bad of ['', 'unknown', '2026-99-99T99:99:99Z'])
    expect(takeCreatedAt(bad, 'fr', 'UTC')).toBeNull();
});
