import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Banner } from './ui';
import { Icon } from './Icon';
import { useToast } from './Toast';
import { formatDate } from './dateFormat';

interface Device {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedFrom: string;
  thisDevice: boolean;
}

/**
 * The devices this person asked to be remembered on, and a way to take any of
 * them back.
 *
 * The list is the point. A standing permission to skip the sign-in code that
 * nobody can see is a permission nobody will ever notice being wrong; shown
 * with when it was last used and roughly where from, a device that is not
 * yours is visible in a glance.
 */
export function TrustedDevicesPanel() {
  const toast = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // A failed read is not an empty list. "You have not asked us to remember any
  // device" is a claim about the security state of an account, and making it
  // out of a request that failed is how a person is reassured about something
  // nobody actually checked.
  const [loadFailed, setLoadFailed] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async (keepError = false) => {
    try {
      const data = await api.get<{ devices: Device[] }>('/auth/devices');
      setDevices(data.devices ?? []);
      setLoadFailed(false);
      if (!keepError) setError('');
    } catch (err: unknown) {
      setLoadFailed(true);
      setError(err instanceof Error ? err.message : 'Could not load your devices.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const revoke = async (device: Device) => {
    setActingId(device.id);
    setError('');
    try {
      const data = await api.del<{ devices: Device[] }>(`/auth/devices/${device.id}`);
      setDevices(data.devices ?? []);
      toast.show(
        device.thisDevice
          ? 'This device will be asked for a sign-in code again.'
          : `${device.label} will be asked for a sign-in code again.`,
        { testId: 'device-revoked' },
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not remove that device.');
      // Re-read so the list is true, without erasing the sentence saying the
      // device is still remembered.
      await load(true);
    } finally {
      setActingId(null);
    }
  };

  if (loading) return null;

  return (
    <section className="card" data-testid="trusted-devices-panel" aria-labelledby="trusted-devices-title">
      <h2 id="trusted-devices-title">Remembered devices</h2>
      <p className="muted small">
        Devices you chose to keep signed in on for a week. They skip the emailed sign-in code — not
        your password. Changing your password or your role removes all of them.
      </p>
      {error && <Banner kind="error">{error}</Banner>}

      {devices.length === 0 && loadFailed ? (
        <div className="row" style={{ gap: 8, marginTop: 14 }}>
          <span className="muted small">Your devices could not be read, so it is not known whether any are remembered.</span>
          <button type="button" className="btn secondary sm" onClick={() => { setLoading(true); void load(); }}>
            <Icon name="refresh" size={14} />Try again
          </button>
        </div>
      ) : devices.length === 0 ? (
        <p className="muted small" style={{ marginTop: 14 }}>
          You have not asked us to remember any device. You will be asked for a code each time your
          organisation requires one.
        </p>
      ) : (
        <ul className="device-list">
          {devices.map((device) => (
            <li key={device.id} className="device-row">
              <div>
                <div className="device-name">
                  {device.label}
                  {device.thisDevice && <span className="device-here"> · this device</span>}
                </div>
                <div className="muted small">
                  Remembered {formatDate(device.createdAt)} · expires {formatDate(device.expiresAt)}
                </div>
                <div className="muted small">
                  {device.lastUsedAt
                    ? `Last used ${formatDate(device.lastUsedAt)}${device.lastUsedFrom ? ` from ${device.lastUsedFrom}` : ''}`
                    : 'Not used since it was remembered'}
                </div>
              </div>
              <button
                type="button"
                className="btn sm secondary"
                disabled={actingId === device.id}
                aria-label={`Forget ${device.label}`}
                onClick={() => void revoke(device)}
              >
                <Icon name="close" size={14} />
                {actingId === device.id ? 'Removing…' : 'Forget'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
