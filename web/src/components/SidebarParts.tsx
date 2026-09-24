import type { LoadedModel, ModelInfo, OllamaStatus } from '../../../shared/protocol';
import type { Tab } from '../state';
import { formatBytes, formatTokens } from '../util';

const THINK_LABEL: Record<string, string> = { '': '既定', on: 'オン', off: 'オフ', low: 'low', medium: 'medium', high: 'high' };

export function SessionPanel({ tab, onCompact }: { tab: Tab; onCompact: () => void }) {
  const s = tab.session;
  const stats = tab.stats;
  const canCompact = tab.running && !tab.busy && tab.items.some((it) => it.kind === 'user');
  return (
    <div className="session">
      {s ? (
        <>
          <div>
            <span>Session</span>
            <code className="copyable" title={`${s.sessionId}（クリックでコピー）`} onClick={() => navigator.clipboard?.writeText(s.sessionId)}>
              {s.sessionId.slice(0, 8)}…
            </code>
          </div>
          <div><span>Model</span><code title={s.model}>{s.model}</code></div>
          <div><span>Mode</span><code>{s.permissionMode}</code></div>
          <div><span>思考 / num_ctx</span><code>{THINK_LABEL[s.think] ?? s.think} / {s.numCtx ? formatTokens(s.numCtx) : '既定'}</code></div>
          {!s.tools && <div className="hint">ツール非対応のモデル（会話のみ）</div>}
        </>
      ) : (
        <div className="muted">セッションなし</div>
      )}
      {stats && (
        <>
          {stats.contextMax ? (
            <Meter
              label="コンテキスト"
              value={stats.contextUsed / stats.contextMax}
              text={`${formatTokens(stats.contextUsed)} / ${formatTokens(stats.contextMax)}`}
              title="最後のモデル呼び出しで使ったトークン数。80% を超えそうになると、古いやり取りを自動で要約します"
            />
          ) : (
            <div><span>コンテキスト</span><code>{stats.contextUsed.toLocaleString()} tok</code></div>
          )}
          {stats.tokensPerSec != null && <div><span>生成速度</span><code>{stats.tokensPerSec.toFixed(1)} tok/s</code></div>}
        </>
      )}
      {s && (
        <button
          className="small"
          disabled={!canCompact}
          onClick={onCompact}
          title="古いやり取りをモデルに要約させて、コンテキストを空けます。直近のやり取りはそのまま残ります"
        >
          会話を要約
        </button>
      )}
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
      <span className={`cap ${caps.has('tools') ? 'on' : 'off'}`} title="ツール呼び出し（ファイル操作・コマンド実行）">
        {caps.has('tools') ? 'ツール' : 'ツールなし'}
      </span>
      {caps.has('thinking') && <span className="cap on" title="思考（reasoning）">思考</span>}
      {caps.has('vision') && <span className="cap on" title="画像入力（貼り付け・ドロップ・「画像」ボタンで添付できます）">画像</span>}
      <span className="muted">
        {[model.parameterSize, model.quantization, formatBytes(model.size), model.contextLength && `最大 ${formatTokens(model.contextLength)}`]
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
        <b title={ollama?.error ?? ollama?.url}>{!ollama ? '確認中…' : ollama.error ? '接続できません' : `v${ollama.version}`}</b>
        <button className="small" onClick={onRefresh}>更新</button>
      </div>
      {ollama?.error && <div className="hint">{ollama.error}</div>}
      {ollama && !ollama.error && (
        <>
          <div className="muted">{ollama.url}</div>
          <div className="loaded">
            <div className="muted">メモリ上のモデル</div>
            {loaded.length === 0 && <div className="muted">なし（最初のメッセージで読み込まれます）</div>}
            {loaded.map((m) => (
              <div key={m.name} className="loaded-row" title={`${m.name}\nVRAM ${formatBytes(m.sizeVram)} / ${formatBytes(m.size)}${m.expiresAt ? `\n解放予定 ${new Date(m.expiresAt).toLocaleTimeString()}` : ''}`}>
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
