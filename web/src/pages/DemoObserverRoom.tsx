import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { Icon } from '../components/Icon';
import {
  afterTheBoxText, failureCopy, failureFor, observerAnnouncement, timeLeftText, timerMayBeShown,
  type DemoClock, type DemoFailure,
} from '../components/demoInterviewModel';

interface WatchTurn { index: number; speaker: string; text: string; kind: string }

interface Watch extends DemoClock {
  runId: string;
  simulated: boolean;
  simulatedCandidate: string;
  interviewer: string;
  state: string;
  complete: boolean;
  assessmentId: string | null;
  turns: WatchTurn[];
}

/** Often enough that the conversation arrives, rarely enough to be cheap. */
const POLL_MS = 1_500;

/**
 * Watching the interviewer question a written candidate.
 *
 * The poll IS the playback: the server reveals the next line when its moment
 * has come, so this page holds no timers, no schedule and no copy of the
 * script. Reloading it, or opening it in a second tab, shows the same
 * conversation at the same point.
 *
 * NOTHING HERE MAKES A SOUND. The room's rule — announce only what a candidate
 * cannot hear — therefore inverts: every new turn is the event, and each one
 * is announced politely, once, with the speaker named. Announcing assertively
 * would interrupt a screen-reader user mid-sentence every few seconds.
 */
export function DemoObserverRoom() {
  const { runId = '' } = useParams();
  const [watch, setWatch] = useState<Watch | null>(null);
  const [failure, setFailure] = useState<DemoFailure | null>(null);
  const [askedTime, setAskedTime] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const lastAnnounced = useRef(-1);
  const tail = useRef<HTMLDivElement | null>(null);

  const poll = useCallback(async () => {
    try {
      const next = await api.get<Watch>(`/demo/interview/run/${runId}/watch`);
      setWatch(next);
      setFailure(null);
      const newest = next.turns[next.turns.length - 1];
      if (newest && newest.index > lastAnnounced.current) {
        lastAnnounced.current = newest.index;
        setAnnouncement(observerAnnouncement(newest, next.interviewer, next.simulatedCandidate));
      }
    } catch (err: unknown) {
      setFailure(failureFor(err instanceof ApiError ? err.status : undefined, err instanceof ApiError ? err.code : undefined));
    }
  }, [runId]);

  useEffect(() => {
    void poll();
    const done = watch?.complete === true || watch?.ended === true;
    if (done) return undefined;
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [poll, watch?.complete, watch?.ended]);

  useEffect(() => {
    // Only when the viewer is already at the bottom: yanking the page down
    // while somebody is re-reading an earlier answer is worse than a scrollbar.
    const el = tail.current;
    if (el && el.getBoundingClientRect().top < window.innerHeight + 200) el.scrollIntoView({ block: 'end' });
  }, [watch?.turns.length]);

  if (failure) {
    const copy = failureCopy(failure);
    return (
      <main className="demo-watch">
        <h1>{copy.title}</h1>
        <p>{copy.message}</p>
        <Link className="btn" to="/demo/interview">Back to the demo</Link>
      </main>
    );
  }

  if (!watch) return <div className="card" role="status" aria-busy="true">Opening the interview…</div>;

  const finished = watch.complete || watch.ended;

  return (
    <main className="demo-watch" aria-labelledby="demo-watch-heading">
      <header className="demo-watch-head">
        <h1 id="demo-watch-heading">You are watching an interview</h1>
        {/*
          Said on the page at all times, not once at the start. Somebody who
          joins late, reloads, or shares a screenshot must never be able to
          mistake this for a conversation a person actually had.
        */}
        <p className="demo-watch-simulated">
          <Icon name="flag" size={15} />
          <span>
            <strong>{watch.simulatedCandidate}</strong> is a written candidate from Questor's own test material.
            Nobody is being interviewed. The interviewer, the evidence it collects and the assessment at the end are the product's.
          </span>
        </p>
      </header>

      <div className="demo-watch-body">
        <aside className="demo-watch-rail" aria-label="Who is here">
          <ul>
            <li><span className="demo-watch-dot" aria-hidden="true" />{watch.interviewer}<span className="small muted"> — interviewer</span></li>
            <li><span className="demo-watch-dot" aria-hidden="true" />{watch.simulatedCandidate}<span className="small muted"> — written</span></li>
            <li><span className="demo-watch-dot" aria-hidden="true" />You<span className="small muted"> — watching</span></li>
          </ul>
          {/*
            The clock is behind a press. A countdown running beside the
            interviewer is the product talking over its own interviewer, and a
            live-updating number is read aloud over it by a screen reader.
          */}
          <button className="btn sm secondary" onClick={() => setAskedTime((v) => !v)} aria-expanded={askedTime}>
            {askedTime ? 'Hide time left' : 'How long is left?'}
          </button>
          {timerMayBeShown(watch, askedTime) && (
            <p className="small muted" role="status">{timeLeftText(watch)}</p>
          )}
        </aside>

        <section className="demo-watch-convo" aria-label="The conversation">
          <ol className="demo-watch-turns">
            {watch.turns.map((turn) => (
              <li key={turn.index} className={turn.speaker === 'agent' ? 'demo-watch-turn is-interviewer' : 'demo-watch-turn is-candidate'}>
                <span className="demo-watch-who">{turn.speaker === 'agent' ? watch.interviewer : watch.simulatedCandidate}</span>
                {/* Captions for a conversation nothing speaks aloud: the text
                    IS the caption, so it is always present and never a toggle. */}
                <p className="demo-watch-said">{turn.text}</p>
              </li>
            ))}
          </ol>
          {!finished && (
            <p className="demo-watch-waiting" role="status">
              <Icon name="hourglass" size={14} /> The conversation is still going.
            </p>
          )}
          <div ref={tail} />
        </section>
      </div>

      {/*
        One polite region, replaced per turn. Two slots are not needed here as
        they are in the live room: turns arrive seconds apart, not in bursts.
      */}
      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="demo-watch-announcer">
        {announcement}
      </div>

      {finished && (
        <footer className="card demo-watch-done">
          <h2>The interview finished</h2>
          <p>{afterTheBoxText('observer')}</p>
          {watch.assessmentId && (
            <Link className="btn" to={`/assessments/${watch.assessmentId}`}>Read the assessment it wrote</Link>
          )}
          <Link className="btn secondary" to="/demo/interview">Back to the demo</Link>
        </footer>
      )}
    </main>
  );
}
