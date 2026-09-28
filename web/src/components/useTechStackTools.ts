import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { mergeDetected, type KnownTechnology, type TechStackItem } from './techStackModel';

/**
 * The two server helpers behind the tech-stack editor: the known technologies
 * it suggests, and what a pasted job description already names. Detection is
 * offered into the editor for the person to confirm, correct or remove; it
 * never writes anything by itself.
 */
export function useTechStackTools() {
  const [catalog, setCatalog] = useState<readonly KnownTechnology[]>([]);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get<{ technologies: KnownTechnology[] }>('/roles/tech-stack/catalog')
      .then((d) => { if (!cancelled) setCatalog(d.technologies); })
      // Suggestions only: typing a technology works without them.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  /** The stack with the JD's technologies merged in, or null when nothing new was found. */
  const detect = async (text: string, current: readonly TechStackItem[]): Promise<TechStackItem[] | null> => {
    if (detecting || !text.trim()) return null;
    setDetecting(true);
    try {
      const res = await api.post<{ techStack: TechStackItem[] }>('/roles/tech-stack/detect', { text });
      const merged = mergeDetected(current, res.techStack);
      return merged.length === current.length ? null : merged;
    } finally {
      setDetecting(false);
    }
  };

  return { catalog, detecting, detect };
}
