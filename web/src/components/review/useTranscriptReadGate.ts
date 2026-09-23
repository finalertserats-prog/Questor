import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import {
  forTranscript, hasReadAll, markEndReached, markTurnSeen, noTurnsSeen, reportableIndexes,
  type SeenTurns, type TranscriptReadRecord,
} from './transcriptReadGate';

/**
 * The page's side of the transcript requirement.
 *
 * The server refuses a verdict from a reviewer with no record of having read
 * the interview (POST /assessments/:id/transcript-read). This hook keeps that
 * record honest: it tracks which turns were actually put in front of the
 * reviewer and reports those, rather than asserting a number the server would
 * have to take on trust.
 *
 * It is deliberately small and owns no layout. The review page decides where
 * the turns are, which element marks the end, and where the "I read it
 * elsewhere" control lives; this only holds the marks and talks to the server.
 */

export type ReadGateStatus = 'loading' | 'not-read' | 'read' | 'error';

export interface TranscriptReadGate {
  readonly status: ReadGateStatus;
  /** The server's record, once there is one. */
  readonly record: TranscriptReadRecord | null;
  /** True when the page has shown enough to be allowed to submit the record. */
  readonly canRecord: boolean;
  readonly error: string;
  readonly saving: boolean;
  /** Mark a turn shown — call from an intersection observer AND from onFocus. */
  readonly noteTurnSeen: (index: number) => void;
  /** Mark the end of the transcript reached; counts everything above it. */
  readonly noteEndReached: () => void;
  /** Send what has been shown. Resolves true when the server accepted it. */
  readonly recordRead: () => Promise<boolean>;
  /** The audited alternative for a reviewer who read the downloaded transcript. */
  readonly recordReadElsewhere: (attestation: string) => Promise<boolean>;
}

interface Saved {
  readonly transcriptRead: TranscriptReadRecord | null;
}

function messageOf(err: unknown): string {
  return typeof err === 'object' && err !== null && typeof (err as { message?: string }).message === 'string'
    ? (err as { message: string }).message
    : 'That could not be saved. Try again.';
}

export function useTranscriptReadGate(assessmentId: string | null, turnIndexes: readonly number[]): TranscriptReadGate {
  const key = assessmentId ?? '';
  const [marks, setMarks] = useState<SeenTurns>(() => noTurnsSeen(key));
  const [record, setRecord] = useState<TranscriptReadRecord | null>(null);
  const [status, setStatus] = useState<ReadGateStatus>('loading');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // A different assessment is a different transcript: nothing carries over.
  useEffect(() => { setMarks((previous) => forTranscript(previous, key)); }, [key]);

  // Whether this reviewer has already met the requirement — they may have read
  // it yesterday, or on another device. Asked rather than assumed, so coming
  // back to a review does not make them read it again.
  useEffect(() => {
    if (!assessmentId) { setStatus('loading'); return; }
    let live = true;
    setStatus('loading');
    api.get<Saved>(`/assessments/${assessmentId}/transcript-read`)
      .then((answer) => {
        if (!live) return;
        setRecord(answer.transcriptRead);
        setStatus(answer.transcriptRead ? 'read' : 'not-read');
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(messageOf(err));
        setStatus('error');
      });
    return () => { live = false; };
  }, [assessmentId]);

  const noteTurnSeen = useCallback((index: number) => {
    setMarks((previous) => markTurnSeen(previous, index));
  }, []);

  const noteEndReached = useCallback(() => {
    setMarks((previous) => markEndReached(previous));
  }, []);

  const send = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    if (!assessmentId) return false;
    setSaving(true);
    setError('');
    try {
      const answer = await api.post<Saved>(`/assessments/${assessmentId}/transcript-read`, body);
      setRecord(answer.transcriptRead);
      setStatus('read');
      return true;
    } catch (err: unknown) {
      setError(messageOf(err));
      return false;
    } finally {
      setSaving(false);
    }
  }, [assessmentId]);

  const recordRead = useCallback(
    () => send({ method: 'in_app', seenIndexes: reportableIndexes(marks, turnIndexes) }),
    [send, marks, turnIndexes],
  );

  const recordReadElsewhere = useCallback(
    (attestation: string) => send({ method: 'elsewhere', attestation }),
    [send],
  );

  return {
    status,
    record,
    canRecord: hasReadAll(marks, turnIndexes),
    error,
    saving,
    noteTurnSeen,
    noteEndReached,
    recordRead,
    recordReadElsewhere,
  };
}
