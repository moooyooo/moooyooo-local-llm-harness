// Ports chosen to avoid common dev tools (3000/5173/8080, Ollama 11434, ...), the original custom-harnes
// (38710-38712) and Windows' dynamic range (49152+). Production and dev use different ports so both can run at once.

/** `npm start`: server serving the built GUI. */
export const PROD_PORT = 38720;
/** `npm run dev`: API/WebSocket server. */
export const DEV_SERVER_PORT = 38721;
/** `npm run dev`: Vite dev server (proxies /ws to DEV_SERVER_PORT). */
export const DEV_WEB_PORT = 38722;
/** `npm run searxng`: the local SearXNG container behind WebSearch, published on 127.0.0.1 only. */
export const SEARXNG_PORT = 38730;
