import { useState, useEffect, useCallback } from 'react';
import { SidebarToolId, SidebarState } from '../types/sidebar';

const STORAGE_KEY = 'sciencebatch_sidebar_state_v1';

const DEFAULT_STATE: SidebarState = {
  topTools: ['files', 'search', 'git'],
  bottomTools: ['outline'],
  activeTopTool: 'files',
  activeBottomTool: null,
  panelWidth: 22,
  splitRatio: 50,
  isOpen: true,
};

function loadStoredState(): SidebarState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_STATE;
    const parsed = JSON.parse(saved);

    // Validate that required tools are preserved
    const allTools: SidebarToolId[] = ['files', 'search', 'outline', 'git'];
    const loadedTop: SidebarToolId[] = Array.isArray(parsed.topTools) 
      ? parsed.topTools.filter((id: any) => allTools.includes(id)) 
      : DEFAULT_STATE.topTools;
    const loadedBottom: SidebarToolId[] = Array.isArray(parsed.bottomTools) 
      ? parsed.bottomTools.filter((id: any) => allTools.includes(id)) 
      : DEFAULT_STATE.bottomTools;

    // Ensure all tools exist somewhere
    for (const tool of allTools) {
      if (!loadedTop.includes(tool) && !loadedBottom.includes(tool)) {
        loadedTop.push(tool);
      }
    }

    return {
      topTools: loadedTop,
      bottomTools: loadedBottom,
      activeTopTool: parsed.activeTopTool && loadedTop.includes(parsed.activeTopTool) ? parsed.activeTopTool : null,
      activeBottomTool: parsed.activeBottomTool && loadedBottom.includes(parsed.activeBottomTool) ? parsed.activeBottomTool : null,
      panelWidth: typeof parsed.panelWidth === 'number' ? Math.max(14, Math.min(45, parsed.panelWidth)) : 22,
      splitRatio: typeof parsed.splitRatio === 'number' ? Math.max(15, Math.min(85, parsed.splitRatio)) : 50,
      isOpen: typeof parsed.isOpen === 'boolean' ? parsed.isOpen : true,
    };
  } catch (e) {
    console.error('Failed to parse sidebar state from localStorage:', e);
    return DEFAULT_STATE;
  }
}

export function useSidebar() {
  const [state, setState] = useState<SidebarState>(() => loadStoredState());

  // Save to localStorage on state changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to save sidebar state to localStorage:', e);
    }
  }, [state]);

  // Toggle a tool icon in the activity bar
  const toggleTool = useCallback((toolId: SidebarToolId) => {
    setState((prev) => {
      const isTop = prev.topTools.includes(toolId);
      const isBottom = prev.bottomTools.includes(toolId);

      if (isTop) {
        if (prev.activeTopTool === toolId) {
          // Deactivate top tool
          const willHaveBottom = prev.activeBottomTool !== null;
          return {
            ...prev,
            activeTopTool: null,
            isOpen: willHaveBottom ? prev.isOpen : false,
          };
        } else {
          // Activate this tool in top slot
          return {
            ...prev,
            activeTopTool: toolId,
            isOpen: true,
          };
        }
      } else if (isBottom) {
        if (prev.activeBottomTool === toolId) {
          // Deactivate bottom tool
          const willHaveTop = prev.activeTopTool !== null;
          return {
            ...prev,
            activeBottomTool: null,
            isOpen: willHaveTop ? prev.isOpen : false,
          };
        } else {
          // Activate this tool in bottom slot
          return {
            ...prev,
            activeBottomTool: toolId,
            isOpen: true,
          };
        }
      }
      return prev;
    });
  }, []);

  // Close a specific panel (top or bottom slot)
  const closeTool = useCallback((slot: 'top' | 'bottom') => {
    setState((prev) => {
      if (slot === 'top') {
        const remaining = prev.activeBottomTool !== null;
        return {
          ...prev,
          activeTopTool: null,
          isOpen: remaining ? prev.isOpen : false,
        };
      } else {
        const remaining = prev.activeTopTool !== null;
        return {
          ...prev,
          activeBottomTool: null,
          isOpen: remaining ? prev.isOpen : false,
        };
      }
    });
  }, []);

  // Move tool between groups (or reorder within group)
  const moveTool = useCallback((toolId: SidebarToolId, targetGroup: 'top' | 'bottom', targetIndex?: number) => {
    setState((prev) => {
      const currentTop = [...prev.topTools];
      const currentBottom = [...prev.bottomTools];

      // Remove from existing locations
      const inTopIdx = currentTop.indexOf(toolId);
      if (inTopIdx !== -1) currentTop.splice(inTopIdx, 1);

      const inBottomIdx = currentBottom.indexOf(toolId);
      if (inBottomIdx !== -1) currentBottom.splice(inBottomIdx, 1);

      let newActiveTop = prev.activeTopTool;
      let newActiveBottom = prev.activeBottomTool;

      if (targetGroup === 'top') {
        if (typeof targetIndex === 'number' && targetIndex >= 0) {
          currentTop.splice(targetIndex, 0, toolId);
        } else {
          currentTop.push(toolId);
        }
        // If it was active in bottom, move active state to top
        if (prev.activeBottomTool === toolId) {
          newActiveBottom = null;
          newActiveTop = toolId;
        }
      } else {
        if (typeof targetIndex === 'number' && targetIndex >= 0) {
          currentBottom.splice(targetIndex, 0, toolId);
        } else {
          currentBottom.push(toolId);
        }
        // If it was active in top, move active state to bottom
        if (prev.activeTopTool === toolId) {
          newActiveTop = null;
          newActiveBottom = toolId;
        }
      }

      return {
        ...prev,
        topTools: currentTop,
        bottomTools: currentBottom,
        activeTopTool: newActiveTop,
        activeBottomTool: newActiveBottom,
      };
    });
  }, []);

  // Global toggle sidebar content panel (Ctrl+B / Toolbar button)
  const toggleSidebar = useCallback(() => {
    setState((prev) => {
      if (prev.isOpen) {
        return { ...prev, isOpen: false };
      } else {
        // If reopening and neither tool was active, activate the first available tool
        let activeTop = prev.activeTopTool;
        let activeBottom = prev.activeBottomTool;
        if (!activeTop && !activeBottom) {
          activeTop = prev.topTools[0] || 'files';
        }
        return {
          ...prev,
          isOpen: true,
          activeTopTool: activeTop,
          activeBottomTool: activeBottom,
        };
      }
    });
  }, []);

  const setPanelWidth = useCallback((width: number) => {
    setState((prev) => ({ ...prev, panelWidth: width }));
  }, []);

  const setSplitRatio = useCallback((ratio: number) => {
    setState((prev) => ({ ...prev, splitRatio: ratio }));
  }, []);

  const resetToDefaults = useCallback(() => {
    setState(DEFAULT_STATE);
  }, []);

  return {
    state,
    toggleTool,
    closeTool,
    moveTool,
    toggleSidebar,
    setPanelWidth,
    setSplitRatio,
    resetToDefaults,
  };
}
