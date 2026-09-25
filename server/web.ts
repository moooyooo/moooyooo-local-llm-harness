import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { convert } from 'html-to-text';
import { SEARXNG_PORT } from '../shared/ports.js';

/**
 * WebSearch / WebFetch, offered only when the session turns web access on. Searches go to the user's local SearXNG
 * (`npm run searxng`); pages are fetched from here, but never from this machine or the local network (a page or a
 * prompt injection must not reach Ollama, this harness, the router, ...).
 */

export const SEARXNG_URL = (process.env.SEARXNG_URL ?? `http://127.0.0.1:${SEARXNG_PORT}`).replace(/\/+$/, '');
const SEARCH_RESULTS = 6;
const SNIPPET_CHARS = 300;
/** Characters of page text per WebFetch call; longer pages are read in parts with `offset`. */
export const PAGE_CHARS = 12_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export async function searxngReachable(): Promise<boolean> {
  try {
    return (await fetch(`${SEARXNG_URL}/healthz`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

interface SearxResult {
  title?: string;
  url?: string;
  content?: string;
  publishedDate?: string | null;
}

export async function webSearch(query: string, signal: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${SEARXNG_URL}/search?${new URLSearchParams({ q: query, format: 'json' })}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`SearXNG is not reachable at ${SEARXNG_URL}. Tell the user to start it with "npm run searxng".`);
  }
  if (!res.ok) throw new Error(`SearXNG answered HTTP ${res.status}${res.status === 403 ? ' (is the json format enabled in its settings.yml?)' : ''}.`);
  const seen = new Set<string>();
  const results = (((await res.json()) as { results?: SearxResult[] }).results ?? [])
    .filter((r) => r.url && !seen.has(r.url) && seen.add(r.url))
    .slice(0, SEARCH_RESULTS);
  if (!results.length) return `No results for "${query}". Try other keywords.`;
  const lines = results.map((r, i) =>
    [
      `${i + 1}. ${oneLine(r.title || '(no title)', 200)}`,
      `   ${r.url}`,
      r.publishedDate && `   ${r.publishedDate.slice(0, 10)}`,
      r.content && `   ${oneLine(r.content, SNIPPET_CHARS)}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return `${lines.join('\n')}\n\nRead a page with WebFetch.`;
}

// ---------------------------------------------------------------------------------------------
// Page fetch

/** Networks a page fetch must not reach: this machine, private and link-local networks, multicast, reserved. */
const BLOCKED = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
] as const) BLOCKED.addSubnet(addr, prefix, 'ipv4');
// IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) are checked against the IPv4 rules by BlockList itself.
for (const [addr, prefix] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) BLOCKED.addSubnet(addr, prefix, 'ipv6');

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  return family === 0 || BLOCKED.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** Why WebFetch refuses this URL, or undefined. Host names are checked again when they resolve. */
export function checkUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Not a valid URL: ${raw}`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'WebFetch reads only http:// and https:// URLs.';
  if (url.username || url.password) return 'URLs with credentials are not fetched.';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isBlockedAddress(host))) {
    return 'WebFetch does not access this machine or the local network.';
  }
  return undefined;
}

/** DNS lookup for page requests that refuses local addresses at connect time, so DNS rebinding can't get around it. */
export const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as unknown as dns.LookupAddress[];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (bad || !list.length) {
      const e = Object.assign(new Error(`${hostname} is on this machine or the local network (${bad?.address ?? 'no address'})`), { code: 'EBLOCKED' });
      return callback(e, '', 0);
    }
    if (options.all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

function get(url: URL, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).get(
      url,
      {
        lookup: safeLookup,
        signal,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'ja,en;q=0.8' },
      },
      resolve,
    );
    req.on('error', reject);
  });
}

async function readBody(res: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of res as AsyncIterable<Buffer>) {
    parts.push(part);
    size += part.length;
    if (size >= MAX_PAGE_BYTES) {
      res.destroy();
      break;
    }
  }
  return Buffer.concat(parts).subarray(0, MAX_PAGE_BYTES);
}

/** Charset from the Content-Type header, else from a <meta> tag near the top, else UTF-8 (Japanese sites may be Shift_JIS). */
export function decode(body: Buffer, contentType: string): string {
  const label = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(label ?? 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

const SKIP = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'svg', 'form', 'button', 'iframe', 'img'];

/** The readable text of a page: the main content (or the body), with headings, lists and tables kept as text. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleHtml = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  const text = convert(html, {
    wordwrap: false,
    baseElements: { selectors: ['main', 'article', '[role=main]', 'body'], orderBy: 'selectors', returnDomByDefault: true },
    limits: { maxBaseElements: 1 },
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
      { selector: 'table', format: 'dataTable', options: { uppercaseHeaderCells: false, maxColumnWidth: 40 } },
      ...SKIP.map((selector) => ({ selector, format: 'skip' })),
    ],
  });
  return { title: oneLine(convert(titleHtml, { wordwrap: false }), 200), text };
}

export async function webFetch(raw: string, offset: number, signal: AbortSignal): Promise<string> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  let url = new URL(raw);
  for (let hop = 0; ; hop++) {
    const problem = checkUrl(url.href);
    if (problem) throw new Error(problem);
    const res = await get(url, timeout);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects from ${raw}`);
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status >= 400) {
      res.resume();
      throw new Error(`HTTP ${status} from ${url.href}`);
    }
    const type = String(res.headers['content-type'] ?? '').toLowerCase();
    const body = await readBody(res);
    let page: { title: string; text: string };
    if (!type || type.includes('html') || type.includes('xml')) page = htmlToText(decode(body, type));
    else if (type.startsWith('text/') || type.includes('json')) page = { title: '', text: decode(body, type) };
    else throw new Error(`WebFetch reads web pages and text, not ${type.split(';')[0]}.`);
    return pageOutput(page, url.href, offset);
  }
}

export function pageOutput(page: { title: string; text: string }, url: string, offset: number): string {
  const text = page.text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (offset > 0 && offset >= text.length) return `offset ${offset} is past the end of the page (${text.length} characters).`;
  const part = text.slice(offset, offset + PAGE_CHARS);
  const rest = text.length - offset - part.length;
  const head = [page.title && `Title: ${page.title}`, `URL: ${url}`, offset > 0 && `(from character ${offset})`].filter(Boolean);
  const more = rest > 0 ? `\n\n(${rest} more characters. Call WebFetch with offset=${offset + part.length} to read on.)` : '';
  return `${head.join('\n')}\n\n${part || '(no text on this page)'}${more}`;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
