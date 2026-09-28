import { useEffect, useState } from 'react';
import type { DirectoryListing, DirectoryRequest } from '../../shared/protocol';

export type RequestDirectory = (request: DirectoryRequest) => Promise<DirectoryListing>;

/** Debounce path completion and discard replies for text that has already changed. */
export function useDirectorySuggestions(value: string, enabled: boolean, request: RequestDirectory): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    setPaths([]);
    if (!enabled || !value.trim()) return;
    let current = true;
    const timer = setTimeout(() => {
      request({ type: 'listDirectories', path: value, complete: true })
        .then((result) => {
          if (current) setPaths(result.entries.map((e) => value.startsWith('~') && e.path.startsWith(result.home)
            ? `~${e.path.slice(result.home.length)}` : e.path));
        })
        .catch(() => { /* Browsing reports errors; partial input need not be a valid path. */ });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [value, enabled, request]);
  return paths;
}
