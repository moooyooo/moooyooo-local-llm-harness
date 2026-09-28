import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ClientMessage, DirectoryListing, DirectoryRequest, ServerMessage } from '../../shared/protocol';
import { msg as text, TextError } from '../../shared/i18n';
import { createInitialState, reducer, type SavedTabs } from './state';

const RECONNECT_MS = 2000;

/**
 * @param initial working folder for the first tab, and the tabs of the last page load
 * @param onMessage side-effect hook (e.g. notifications), called before the message is reduced
 */
export function useHarness(initial: { cwd: string; saved?: SavedTabs }, onMessage?: (msg: ServerMessage) => void) {
  const [state, dispatch] = useReducer(reducer, initial, createInitialState);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingDirectories = useRef(new Map<string, {
    resolve: (data: DirectoryListing) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rejectDirectories = () => {
      for (const request of pendingDirectories.current.values()) {
        clearTimeout(request.timer);
        request.reject(new TextError(text('app.disconnected')));
      }
      pendingDirectories.current.clear();
    };

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      wsRef.current = ws;
      const request = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
      ws.onopen = () => dispatch({ type: 'connected', value: true });
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        if (msg.type === 'directory') {
          const pending = pendingDirectories.current.get(msg.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingDirectories.current.delete(msg.requestId);
            if (msg.data) pending.resolve(msg.data);
            else pending.reject(new TextError(msg.error ?? text('common.unknownError')));
          }
          return;
        }
        onMessageRef.current?.(msg);
        dispatch({ type: 'server', msg, at: Date.now() });
        // Refresh on connect and after each turn: prompts change the session list, and models load / unload.
        if (msg.type === 'hello' || (msg.type === 'event' && msg.ev.type === 'result')) {
          request({ type: 'listSessions' });
          request({ type: 'listModels' });
        }
        // Sessions keep running on the server while the page is away; show this page's tabs' sessions again.
        if (msg.type === 'hello') request({ type: 'attach', keys: tabsRef.current.map((tb) => tb.key) });
      };
      ws.onclose = () => {
        if (disposed) return;
        rejectDirectories();
        dispatch({ type: 'connected', value: false });
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      wsRef.current?.close();
      rejectDirectories();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const requestDirectory = useCallback((request: DirectoryRequest): Promise<DirectoryListing> => {
    const ws = wsRef.current;
    if (ws?.readyState !== WebSocket.OPEN) return Promise.reject(new TextError(text('app.disconnected')));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingDirectories.current.delete(requestId);
        reject(new TextError(text('folder.timeout')));
      }, 15_000);
      pendingDirectories.current.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...request, requestId }));
    });
  }, []);

  return { state, dispatch, send, requestDirectory };
}
