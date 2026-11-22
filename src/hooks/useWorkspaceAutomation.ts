import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { WorkspaceAutomationReply, WorkspaceAutomationRequest } from '../types/automation';

export function useWorkspaceAutomation(
  handleRequest: (request: WorkspaceAutomationRequest) => Promise<WorkspaceAutomationReply>,
  handleDisconnect?: (jobId: string) => void,
) {
  const handlerRef = useRef(handleRequest);
  const disconnectRef = useRef(handleDisconnect);
  handlerRef.current = handleRequest;
  disconnectRef.current = handleDisconnect;

  useEffect(() => {
    let active = true;
    const unlisteners: UnlistenFn[] = [];
    void Promise.allSettled([
      listen<WorkspaceAutomationRequest>('workspace-automation-request', event => {
        const request = event.payload;
        void handlerRef.current(request).catch((error: unknown) => ({
          schemaVersion: 1 as const,
          id: request.id,
          ok: false,
          error: { code: 'workspace.internal', message: String(error) },
        })).then(reply => invoke('workspace_automation_reply', { id: request.id, reply })).catch(() => undefined);
      }),
      listen<{ id: string; jobId: string }>('workspace-automation-disconnected', event => {
        if (disconnectRef.current) disconnectRef.current(event.payload.jobId);
        else void invoke('cancel_workspace_compilation', { jobId: event.payload.jobId }).catch(() => undefined);
      }),
    ]).then(results => {
      const stops = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      if (!active || results.some(result => result.status === 'rejected')) stops.forEach(stop => stop());
      else {
        unlisteners.push(...stops);
        return invoke('workspace_automation_ready');
      }
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisteners.forEach(stop => stop());
    };
  }, []);
}
