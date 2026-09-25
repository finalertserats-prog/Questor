/**
 * HR-Box's Home tab: what needs you, what is coming up, what was done, and the
 * five interviewers. The shapes mirror GET /api/dashboard/needs-you
 * (server/src/services/needsYouFeed.ts); the copy and the small decisions live
 * here so they are unit tested without React.
 */

export type NeedsYouKind =
  | 'round_starting' | 'human_request' | 'accommodation' | 'review' | 'stage_decision' | 'feedback_held'
  | 'invitation_expiring' | 'stalled' | 'identity_code_stuck' | 'round_not_recordable'
  | 'catalog_proposals' | 'demo_request';

/** Why a candidate is ready to move, which is also which move it is. */
export type ReadyBecause = 'profile_read' | 'interview_reviewed';

export interface Looker { readonly userId: string; readonly name: string; readonly initials: string }

export interface NeedsYouRow {
  readonly id: string;
  readonly kind: NeedsYouKind;
  readonly urgent: boolean;
  readonly since: string;
  readonly candidate: { readonly id: string; readonly name: string } | null;
  readonly role: { readonly id: string; readonly title: string } | null;
  readonly subject: string | null;
  readonly sessionId: string | null;
  readonly assessmentId: string | null;
  readonly facts: {
    readonly interviewerName?: string | null; readonly expiresAt?: string; readonly opened?: boolean; readonly count?: number;
    /** For a round that cannot go ahead: the server's own sentence, and what may be done instead. */
    readonly blockedReason?: string; readonly nextSteps?: readonly string[]; readonly scheduledAt?: string;
    /** For a stage decision: where they stand, where the move lands, and what made them ready. */
    readonly stageLabel?: string; readonly nextStageLabel?: string; readonly readyBecause?: ReadyBecause;
  };
  readonly openedBy: readonly Looker[];
  /**
   * Whether this reader may do the row's work or only look at it. A recruiter
   * sees a finished assessment on their candidate and cannot sign it off, so
   * the row reads as ready for review rather than as their read to give.
   * Older responses did not carry it; absent means "may act", which is what
   * every kind but `review` is for everyone shown it.
   */
  readonly canAct?: boolean;
  /**
   * `external` marks the one destination that is not a Questor page: the
   * meeting a round is held in. It is a whole URL rather than a path, so the
   * row renders it as a plain link out — a router link would try to navigate
   * inside the app and land nowhere.
   */
  readonly action: { readonly label: string; readonly to: string | null; readonly external?: boolean };
}

export interface ComingUpItem {
  readonly id: string;
  readonly kind: 'ai' | 'human';
  readonly at: string;
  readonly timeZone: string | null;
  readonly live: boolean;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string };
  readonly interviewerId: string | null;
  readonly interviewerName: string | null;
  readonly to: string;
}

export type DoneKind = 'interview_completed' | 'review_completed' | 'decision' | 'reminder_sent';

export interface DoneItem {
  readonly id: string;
  readonly kind: DoneKind;
  readonly at: string;
  readonly candidate: { readonly id: string; readonly name: string };
  readonly role: { readonly id: string; readonly title: string } | null;
  readonly by: string | null;
  readonly outcome: string | null;
  readonly to: string;
}

export type CrewStatus = 'live' | 'scheduled' | 'done' | 'idle';

export interface CrewMember {
  readonly id: string;
  readonly name: string;
  readonly status: CrewStatus;
  readonly candidateFirstName: string | null;
  readonly at: string | null;
}

/**
 * Nothing has ever happened in this organisation — no work to need anyone,
 * nothing booked, nothing finished.
 *
 * This is NOT the same as an established team that is simply caught up, and
 * telling the two apart is the whole point. Home said "Nothing needs you. The
 * interviewers will say when something does" to both, so an organisation that
 * had just signed up was told, on its first screen, to wait. Two real
 * organisations registered, saw that, and never created a role.
 */
export function hasNothingYet(feed: NeedsYouFeed): boolean {
  return feed.needsYou.total === 0 && feed.comingUp.length === 0 && feed.doneRecently.length === 0;
}

export interface NeedsYouFeed {
  readonly generatedAt: string;
  readonly timeZone: string;
  readonly needsYou: {
    readonly total: number;
    readonly counts: Readonly<Partial<Record<NeedsYouKind, number>>>;
    readonly items: readonly NeedsYouRow[];
    readonly page: number;
    readonly pageSize: number;
  };
  readonly comingUp: readonly ComingUpItem[];
  readonly doneRecently: readonly DoneItem[];
  readonly crew: readonly CrewMember[];
}

/** The rule colour a row is drawn with (styles/hrbox.css), never a fill. */
export type RowTone = 'urgent' | 'review' | 'expire' | 'stall' | 'held' | 'operator';

const KIND_COPY: Readonly<Record<NeedsYouKind, { readonly label: string; readonly tone: RowTone; readonly icon: 'handoff' | 'evidence-review' | 'hourglass' | 'pause' | 'mail' | 'list' | 'inbox' | 'mic' | 'decision' }>> = {
  round_starting: { label: 'Your interview starts now', tone: 'urgent', icon: 'handoff' },
  human_request: { label: 'Asked for a person', tone: 'urgent', icon: 'handoff' },
  accommodation: { label: 'Asked for an adjustment', tone: 'urgent', icon: 'handoff' },
  review: { label: 'Review ready', tone: 'review', icon: 'evidence-review' },
  stage_decision: { label: 'Ready to move on', tone: 'review', icon: 'decision' },
  feedback_held: { label: 'Feedback email held', tone: 'held', icon: 'mail' },
  invitation_expiring: { label: 'Invitation closes soon', tone: 'expire', icon: 'hourglass' },
  stalled: { label: 'Stalled interview', tone: 'stall', icon: 'pause' },
  identity_code_stuck: { label: 'Identity code stuck', tone: 'expire', icon: 'mail' },
  round_not_recordable: { label: 'Round cannot go ahead', tone: 'stall', icon: 'mic' },
  catalog_proposals: { label: 'Catalog proposals', tone: 'operator', icon: 'list' },
  demo_request: { label: 'Demo access requested', tone: 'operator', icon: 'inbox' },
};

export function kindCopy(kind: NeedsYouKind) {
  return KIND_COPY[kind];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "18 min", "3 h", "5 days": how long something has waited. */
export function waitLabel(since: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(since));
  if (!Number.isFinite(ms)) return '';
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} days`;
}

/** The small caption over the wait: what the clock is counting from. */
export function waitCaption(kind: NeedsYouKind): string {
  if (kind === 'round_starting') return 'Starts';
  // Not "Waiting": the clock on this row counts from the moment the candidate
  // became ready, which is how long they have been standing still.
  if (kind === 'stage_decision') return 'Ready for';
  if (kind === 'invitation_expiring') return 'Sent';
  if (kind === 'stalled') return 'Quiet for';
  if (kind === 'feedback_held') return 'Held';
  if (kind === 'round_not_recordable') return 'Booked for';
  return 'Waiting';
}

/** "in 2 days", "in 5 h", "today": when an invitation closes. */
export function closesIn(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  if (ms < DAY) return `in ${Math.max(1, Math.round(ms / HOUR))} h`;
  const days = Math.round(ms / DAY);
  return `in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The clock on the right of a row.
 *
 * Every other kind counts up from when a wait began. A round about to start
 * counts DOWN to a time that has not arrived, and `waitLabel` clamps a future
 * instant to zero — so it would have printed "1 min" for a round due in a
 * quarter of an hour, which is the one thing on this row that must not be wrong.
 */
export function clockLabel(row: NeedsYouRow, now: number): string {
  if (row.kind !== 'round_starting') return waitLabel(row.since, now);
  const ms = Date.parse(row.since) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  // Minutes, not `closesIn`'s hours: this row's whole life is a quarter of an
  // hour, and "in 1 h" for a round twelve minutes away is the one thing on it
  // that must not be wrong.
  return `in ${Math.max(1, Math.round(ms / MINUTE))} min`;
}

/** The kind line over the name, with what makes this one urgent or dated. */
export function kindLine(row: NeedsYouRow, now: number): string {
  const { label } = kindCopy(row.kind);
  if (row.kind === 'invitation_expiring' && row.facts.expiresAt) return `Invitation closes ${closesIn(row.facts.expiresAt, now)}`;
  return row.urgent ? `${label} · urgent` : label;
}

/** One plain sentence under the name: why this is here. */
export function whyLine(row: NeedsYouRow): string {
  const by = row.facts.interviewerName;
  switch (row.kind) {
    case 'round_starting':
      // Deliberately does not promise the candidate: the row may be for an
      // expert whose only claim is the seat, and the server sends them to their
      // own worklist because a seat is not an assignment.
      return row.action.external
        ? 'You are conducting this. The meeting is open.'
        : 'You are conducting this. There is no meeting link on the round yet.';
    case 'identity_code_stuck':
      return 'Their identity code could not be sent. Check the address on file.';
    case 'human_request':
      return 'Asked to talk to someone on the hiring team.';
    case 'accommodation':
      return 'Paused the interview to ask for an adjustment. It waits for you.';
    // Says which move it is and what made them ready, because "decide their
    // next stage" on its own tells a person nothing they can act on. The
    // labels come from the role's own stage plan, so a team that renamed its
    // stages reads its own words here.
    case 'stage_decision': {
      const to = row.facts.nextStageLabel ?? 'the next stage';
      return row.facts.readyBecause === 'interview_reviewed'
        ? `Their AI interview has been read and reviewed. Decide whether they go to ${to}.`
        : `Their CV has been read against the approved scorecard. Decide whether they go to ${to}.`;
    }
    case 'review':
      if (row.canAct === false) {
        return by
          ? `${by}'s assessment is in. Ready for review: you can read it, someone else signs it off.`
          : 'The assessment is in. Ready for review: you can read it, someone else signs it off.';
      }
      return by ? `${by}'s assessment is in. Your read comes first.` : 'The assessment is in. Your read comes first.';
    case 'feedback_held':
      return 'The feedback email was held back. Read it before it goes.';
    case 'invitation_expiring':
      return row.facts.opened ? 'Opened the link, not started yet.' : 'Has not opened the link yet.';
    case 'stalled':
      return by ? `Stopped part-way with ${by}. Decide whether to reopen or offer a retake.` : 'Stopped part-way. Decide whether to reopen or offer a retake.';
    case 'round_not_recordable':
      // The server's own sentence, not a shorter one written here: the feed and
      // the round itself must say the same thing, and this is the queue where
      // somebody first learns an interview in the diary will not happen.
      return row.facts.blockedReason
        ?? 'This round cannot go ahead as booked. Open the candidate to see why and decide what happens next.';
    case 'catalog_proposals':
      return 'New roles and titles from the monthly refresh wait for your approval.';
    case 'demo_request':
      return 'Wants the demo again. Approve or decline from the email we sent you.';
  }
}

/** Who the row is about: the candidate, else what it names. */
export function whoOf(row: NeedsYouRow): string {
  return row.candidate?.name ?? row.subject ?? '';
}

/** "No one yet", "Rahul opened it", "Rahul, Anil saw it". */
export function lookedLine(openedBy: readonly Looker[]): string {
  if (openedBy.length === 0) return 'No one yet';
  const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
  if (openedBy.length === 1) return `${first(openedBy[0].name)} opened it`;
  const names = openedBy.slice(0, 2).map((l) => first(l.name)).join(', ');
  return openedBy.length > 2 ? `${names} and ${openedBy.length - 2} more saw it` : `${names} saw it`;
}

/** "Good morning" by the organisation's clock. */
export function greetingFor(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The hour now in a zone, 0-23; the browser's own clock when the zone is unknown. */
export function hourIn(timeZone: string, now: number): number {
  try {
    const hour = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now);
    return Number(hour);
  } catch {
    return new Date(now).getHours();
  }
}

/**
 * The serif line under the greeting: what the interviewers are doing, then
 * what that means for you. "Maya is mid-interview with Priya. Avery finished
 * with Arjun and is waiting on your read."
 */
export function crewSentence(crew: readonly CrewMember[], queue: { readonly total: number; readonly items: readonly NeedsYouRow[] }): string {
  const live = crew.filter((m) => m.status === 'live');
  const done = crew.filter((m) => m.status === 'done');
  const parts: string[] = [];
  if (live.length === 1) parts.push(`${live[0].name} is mid-interview with ${live[0].candidateFirstName ?? 'a candidate'}.`);
  else if (live.length > 1) parts.push(`${joinNames(live.map((m) => m.name))} are interviewing right now.`);
  // Only for a reader who can actually give that read: a recruiter sees the
  // review row but does not sign it off, so telling them an interviewer is
  // waiting on THEIR read would be wrong.
  const waitingOnRead = done.find((m) => queue.items.some((r) =>
    r.kind === 'review' && r.canAct !== false && r.facts.interviewerName === m.name && !!r.candidate && firstWord(r.candidate.name) === m.candidateFirstName));
  if (waitingOnRead) parts.push(`${waitingOnRead.name} finished with ${waitingOnRead.candidateFirstName} and is waiting on your read.`);
  else if (done.length === 1) parts.push(`${done[0].name} finished with ${done[0].candidateFirstName ?? 'a candidate'} today.`);
  if (parts.length === 0) {
    if (queue.total === 0) return 'Nothing needs you right now. The interviewers will say when something does.';
    return queue.total === 1 ? 'One thing needs you. Everything else is moving on its own.' : `${countWord(queue.total)} things need you. Everything else is moving on its own.`;
  }
  return parts.join(' ');
}

function firstWord(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export function countWord(n: number): string {
  return WORDS[n] ?? String(n);
}

/** What the strip says under each interviewer's name. */
export function crewNote(member: CrewMember, timeZone: string): string {
  if (member.status === 'live') return 'live';
  if (member.status === 'done') return 'done';
  // A bare "14:00" here read as the reader's own clock to anyone who was not
  // sitting in the organisation's. The offset costs four characters.
  if (member.status === 'scheduled' && member.at) {
    const clock = timeOfDay(member.at, timeZone);
    return clock ? `${clock} ${zoneOffsetLabel(Date.parse(member.at), timeZone)}` : '';
  }
  return 'free';
}

/** "14:00" on the organisation's clock. */
export function timeOfDay(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(Date.parse(at));
  } catch {
    return '';
  }
}

/**
 * "GMT+5:30", "BST": what clock an instant is being written on.
 *
 * An offset, never a city. Home used to special-case Asia/Kolkata to "IST" and
 * otherwise print the last segment of the zone id — so a New York round was
 * labelled "New York", which is neither an abbreviation nor an offset and
 * conveys nothing to someone trying to work out when to turn up.
 */
export function zoneOffsetLabel(at: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'shortOffset', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

function knownZone(timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return timeZone;
  } catch {
    // A zone this browser does not know is not worth failing Home over.
    return null;
  }
}

/**
 * The clock a coming-up row belongs on: the zone its interview was booked in,
 * else the organisation's. The server has always sent the first of those; the
 * page used to ignore it and write every row on the second.
 */
export function itemZone(item: ComingUpItem, orgZone: string): string {
  return knownZone(item.timeZone) ?? orgZone;
}

/**
 * When a coming-up row is, naming the clock it is on.
 *
 * The zone is spelled out only when it is not the organisation's — on the
 * organisation's own clock the offset is enough, and repeating "Asia/Kolkata"
 * down a column of rows that are all in it buries the one row that is not.
 */
export function comingUpWhen(item: ComingUpItem, orgZone: string, withDay: boolean): string {
  const zone = itemZone(item, orgZone);
  const at = Date.parse(item.at);
  const clock = withDay ? dayAndTime(item.at, zone) : timeOfDay(item.at, zone);
  const offset = zoneOffsetLabel(at, zone);
  return zone === orgZone ? `${clock} ${offset}` : `${clock} ${offset} (${zone})`;
}

/** The calendar day of an instant in a zone, "YYYY-MM-DD". */
export function dayIn(at: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** Coming-up items split into today and the rest of the week, by the organisation's day. */
export function splitComingUp(items: readonly ComingUpItem[], timeZone: string, now: number): { readonly today: readonly ComingUpItem[]; readonly later: readonly ComingUpItem[] } {
  const today = dayIn(now, timeZone);
  return {
    today: items.filter((i) => i.live || dayIn(Date.parse(i.at), timeZone) <= today),
    later: items.filter((i) => !i.live && dayIn(Date.parse(i.at), timeZone) > today),
  };
}

/** "Mon 28 Sep, 14:00" for the rest of the week. */
export function dayAndTime(at: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(Date.parse(at));
  } catch {
    return at;
  }
}

/** The state column of a coming-up row. */
export function comingUpState(item: ComingUpItem, now: number): string {
  if (item.live) return 'Live now';
  if (item.kind === 'human') return 'Human round';
  const ms = Date.parse(item.at) - now;
  if (ms <= 0) return 'Due now';
  if (ms < HOUR) return `Starts in ${Math.max(1, Math.round(ms / MINUTE))} min`;
  if (ms < DAY) return `Starts in ${Math.round(ms / HOUR)} h`;
  return 'Booked';
}

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  APPROVED: 'moved forward', REJECTED: 'not taken forward', WITHDRAWN: 'withdrew',
  PROCEED: 'proceed', CONSIDER: 'consider', DO_NOT_PROGRESS: 'do not progress',
};

/** One line for a done item. */
export function doneLine(item: DoneItem): string {
  const outcome = item.outcome ? OUTCOME_WORDS[item.outcome] ?? item.outcome.toLowerCase() : null;
  switch (item.kind) {
    case 'interview_completed':
      return item.by ? `${item.by} finished the interview` : 'Interview finished';
    case 'review_completed':
      return `${item.by ?? 'A reviewer'} reviewed it${outcome ? `: ${outcome}` : ''}`;
    case 'decision':
      return outcome ? `Decided: ${outcome}` : 'Decided';
    case 'reminder_sent':
      return 'Reminder sent to the candidate';
  }
}

/** The bell's accessible name, which is also its tooltip. */
export function bellLabel(total: number | null): string {
  if (total === null) return 'What needs you';
  if (total === 0) return 'Nothing needs you';
  return total === 1 ? '1 thing needs you' : `${total} things need you`;
}

/** What the badge prints: nothing at zero, "99+" past that. */
export function bellBadge(total: number | null): string {
  if (!total || total <= 0) return '';
  return total > 99 ? '99+' : String(total);
}
