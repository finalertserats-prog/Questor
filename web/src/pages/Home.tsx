import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { ListPager } from '../components/ListPager';
import { DEFAULT_PAGE_SIZE, type PageSize } from '../components/listPagingModel';
import { Crew } from '../components/hrbox/Crew';
import { NeedsYouQueue, NeedsYouSkeleton } from '../components/hrbox/NeedsYouQueue';
import {
  comingUpState, crewSentence, dayAndTime, doneLine, greetingFor, hourIn, splitComingUp, timeOfDay,
  waitLabel, type ComingUpItem, type NeedsYouFeed,
} from '../components/hrbox/needsYouModel';

type Load =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly forbidden: boolean }
  | { readonly status: 'ready'; readonly feed: NeedsYouFeed };

/**
 * HR-Box's Home: what needs you (most urgent first, then oldest), what is
 * coming up today and this week, and what was done recently, under a greeting
 * that says what the five interviewers are doing.
 */
export function Home() {
  const { user } = useAuth();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad((prev) => (prev.status === 'ready' ? prev : { status: 'loading' }));
    api.get<NeedsYouFeed>(`/dashboard/needs-you?page=${page}&pageSize=${pageSize}`)
      .then((feed) => { if (!cancelled) setLoad({ status: 'ready', feed }); })
      .catch((err: unknown) => {
        if (!cancelled) setLoad({ status: 'error', forbidden: err instanceof ApiError && err.status === 403 });
      });
    return () => { cancelled = true; };
  }, [page, pageSize, attempt]);

  const retry = useCallback(() => { setLoad({ status: 'loading' }); setAttempt((n) => n + 1); }, []);
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0] ?? '';

  if (load.status === 'error' && load.forbidden) {
    return (
      <section className="hb-home" aria-labelledby="hb-greeting">
        <h1 id="hb-greeting" className="hb-greeting">Home</h1>
        <EmptyState icon="lock" title="Nothing here for your role" message="Home lists work on candidates, which your role does not include. The audit log is in your profile menu." />
      </section>
    );
  }

  const feed = load.status === 'ready' ? load.feed : null;
  // The server's clock when it answered, so every "waiting 3 h" on the page agrees.
  const now = feed ? Date.parse(feed.generatedAt) : Date.now();
  const zone = feed?.timeZone ?? 'Asia/Kolkata';
  const hello = `${greetingFor(hourIn(zone, now))}${firstName ? `, ${firstName}` : ''}.`;
  const dayWord = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: zone }).format(now);

  return (
    <section className="hb-home hb-motion" aria-labelledby="hb-greeting" aria-busy={load.status === 'loading'}>
      <header className="hb-greet">
        <span className="hb-micro">{dayWord} · {zoneShort(zone)}</span>
        <h1 id="hb-greeting" className="hb-greeting">{hello}</h1>
        {feed
          ? <p className="hb-sentence">{crewSentence(feed.crew, feed.needsYou)}</p>
          : load.status === 'loading' && <p className="hb-sentence hb-sentence--pending" aria-hidden="true"><span className="hb-sk" style={{ width: 340, maxWidth: '85%' }} /></p>}
      </header>

      {feed && <Crew crew={feed.crew} timeZone={zone} />}

      <section className="hb-block" aria-labelledby="hb-needs">
        <div className="hb-block-head">
          <h2 id="hb-needs">What needs you {feed && <span className="hb-count">{feed.needsYou.total}</span>}</h2>
          <small>{load.status === 'loading' ? 'Checking…' : 'Most urgent first, then oldest'}</small>
        </div>
        {load.status === 'loading' && <NeedsYouSkeleton />}
        {load.status === 'error' && (
          <div className="hb-error" role="alert">
            <Icon name="alert" size={16} />
            <span>Couldn't load what needs you.</span>
            <button type="button" className="btn sm secondary" onClick={retry}>Try again</button>
          </div>
        )}
        {feed && feed.needsYou.total === 0 && (
          <EmptyState compact icon="check-circle" title="Nothing needs you" message="Reviews, candidates asking for a person, invitations about to close and stalled interviews will appear here as they happen." />
        )}
        {feed && feed.needsYou.items.length > 0 && <NeedsYouQueue rows={feed.needsYou.items} now={now} />}
        {feed && feed.needsYou.total > DEFAULT_PAGE_SIZE && (
          <ListPager
            meta={{ total: feed.needsYou.total, page: feed.needsYou.page, pageSize: feed.needsYou.pageSize }}
            pageSize={pageSize}
            noun="item"
            label="What needs you"
            onPage={setPage}
            onPageSize={(size) => { setPageSize(size); setPage(1); }}
          />
        )}
      </section>

      {feed && <ComingUp items={feed.comingUp} timeZone={zone} now={now} />}
      {feed && <DoneRecently feed={feed} now={now} />}
    </section>
  );
}

function zoneShort(zone: string): string {
  if (zone === 'Asia/Kolkata') return 'IST';
  return zone.split('/').pop()?.replace(/_/g, ' ') ?? zone;
}

function ComingUpList({ items, timeZone, now, withDay }: { items: readonly ComingUpItem[]; timeZone: string; now: number; withDay: boolean }) {
  return (
    <ul className="hb-today">
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`}>
          <span className="hb-today-t">{item.live ? 'now' : withDay ? dayAndTime(item.at, timeZone) : timeOfDay(item.at, timeZone)}</span>
          <span className="hb-today-n">
            <Link to={item.to}>{item.candidate.name}</Link>
            <span>{item.role.title}</span>
          </span>
          <span className="hb-today-who">
            {item.kind === 'ai'
              ? <><span className="hb-avatar hb-avatar--sm" aria-hidden="true">{(item.interviewerName ?? '?').slice(0, 1)}</span>{item.interviewerName ?? 'AI interviewer'}</>
              : 'Hiring team'}
          </span>
          <span className={item.live ? 'hb-today-state is-live' : 'hb-today-state'}>{item.live && <i aria-hidden="true" />}{comingUpState(item, now)}</span>
        </li>
      ))}
    </ul>
  );
}

function ComingUp({ items, timeZone, now }: { items: readonly ComingUpItem[]; timeZone: string; now: number }) {
  const { today, later } = splitComingUp(items, timeZone, now);
  return (
    <section className="hb-block" aria-labelledby="hb-coming">
      <div className="hb-block-head">
        <h2 id="hb-coming">Coming up</h2>
        <small>Times in {zoneShort(timeZone)}</small>
      </div>
      {items.length === 0 && <p className="muted small">Nothing booked for this week.</p>}
      {today.length > 0 && (
        <>
          <h3 className="hb-sub">Today <span className="hb-count">{today.length}</span></h3>
          <ComingUpList items={today} timeZone={timeZone} now={now} withDay={false} />
        </>
      )}
      {later.length > 0 && (
        <>
          <h3 className="hb-sub">This week <span className="hb-count">{later.length}</span></h3>
          <ComingUpList items={later} timeZone={timeZone} now={now} withDay />
        </>
      )}
    </section>
  );
}

function DoneRecently({ feed, now }: { feed: NeedsYouFeed; now: number }) {
  return (
    <section className="hb-block" aria-labelledby="hb-done">
      <div className="hb-block-head">
        <h2 id="hb-done">Done recently</h2>
        <small>Last 7 days</small>
      </div>
      {feed.doneRecently.length === 0
        ? <p className="muted small">Nothing finished this week yet.</p>
        : (
          <ul className="hb-done">
            {feed.doneRecently.map((item) => (
              <li key={item.id}>
                <Icon name="check" size={14} />
                <span className="hb-done-what">
                  <Link to={item.to}>{item.candidate.name}</Link>
                  {item.role && <span className="muted"> · {item.role.title}</span>}
                  <span className="hb-done-line">{doneLine(item)}</span>
                </span>
                <span className="hb-done-at">{waitLabel(item.at, now)} ago</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}
