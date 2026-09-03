import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RecentProject, EngineType } from '../types';

const RECENT_PROJECTS_KEY = 'sciencebatch-recent-projects';

export function useRecentProjects() {
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(() => {
    try {
      const saved = localStorage.getItem(RECENT_PROJECTS_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Validate recent projects on initial startup to purge deleted folders
  useEffect(() => {
    if (recentProjects.length === 0) return;
    const validate = async () => {
      try {
        const validPaths: string[] = await invoke('validate_recent_paths', {
          paths: recentProjects.map((p) => p.path),
        });
        setRecentProjects((prev) => {
          const filtered = prev.filter((p) => validPaths.includes(p.path));
          if (filtered.length !== prev.length) {
            try {
              localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(filtered));
            } catch (e) {
              console.error('Failed to sync sanitized recent projects:', e);
            }
          }
          return filtered;
        });
      } catch (err) {
        console.warn('Failed to validate recent projects on startup:', err);
      }
    };
    validate();
  }, []);

  const removeRecentProject = useCallback((pathToRemove: string) => {
    setRecentProjects((prev) => {
      const updated = prev.filter((p) => p.path !== pathToRemove);
      try {
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save updated recent projects:', e);
      }
      return updated;
    });
  }, []);

  const recordRecentProject = useCallback((path: string, name: string, eng: EngineType) => {
    setRecentProjects((prev) => {
      const existing = prev.filter((p) => p.path !== path);
      const updated: RecentProject[] = [
        { path, name, lastOpened: Date.now(), engine: eng },
        ...existing,
      ].slice(0, 10);
      try {
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save recent projects:', e);
      }
      return updated;
    });
  }, []);

  return {
    recentProjects,
    recordRecentProject,
    removeRecentProject,
  };
}
