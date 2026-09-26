import type { LoadedModel, ModelInfo, OllamaStatus } from '../../../shared/protocol';
import type { MessageKey } from '../../../shared/i18n';
import { t, tx } from '../i18n';
import type { Todo } from '../../../shared/todos';
import { latestTodos, type Tab } from '../state';
import { formatBytes, formatTokens } from '../util';

/** Think settings with a translated name; levels (low, medium, high) are shown as they are. */
const THINK_LABEL: Record<string, MessageKey> = { '': 'common.default', on: 'common.on', off: 'common.off' };

export function SessionPanel({ tab, onCompact }: { tab: Tab; onCompact: () => void }) {
  const s = tab.session;
  const stats = tab.stats;
  const canCompact = tab.running && !tab.busy && tab.items.some((it) => it.kind === 'user');
  return (
    <div className="session">
      {s ? (
        <>
          <div>
            <span>{t('session.id')}</span>
            <code className="copyable" title={t('session.copyId', { id: s.sessionId })} onClick={() => navigator.clipboard?.writeText(s.sessionId)}>
              {s.sessionId.slice(0, 8)}…
            </code>
          </div>
          <div><span>{t('session.model')}</span><code title={s.model}>{s.model}</code></div>
          <div><span>{t('session.mode')}</span><code>{s.permissionMode}</code></div>
          <div><span>{t('session.thinkCtx')}</span><code>{THINK_LABEL[s.think] ? t(THINK_LABEL[s.think]) : s.think} / {s.numCtx ? formatTokens(s.numCtx) : t('common.default')}</code></div>
          <div><span>{t('session.web')}</span><code>{t(s.web ? 'common.on' : 'common.off')}</code></div>
          {!s.tools && <div className="hint">{t('session.noTools')}</div>}
        </>
      ) : (
        <div className="muted">{t('session.none')}</div>
      )}
      {stats && (
        <>
          {stats.contextMax ? (
            <Meter
              label={t('session.context')}
              value={stats.contextUsed / stats.contextMax}
              text={`${formatTokens(stats.contextUsed)} / ${formatTokens(stats.contextMax)}`}
              title={t('session.contextHint')}
            />
          ) : (
            <div><span>{t('session.context')}</span><code>{stats.contextUsed.toLocaleString()} tok</code></div>
          )}
          {stats.tokensPerSec != null && <div><span>{t('session.speed')}</span><code>{stats.tokensPerSec.toFixed(1)} tok/s</code></div>}
        </>
      )}
      {s && <TodoList todos={latestTodos(tab)} />}
      {s && (
        <button
          className="small"
          disabled={!canCompact}
          onClick={onCompact}
          title={t('session.compactHint')}
        >
          {t('session.compact')}
        </button>
      )}
    </div>
  );
}

const TODO_MARK = { completed: '☑', in_progress: '▶', pending: '☐' } as const;

/** The model's checklist for the current task (from its TodoWrite calls). */
export function TodoList({ todos }: { todos?: Todo[] }) {
  if (!todos?.length) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className="todos">
      <div className="muted">{t('session.todos', { done, total: todos.length })}</div>
      <ul>
        {todos.map((todo, i) => (
          <li key={i} className={todo.status}>
            <span className="mark">{TODO_MARK[todo.status]}</span> {todo.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Meter({ label, value, text, title }: { label: string; value: number; text: string; title?: string }) {
  const pct = Math.min(100, Math.round(value * 100));
  return (
    <div className="meter" title={title}>
      <span>{label}</span>
      <div className={`bar ${pct >= 80 ? 'high' : ''}`}><div style={{ width: `${pct}%` }} /></div>
      <code>{text}</code>
    </div>
  );
}

/** Capability tags and size of the selected model. */
export function ModelCaps({ model }: { model?: ModelInfo }) {
  if (!model) return null;
  const caps = new Set(model.capabilities);
  return (
    <div className="caps">
      <span className={`cap ${caps.has('tools') ? 'on' : 'off'}`} title={t('caps.toolsHint')}>
        {t(caps.has('tools') ? 'caps.tools' : 'caps.noTools')}
      </span>
      {caps.has('thinking') && <span className="cap on" title={t('caps.thinkingHint')}>{t('caps.thinking')}</span>}
      {caps.has('vision') && <span className="cap on" title={t('caps.visionHint')}>{t('caps.vision')}</span>}
      <span className="muted">
        {[model.parameterSize, model.quantization, formatBytes(model.size), model.contextLength && t('caps.maxCtx', { ctx: formatTokens(model.contextLength) })]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </div>
  );
}

export function OllamaPanel({ ollama, loaded, onRefresh }: { ollama?: OllamaStatus; loaded: LoadedModel[]; onRefresh: () => void }) {
  const level = !ollama ? 'warn' : ollama.error ? 'ng' : 'ok';
  return (
    <div className={`ollama ${level}`}>
      <div className="ollama-head">
        <span>Ollama</span>
        <b title={ollama?.error ? tx(ollama.error) : ollama?.url}>{!ollama ? t('ollama.checking') : ollama.error ? t('ollama.unreachable') : `v${ollama.version}`}</b>
        <button className="small" onClick={onRefresh}>{t('common.refresh')}</button>
      </div>
      {ollama?.error && <div className="hint">{tx(ollama.error)}</div>}
      {ollama && !ollama.error && (
        <>
          <div className="muted">{ollama.url}</div>
          <div className="loaded">
            <div className="muted">{t('ollama.loaded')}</div>
            {loaded.length === 0 && <div className="muted">{t('ollama.noneLoaded')}</div>}
            {loaded.map((m) => (
              <div key={m.name} className="loaded-row" title={`${m.name}\nVRAM ${formatBytes(m.sizeVram)} / ${formatBytes(m.size)}${m.expiresAt ? `\n${t('ollama.expires', { time: new Date(m.expiresAt).toLocaleTimeString() })}` : ''}`}>
                <code>{m.name}</code>
                <span className="muted">
                  {formatBytes(m.size)}
                  {m.contextLength ? ` · ctx ${formatTokens(m.contextLength)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
