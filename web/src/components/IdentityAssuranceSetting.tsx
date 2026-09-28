import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { useToast } from './Toast';
import {
  ASSURANCE_SETTING_NOTE, canSaveLevel, optionLabel, type AssuranceSettingData,
} from './identityAssuranceModel';

/** The level choice for given data: rendered directly in tests. */
export function IdentityAssuranceForm({ data, choice, saving, onChoose, onSave }: {
  data: AssuranceSettingData;
  choice: string;
  saving: boolean;
  onChoose: (id: string) => void;
  onSave: () => void;
}) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="small">Identity assurance level</legend>
        {data.levels.map((option) => (
          <label key={option.id} className="check-row" htmlFor={`assurance-${option.id}`}>
            <input
              id={`assurance-${option.id}`}
              type="radio"
              name="identity-assurance-level"
              value={option.id}
              checked={choice === option.id}
              disabled={!option.available || saving}
              onChange={() => onChoose(option.id)}
            />
            <span>
              <strong>{optionLabel(option, data.level)}</strong>
              <span className="small muted" style={{ display: 'block' }}>{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {canSaveLevel(data, choice) && (
        <button className="btn sm" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      )}
    </form>
  );
}

/**
 * Candidate identity assurance for the organisation. Standard is on for
 * everyone; the higher levels are listed so admins can see what is coming.
 */
export function IdentityAssuranceSetting() {
  const [data, setData] = useState<AssuranceSettingData | null>(null);
  const [choice, setChoice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    api.get<AssuranceSettingData>('/admin/identity-assurance')
      .then((d) => { if (!cancelled) { setData(d); setChoice(d.level); } })
      .catch((err: unknown) => { if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not read the setting.'); });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    if (!data || !canSaveLevel(data, choice)) return;
    setSaving(true);
    setSaveError('');
    try {
      await api.put('/admin/policy', { policy: { identityAssuranceLevel: choice } });
      setData({ ...data, level: choice });
      toast.show('Saved. New interviews use this level.');
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'The setting could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" data-testid="identity-assurance-setting">
      <h2>Candidate identity</h2>
      <p className="muted small">{ASSURANCE_SETTING_NOTE}</p>
      {loadError && <Banner kind="error">This setting could not be read. {loadError}</Banner>}
      {data && (
        <IdentityAssuranceForm data={data} choice={choice} saving={saving} onChoose={(id) => { setChoice(id); setSaveError(''); }} onSave={() => void save()} />
      )}
      {saveError && <Banner kind="error">{saveError}</Banner>}
    </div>
  );
}
