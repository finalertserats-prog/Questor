import { useState } from 'react';
import { api } from '../api/client';
import { Badge, Banner } from './ui';
import type { EnvPresence } from './connectorGuides';
import { useToast } from './Toast';

export interface RoundProviderOption {
  provider: string;
  label: string;
  configured: boolean;
  env?: EnvPresence[];
}

export interface RoundMeetingStatus {
  provider: string;
  label: string;
  configured: boolean;
  source: 'tenant' | 'deployment';
  deploymentDefault: string;
  options: RoundProviderOption[];
}

/**
 * Which provider creates meeting links for this organisation's human rounds.
 * The credentials are the server's; this only chooses among them.
 */
export function RoundMeetingSetting({ status, onSaved }: { status: RoundMeetingStatus | undefined; onSaved: () => void }) {
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const toast = useToast();

  if (!status) return null;
  const selected = choice || status.provider;
  const option = status.options.find((o) => o.provider === selected);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);
    try {
      await api.put('/admin/policy', { policy: { roundMeetingProvider: selected } });
      toast.show(`New human rounds will use ${option?.label ?? selected}.`);
      setChoice('');
      onSaved();
    } catch (err: unknown) {
      setNotice({ ok: false, text: err instanceof Error ? err.message : 'The setting could not be saved.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} data-testid="round-meeting-setting" style={{ marginTop: 10 }}>
      <p className="small">
        Now: <strong>{status.label}</strong>{' '}
        <Badge kind={status.configured ? 'green' : 'gray'}>{status.configured ? 'ready' : 'not set up'}</Badge>{' '}
        <span className="muted">
          {status.source === 'tenant' ? 'chosen for your organisation' : 'server default (ROUND_MEETING_PROVIDER)'}
        </span>
      </p>
      <label htmlFor="round-meeting-provider">Provider for new human rounds</label>
      <div className="row" style={{ gap: 8 }}>
        <select id="round-meeting-provider" value={selected} onChange={(e) => { setChoice(e.target.value); setNotice(null); }}>
          {status.options.map((o) => (
            <option key={o.provider} value={o.provider}>
              {o.label}{o.provider !== 'manual' && !o.configured ? ' (not set up)' : ''}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={saving || (selected === status.provider && status.source === 'tenant')}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {option && option.provider !== 'manual' && !option.configured && (
        <p className="small muted">
          {option.label} needs every variable in its setup guide below
          {option.env && option.env.some((v) => !v.present)
            ? ` (missing: ${option.env.filter((v) => !v.present).map((v) => v.name).join(', ')})`
            : ''}
          . Until then, recruiters are asked to paste links by hand.
        </p>
      )}
      {notice && !notice.ok && <Banner kind="error">{notice.text}</Banner>}
    </form>
  );
}
