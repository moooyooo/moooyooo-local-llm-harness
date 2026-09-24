import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { SecurityScan, TurnStats } from '../../../shared/protocol';
import { pendingPermissions, type Item, type PermissionItem, type Tab } from '../state';
import { formatDuration, formatTokens, lineDiff, summarizeInput, truncate } from '../util';

export type PermissionHandler = (id: string, allow: boolean) => void;

/** Sent by the 「続きから再開」 button after a turn stopped early. */
const CONTINUE_PROMPT =
  '前回の作業は途中で止まりました。作業フォルダを確認して、どこまで終わっているかを短くまとめてから、残りの作業を続けてください。' +
  '大きなファイルは一度に書かず、小さく分けて書いてください。';
/** Seconds without output before the waiting time is shown, and before the hint about long tool calls. */
const QUIET_SHOW = 10;
const QUIET_HINT = 60;

export function Transcript({ tab, onPermission, onSend }: {
  tab: Tab;
  onPermission: PermissionHandler;
  onSend: (text: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [tab.key, tab.items.length, tab.streamText, tab.streamThinking]);

  const streaming = !!(tab.streamText || tab.streamThinking);
  const waiting = tab.busy && pendingPermissions(tab).length === 0;
  // Offer to continue when the latest turn stopped early and nothing was sent since (history notices may follow).
  const lastResult = tab.items.findLastIndex((it) => it.kind === 'result');
  const canContinue =
    tab.running &&
    !tab.busy &&
    lastResult >= 0 &&
    (tab.items[lastResult] as Extract<Item, { kind: 'result' }>).unfinished &&
    tab.items.slice(lastResult + 1).every((it) => it.kind === 'notice');
  return (
    <div className="transcript">
      {tab.items.length === 0 && !streaming && (
        <div className="empty">
          セッションを開始しました。メッセージを送信してください。
          {tab.session && !tab.session.tools && (
            <div className="hint">このモデルはツール呼び出しに対応していないため、会話のみです（ファイルの読み書きやコマンド実行はできません）。</div>
          )}
        </div>
      )}
      {tab.items.map((it) => <ItemView key={it.id} item={it} onPermission={onPermission} />)}
      {tab.streamThinking && (
        <details className="thinking streaming" open>
          <summary>思考中…</summary>
          <pre>{tab.streamThinking}</pre>
        </details>
      )}
      {tab.streamText && (
        <div className="msg assistant streaming">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{tab.streamText}</ReactMarkdown>
        </div>
      )}
      {waiting && <Waiting since={tab.lastActivity ?? Date.now()} streaming={streaming} />}
      {canContinue && (
        <div className="continue">
          <button className="primary" title={CONTINUE_PROMPT} onClick={() => onSend(CONTINUE_PROMPT)}>続きから再開</button>
          <span className="muted">作業フォルダの状態を確認させてから、残りを続けさせます</span>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

/** Ollama streams nothing while the model writes a tool call, so show how long it has been quiet. */
function Waiting({ since, streaming }: { since: number; streaming: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const quiet = Math.max(0, Math.floor((now - since) / 1000));
  if (streaming && quiet < QUIET_SHOW) return null;
  return (
    <div className="thinking-dots">
      考え中…
      {quiet >= QUIET_SHOW && <span title="最後の出力からの経過時間"> {formatDuration(quiet)}</span>}
      {quiet >= QUIET_HINT && (
        <div className="hint-muted">
          ファイルの中身などを含むツール呼び出しは、書き終わるまで何も表示されません。長すぎる場合は「中断」して、小さく分けるよう指示してください。
        </div>
      )}
    </div>
  );
}

function ItemView({ item, onPermission }: { item: Item; onPermission: PermissionHandler }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user">{item.text}</div>;
    case 'text':
      return (
        <div className="msg assistant">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
        </div>
      );
    case 'thinking':
      return (
        <details className="thinking">
          <summary>思考</summary>
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
          {item.subtype} · {item.numTurns} turns · {(item.durationMs / 1000).toFixed(1)}s
          {item.stats && <StatsText stats={item.stats} />}
          {item.message && <div>{item.message}</div>}
        </div>
      );
    case 'notice':
      return <div className={`notice ${item.level}`}>{item.text}</div>;
  }
}

function StatsText({ stats }: { stats: TurnStats }) {
  const pct = stats.contextMax ? Math.round((stats.contextUsed / stats.contextMax) * 100) : undefined;
  return (
    <>
      {' · '}
      <span title="最後のモデル呼び出しの入力トークン → 出力トークン">
        {stats.promptTokens.toLocaleString()} → {stats.evalTokens.toLocaleString()} tok
      </span>
      {stats.tokensPerSec != null && ` · ${stats.tokensPerSec.toFixed(1)} tok/s`}
      {pct != null && stats.contextMax && (
        <span title={`コンテキスト ${stats.contextUsed.toLocaleString()} / ${stats.contextMax.toLocaleString()}`}>
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
          {input.replace_all === true && <span className="muted">（すべて置換）</span>}
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
        <div className="path">{s(input.file_path)}（新規作成・上書き）</div>
        <pre>{truncate(input.content, max)}</pre>
      </div>
    );
  }
  if ((name === 'Bash' || name === 'PowerShell') && typeof input.command === 'string') {
    return <pre className="command">{truncate(input.command, max)}</pre>;
  }
  return <pre>{truncate(JSON.stringify(input, null, 2), max)}</pre>;
}

const STATUS_TEXT = { allowed: '許可しました', denied: '拒否しました', cancelled: '中断により取り消されました' } as const;

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
        ✓ 自動承認: <b>{item.toolName}</b> <span className="tool-summary">{summarizeInput(item.input)}</span>
        {item.reason && <span className="muted">（{item.reason}）</span>}
        {item.security && <span className="sec-ok"> 🔒 セキュリティチェック問題なし（{item.security.checkedFiles} ファイル）</span>}
      </div>
    );
  }
  return (
    <div className={`permission ${item.status} ${compact ? 'compact' : ''}`}>
      <div>
        <b>{item.toolName}</b> の実行許可 {item.description && <span className="muted">— {item.description}</span>}
      </div>
      {item.status === 'pending' && !item.autoEligible && item.reason && (
        <div className="perm-reason">自動承認の対象外: {item.reason}</div>
      )}
      {compact ? (
        <div className="tool-summary">{summarizeInput(item.input)}</div>
      ) : (
        <ToolInput name={item.toolName} input={item.input} max={4000} />
      )}
      {item.security && <SecurityReport scan={item.security} compact={compact} />}
      {item.status === 'pending' ? (
        <div className="row">
          <button className="primary" onClick={() => onPermission(item.id, true)}>許可</button>
          <button onClick={() => onPermission(item.id, false)}>拒否</button>
        </div>
      ) : (
        <div className="muted">{STATUS_TEXT[item.status]}</div>
      )}
    </div>
  );
}

const OP_LABEL = { init: 'init', add: 'add', commit: 'commit', push: 'push' } as const;

/** Result of the pre-commit/push scan shown on a git permission prompt. */
function SecurityReport({ scan, compact }: { scan: SecurityScan; compact?: boolean }) {
  const ops = scan.ops.map((o) => `git ${OP_LABEL[o]}`).join(' / ');
  if (scan.error) return <div className="sec sec-error">🔒 {ops} 前のセキュリティチェックに失敗しました: {scan.error}</div>;
  if (!scan.findings.length) {
    return (
      <div className="sec sec-clean">
        🔒 {ops} 前のセキュリティチェック: 問題なし（{scan.checkedFiles} ファイル確認{scan.truncated ? '・上限に達したため一部未確認' : ''}）
      </div>
    );
  }
  const high = scan.findings.filter((f) => f.severity === 'high').length;
  const shown = compact ? scan.findings.slice(0, 5) : scan.findings;
  return (
    <div className={`sec ${high ? 'sec-high' : 'sec-warn'}`}>
      <div>
        <b>⚠ {ops} 前のセキュリティチェック: {scan.findings.length} 件</b>
        {high > 0 && <span>（うち重大 {high} 件）</span>}
        <span className="muted"> — {scan.scope}、{scan.checkedFiles} ファイル確認</span>
      </div>
      <ul>
        {shown.map((f, i) => (
          <li key={i} className={f.severity}>
            <code>{f.path}{f.line ? `:${f.line}` : ''}</code> {f.rule}
            {f.detail && <span className="muted"> {f.detail}</span>}
          </li>
        ))}
        {shown.length < scan.findings.length && <li className="muted">…ほか {scan.findings.length - shown.length} 件</li>}
      </ul>
      {scan.truncated && <div className="muted">上限に達したため、一部のファイルは未確認です。</div>}
      <div className="muted">.gitignore への追加やファイルの除外を指示してから、もう一度実行させることをおすすめします。</div>
    </div>
  );
}

/** Controlled by the parent so each tab keeps its own unsent draft. */
export function Composer({ text, setText, disabled, busy, onSend, onInterrupt }: {
  text: string;
  setText: (text: string) => void;
  disabled: boolean;
  busy: boolean;
  onSend: (text: string) => void;
  onInterrupt: () => void;
}) {
  const submit = () => {
    const t = text.trim();
    if (!t || disabled || busy) return;
    onSend(t);
    setText('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Don't send while an IME (e.g. Japanese input) is composing.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        disabled={disabled}
        placeholder={disabled ? 'セッションを開始してください' : 'メッセージ（Enterで送信 / Shift+Enterで改行）'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <button onClick={onInterrupt}>中断</button>
      ) : (
        <button className="primary" disabled={disabled || !text.trim()} onClick={submit}>送信</button>
      )}
    </div>
  );
}
