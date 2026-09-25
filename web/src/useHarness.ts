import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { ClientMessage, ServerMessage } from '../../shared/protocol';
import { createInitialState, reducer, type SavedTabs } from './state';

const RECONNECT_MS = 2000;

/**
 * @param initial working folder for the first tab, and the tabs of the last page load
 * @param onMessage side-effect hook (e.g. notifications), called before the message is reduced
 */
export function useHarness(initial: { cwd: string; saved?: SavedTabs }, onMessage?: (msg: ServerMessage) => void) {
  const [state, dispatch] = useReducer(reducer, initial, createInitialState);
  const wsRef = useRef<WebSocket | null>(null);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;
  const tabsRef = useRef(state.tabs);
  tabsRef.current = state.tabs;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      wsRef.current = ws;
      const request = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
      ws.onopen = () => dispatch({ type: 'connected', value: true });
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
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
        dispatch({ type: 'connected', value: false });
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  return { state, dispatch, send };
}
