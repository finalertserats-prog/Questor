import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { PageHeader } from '../components/PageHeader';

interface HealthPayload {
  commit?: unknown;
}

export function About() {
  const [version, setVersion] = useState('Loading…');

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error('Health check failed');
        return res.json() as Promise<HealthPayload>;
      })
      .then((data) => {
        if (!active) return;
        setVersion(typeof data.commit === 'string' && data.commit.length > 0 ? data.commit.slice(0, 7) : 'Version unavailable');
      })
      .catch(() => {
        if (active) setVersion('Version unavailable');
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div>
      <PageHeader icon="about" title="About" />
      <div className="card about-card">
        <p>
          Questor is one place for HR to take a candidate from job description to decision: onboard the profile,
          run an AI first-round interview with Schranders, schedule further human rounds, and review every step
          through evidence. Every AI assessment is reviewed by a person before it affects anyone.
        </p>
        <div className="about-build">
          <div className="small muted card-title"><Icon name="build" size={14} />Running build</div>
          <code>{version}</code>
        </div>
      </div>
    </div>
  );
}
