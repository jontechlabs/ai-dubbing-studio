import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { native } from '../services/bridge';
interface Status {
  enabled: boolean;
  ready: boolean;
  port: number | null;
  pending: number;
  configuration: Record<string, unknown>;
  configurationToml: string;
  audit: { id: string; tool: string; status: string }[];
}
export function McpSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState(false);
  const [format, setFormat] = useState('json');
  const configuration = status
    ? format === 'codex'
      ? status.configurationToml
      : JSON.stringify(status.configuration, null, 2)
    : '';
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const refresh = () =>
      void invoke<Status>('mcp_status')
        .then((value) => {
          if (!disposed) setStatus(value);
        })
        .catch((error) => {
          if (!disposed) setError(String(error));
        });
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, []);
  if (!native) return null;
  return (
    <section className="settings-section" aria-label={t('mcpTitle')}>
      <h3>{t('mcpTitle')}</h3>
      <p className="panel-description">{t('mcpDescription')}</p>
      <label className="mcp-toggle">
        <input
          type="checkbox"
          disabled={!status || working}
          checked={status?.enabled ?? false}
          onChange={(event) => {
            setWorking(true);
            setError('');
            void invoke<Status>('mcp_set_enabled', { enabled: event.target.checked })
              .then(setStatus)
              .catch((error) => setError(String(error)))
              .finally(() => setWorking(false));
          }}
        />
        {t('mcpEnable')}
      </label>
      <p role="status">
        {t(status?.enabled ? 'mcpEnabled' : 'mcpDisabled')}
        {status?.enabled &&
          ` · 127.0.0.1:${status.port} · ${t('mcpPending', { count: status.pending })}`}
      </p>
      {status?.enabled && (
        <>
          <label className="field">
            <span>{t('mcpFormat')}</span>
            <select
              value={format}
              onChange={(event) => {
                setFormat(event.target.value);
                setCopied(false);
              }}
            >
              <option value="json">JSON</option>
              <option value="codex">Codex · TOML</option>
            </select>
          </label>
          <label className="field">
            <span>{t(format === 'codex' ? 'mcpCodexConfiguration' : 'mcpConfiguration')}</span>
            <textarea
              readOnly
              aria-label={t(format === 'codex' ? 'mcpCodexConfiguration' : 'mcpConfiguration')}
              rows={7}
              value={configuration}
            />
          </label>
          <button
            className="button subtle"
            onClick={() => {
              void navigator.clipboard
                .writeText(configuration)
                .then(() => setCopied(true))
                .catch((error) => setError(String(error)));
            }}
          >
            {t(copied ? 'copied' : 'mcpCopyConfiguration')}
          </button>
          <p className="panel-description">{t('mcpConfigurationHint')}</p>
          <h4>{t('mcpRecent')}</h4>
          {!status.audit.length ? (
            <p>{t('mcpNoCommands')}</p>
          ) : (
            <ol className="mcp-audit">
              {status.audit.slice(0, 10).map((row) => (
                <li key={row.id}>
                  <code>{row.tool}</code>
                  <span>{t(`mcpCommandStatus.${row.status}`)}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
      {error && (
        <p role="alert">
          {t('mcpError')} {error}
        </p>
      )}
    </section>
  );
}
