import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * How the rest of the app asks for the guided tour. The profile menu's "Take
 * the tour" calls startTour(); the ProductTour overlay watches the request
 * counter and begins again at step one each time it changes.
 */
interface TourContextValue {
  readonly startRequest: number;
  readonly startTour: () => void;
}

const TourContext = createContext<TourContextValue>({ startRequest: 0, startTour: () => undefined });

export function TourProvider({ children }: { children: ReactNode }) {
  const [startRequest, setStartRequest] = useState(0);
  const startTour = useCallback(() => setStartRequest((count) => count + 1), []);
  const value = useMemo(() => ({ startRequest, startTour }), [startRequest, startTour]);
  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  return useContext(TourContext);
}
