import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SecurityScan, TurnStats } from '../../../shared/protocol';
import { t, tNodes, tx } from '../i18n';
import { imageFiles, type Attachment } from '../images';
import { pendingPermissions, type Item, type PermissionItem, type Tab } from '../state';
import { formatDuration, formatTokens, lineDiff, summarizeInput, truncate } from '../util';
import { parseTodos } from '../../../shared/todos';
import { CheckpointRow, type CheckpointHandlers } from './Checkpoint';
import { TodoList } from './SidebarParts';

export type PermissionHandler = (id: string, allow: boolean) => void;

/** Seconds without output before the waiting time is shown, and before the hint about long tool calls. */
const QUIET_SHOW = 10;
const QUIET_HINT = 60;

export function Transcript({ tab, onPermission, onSend, checkpoint }: {
  tab: Tab;
  onPermission: PermissionHandler;
  onSend: (text: string) => void;
  checkpoint: CheckpointHandlers;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [tab.key, tab.items.length, tab.streamText, tab.streamThinking]);

  const streaming = !!(tab.streamText || tab.streamThinking);
  const waiting = tab.busy && pendingPermissions(tab).length === 0;
  // Offer to continue when the latest turn stopped early and nothing was sent since (history notices or a
  // compaction may follow).
  const lastResult = tab.items.findLastIndex((it) => it.kind === 'result');
  const canContinue =
    tab.running &&
    !tab.busy &&
    lastResult >= 0 &&
    (tab.items[lastResult] as Extract<Item, { kind: 'result' }>).unfinished &&
    tab.items.slice(lastResult + 1).every((it) => it.kind === 'notice' || it.kind === 'compact');
  return (
    <div className="transcript">
      {tab.items.length === 0 && !streaming && (
        <div className="empty">
          {t('transcript.started')}
          {tab.session && !tab.session.tools && <div className="hint">{t('transcript.noTools')}</div>}
        </div>
      )}
      {tab.items.map((it) =>
        it.kind === 'checkpoint' ? (
          <CheckpointRow key={it.id} item={it} tab={tab} handlers={checkpoint} />
        ) : (
          <ItemView key={it.id} item={it} onPermission={onPermission} />
        ),
      )}
      {tab.streamThinking && (
        <details className="thinking streaming" open>
          <summary>{t('transcript.thinkingLive')}</summary>
          <pre>{tab.streamThinking}</pre>
        </details>
      )}
      {tab.streamText && (
        <div className="msg assistant streaming">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{tab.streamText}</ReactMarkdown>
        </div>
      )}
      {waiting && <Waiting since={tab.lastActivity ?? Date.now()} streaming={streaming} compacting={!!tab.compacting} />}
      {canContinue && (
        <div className="continue">
          {/* The prompt follows the GUI language, so the model answers in it. */}
          <button className="primary" title={t('transcript.continuePrompt')} onClick={() => onSend(t('transcript.continuePrompt'))}>
            {t('transcript.continue')}
          </button>
          <span className="muted">{t('transcript.continueHint')}</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/** Ollama streams nothing while the model writes a tool call, so show how long it has been quiet. */
function Waiting({ since, streaming, compacting }: { since: number; streaming: boolean; compacting: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const quiet = Math.max(0, Math.floor((now - since) / 1000));
  if (streaming && quiet < QUIET_SHOW) return null;
  return (
    <div className="thinking-dots">
      {t(compacting ? 'transcript.compacting' : 'transcript.waiting')}
      {quiet >= QUIET_SHOW && <span title={t('transcript.quietTitle')}> {formatDuration(quiet)}</span>}
      {quiet >= QUIET_HINT && !compacting && (
        <div className="hint-muted">{t('transcript.quietHint')}</div>
      )}
    </div>
  );
}

function ItemView({ item, onPermission }: { item: Exclude<Item, { kind: 'checkpoint' }>; onPermission: PermissionHandler }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          {item.text}
          {item.images && <Thumbs images={item.images} />}
        </div>
      );
    case 'text':
      return (
        <div className="msg assistant">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking">
          <summary>{t('transcript.thinking')}</summary>
          <pre>{item.text}</pre>
        </details>
      );
    case 'tool':
      return (
        <details className={`tool ${item.isError ? 'error' : ''} ${item.result == null ? 'pending' : ''}`}>
          <summary>
            <b>{item.name}</b> <span className="tool-summary">{summarizeInput(item.input)}</span>
          </summary>
          <ToolInput name={item.name} input={item.input} />
          {item.result != null && <pre className="tool-result">{truncate(item.result, 8000)}</pre>}
        </details>
      );
    case 'permission':
      return <PermissionCard item={item} onPermission={onPermission} />;
    case 'result':
      return (
        <div className={`result ${item.isError ? 'error' : ''}`}>
          {t(`result.${item.subtype}`)} · {item.numTurns} turns · {(item.durationMs / 1000).toFixed(1)}s
          {item.stats && <StatsText stats={item.stats} />}
          {item.message && <div>{tx(item.message)}</div>}
        </div>
      );
    case 'notice':
      return <div className={`notice ${item.level}`}>{tx(item.text)}</div>;
    case 'compact':
      // Old tool outputs were dropped, with no summary to show.
      if (item.trimmed && !item.summary) {
        return (
          <div className="notice info">
            {t('transcript.trimmed', {
              count: item.trimmed,
              tokens:
                item.tokensBefore != null && item.tokensAfter != null
                  ? t('transcript.compactedTokens', { before: item.tokensBefore.toLocaleString(), after: item.tokensAfter.toLocaleString() })
                  : '',
            })}
          </div>
        );
      }
      return (
        <details className="compaction">
          <summary>
            {t('transcript.compacted', {
              how: t(item.auto ? 'transcript.compactedAuto' : 'transcript.compactedManual'),
              tokens:
                item.tokensBefore != null && item.tokensAfter != null
                  ? t('transcript.compactedTokens', { before: item.tokensBefore.toLocaleString(), after: item.tokensAfter.toLocaleString() })
                  : '',
            })}
          </summary>
          <div className="compaction-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.summary}</ReactMarkdown>
          </div>
        </details>
      );
  }
}

function StatsText({ stats }: { stats: TurnStats }) {
  const pct = stats.contextMax ? Math.round((stats.contextUsed / stats.contextMax) * 100) : undefined;
  return (
    <>
      {' · '}
      <span title={t('transcript.tokensTitle')}>
        {stats.promptTokens.toLocaleString()} → {stats.evalTokens.toLocaleString()} tok
      </span>
      {stats.tokensPerSec != null && ` · ${stats.tokensPerSec.toFixed(1)} tok/s`}
      {pct != null && stats.contextMax && (
        <span title={t('transcript.contextTitle', { used: stats.contextUsed.toLocaleString(), max: stats.contextMax.toLocaleString() })}>
          {` · ctx ${pct}% / ${formatTokens(stats.contextMax)}`}
        </span>
      )}
    </>
  );
}

/** Tool input in a readable form: a diff for Edit, the content for Write, the command for shells. */
function ToolInput({ name, input, max = 8000 }: { name: string; input: Record<string, unknown>; max?: number }) {
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (name === 'Edit' && typeof input.old_string === 'string') {
    return (
      <div className="tool-input">
        <div className="path">
          {s(input.file_path)}
          {input.replace_all === true && <span className="muted">{t('transcript.replaceAll')}</span>}
        </div>
        <pre className="diff">
          {lineDiff(truncate(s(input.old_string), max / 2), truncate(s(input.new_string), max / 2)).map((l, i) => (
            <div key={i} className={l.op === '-' ? 'del' : l.op === '+' ? 'add' : 'ctx'}>{l.op} {l.text}</div>
          ))}
        </pre>
      </div>
    );
  }
  if (name === 'Write' && typeof input.content === 'string') {
    return (
      <div className="tool-input">
        <div className="path">{t('transcript.writeFile', { path: s(input.file_path) })}</div>
        <pre>{truncate(input.content, max)}</pre>
      </div>
    );
  }
  if (name === 'TodoWrite') {
    const parsed = parseTodos(input.todos);
    if ('todos' in parsed) return <TodoList todos={parsed.todos} />;
  }
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return <pre className="command">{truncate(input.command, max)}</pre>;
  }
  return <pre>{truncate(JSON.stringify(input, null, 2), max)}</pre>;
}

const STATUS_TEXT = { allowed: 'permission.allowed', denied: 'permission.denied', cancelled: 'permission.cancelled' } as const;

/** Used both inline in the transcript and in the permission inbox. */
export function PermissionCard({ item, onPermission, compact }: {
  item: PermissionItem;
  onPermission: PermissionHandler;
  /** One-line input summary instead of the full input (inbox). */
  compact?: boolean;
}) {
  if (item.status === 'auto') {
    return (
      <div className="permission-auto" title={JSON.stringify(item.input, null, 2)}>
        {tNodes('permission.auto', { tool: <b>{item.toolName}</b> })} <span className="tool-summary">{summarizeInput(item.input)}</span>
        {item.reason && <span className="muted">{t('permission.autoReason', { reason: tx(item.reason) })}</span>}
        {item.security && <span className="sec-ok">{t('permission.autoScanOk', { files: item.security.checkedFiles })}</span>}
      </div>
    );
  }
  return (
    <div className={`permission ${item.status} ${compact ? 'compact' : ''}`}>
      <div>
        {tNodes('permission.request', { tool: <b>{item.toolName}</b> })} {item.description && <span className="muted">— {item.description}</span>}
      </div>
      {item.status === 'pending' && !item.autoEligible && item.reason && (
        <div className="perm-reason">{t('permission.notAuto', { reason: tx(item.reason) })}</div>
      )}
      {compact ? (
        <div className="tool-summary">{summarizeInput(item.input)}</div>
      ) : (
        <ToolInput name={item.toolName} input={item.input} max={4000} />
      )}
      {item.security && <SecurityReport scan={item.security} compact={compact} />}
      {item.status === 'pending' ? (
        <div className="row">
          <button className="primary" onClick={() => onPermission(item.id, true)}>{t('permission.allow')}</button>
          <button onClick={() => onPermission(item.id, false)}>{t('permission.deny')}</button>
        </div>
      ) : (
        <div className="muted">{t(STATUS_TEXT[item.status])}</div>
      )}
    </div>
  );
}

const OP_LABEL = { init: 'init', add: 'add', commit: 'commit', push: 'push' } as const;

/** Result of the pre-commit/push scan shown on a git permission prompt. */
function SecurityReport({ scan, compact }: { scan: SecurityScan; compact?: boolean }) {
  const ops = scan.ops.map((o) => `git ${OP_LABEL[o]}`).join(' / ');
  if (scan.error) return <div className="sec sec-error">{t('security.failed', { ops, error: scan.error })}</div>;
  if (!scan.findings.length) {
    return (
      <div className="sec sec-clean">
        {t('security.clean', { ops, files: scan.checkedFiles, partial: scan.truncated ? t('security.partial') : '' })}
      </div>
    );
  }
  const high = scan.findings.filter((f) => f.severity === 'high').length;
  const shown = compact ? scan.findings.slice(0, 5) : scan.findings;
  return (
    <div className={`sec ${high ? 'sec-high' : 'sec-warn'}`}>
      <div>
        <b>{t('security.found', { ops, count: scan.findings.length })}</b>
        {high > 0 && <span>{t('security.foundHigh', { count: high })}</span>}
        <span className="muted">{t('security.scope', { scope: tx(scan.scope), files: scan.checkedFiles })}</span>
      </div>
      <ul>
        {shown.map((f, i) => (
          <li key={i} className={f.severity}>
            <code>{f.path}{f.line ? `:${f.line}` : ''}</code> {tx(f.rule)}
            {f.detail && <span className="muted"> {tx(f.detail)}</span>}
          </li>
        ))}
        {shown.length < scan.findings.length && <li className="muted">{t('security.more', { count: scan.findings.length - shown.length })}</li>}
      </ul>
      {scan.truncated && <div className="muted">{t('security.truncated')}</div>}
      <div className="muted">{t('security.advice')}</div>
    </div>
  );
}

/** Controlled by the parent so each tab keeps its own unsent draft and images. */
export function Composer({ text, setText, attachments, canAttach, note, disabled, busy, onSend, onAddImages, onRemoveImage, onInterrupt }: {
  text: string;
  setText: (text: string) => void;
  attachments: Attachment[];
  /** The model can read images. */
  canAttach: boolean;
  /** Why an image couldn't be attached. */
  note?: string;
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
  onInterrupt: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const canSend = !disabled && !busy && (!!text.trim() || attachments.length > 0);
  const submit = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't send while an IME (e.g. Japanese input) is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.items);
    // Some apps (e.g. spreadsheets) copy text and a picture of it together; paste the text then.
    if (!files.length || e.clipboardData.types.includes('text/plain')) return;
    e.preventDefault();
    onAddImages(files);
  };
  const placeholder = disabled
    ? t('composer.startFirst')
    : t('composer.placeholder', { images: canAttach ? t('composer.placeholderImages') : '' });
  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.id} className="attachment">
              <img src={a.dataUrl} alt={t('composer.attachedImage')} />
              <button className="remove" title={t('composer.removeImage')} onClick={() => onRemoveImage(a.id)}>×</button>
            </div>
          ))}
        </div>
      )}
      {note && <div className="composer-note">{note}</div>}
      <div className="composer-row">
        <button
          className="attach"
          disabled={disabled || !canAttach}
          title={t(canAttach ? 'composer.attachHint' : 'composer.attachUnsupported')}
          onClick={() => fileRef.current?.click()}
        >
          {t('composer.attach')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            onAddImages(imageFiles(e.target.files));
            e.target.value = '';
          }}
        />
        <textarea
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {busy ? (
          <button onClick={onInterrupt}>{t('composer.interrupt')}</button>
        ) : (
          <button className="primary" disabled={!canSend} onClick={submit}>{t('composer.send')}</button>
        )}
      </div>
    </div>
  );
}

/** Images of a sent message; click one to see it larger. */
function Thumbs({ images }: { images: string[] }) {
  const [open, setOpen] = useState<number>();
  return (
    <div className="thumbs">
      {images.map((src, i) => (
        <img key={i} src={src} alt={t('composer.attachedImageN', { n: i + 1 })} className={open === i ? 'open' : ''} onClick={() => setOpen(open === i ? undefined : i)} />
      ))}
    </div>
  );
}
