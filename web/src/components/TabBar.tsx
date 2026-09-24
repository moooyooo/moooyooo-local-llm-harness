import { useState } from 'react';
import { pendingPermissions, tabCwd, tabLabel, tabStatus, type State, type TabStatus } from '../state';
import { PermissionCard } from './Transcript';

const STATUS_LABEL: Record<TabStatus, string> = {
  permission: '許可待ち',
  busy: '応答中',
  idle: '待機中',
  stopped: '未開始 / 停止',
};

export function TabBar({ state, onActivate, onClose, onNew, onPermission }: {
  state: State;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onNew: () => void;
  onPermission: (key: string, id: string, allow: boolean) => void;
}) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const inbox = state.tabs.flatMap((tab) => pendingPermissions(tab).map((item) => ({ tab, item })));

  return (
    <div className="tabbar">
      <div className="tabs" role="tablist">
        {state.tabs.map((tab) => {
          const status = tabStatus(tab);
          return (
            <div
              key={tab.key}
              role="tab"
              aria-selected={tab.key === state.activeKey}
              className={`tab ${tab.key === state.activeKey ? 'active' : ''}`}
              title={[tabCwd(state, tab), tab.session?.model, STATUS_LABEL[status]].filter(Boolean).join('\n')}
              onClick={() => onActivate(tab.key)}
              onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
            >
              <span className={`dot st-${status} ${tab.unread ? 'unread' : ''}`} />
              <span className="tab-label">{tabLabel(state, tab)}</span>
              <button
                className="tab-close"
                title="タブを閉じる（セッションは終了します）"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.key);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <button className="tab-new" title="新しいタブ" onClick={onNew}>＋</button>
      </div>

      <div className="inbox-wrap">
        <button className={`inbox-btn ${inbox.length ? 'has' : ''}`} onClick={() => setInboxOpen(!inboxOpen)}>
          許可待ち <b>{inbox.length}</b>
        </button>
        {inboxOpen && (
          <div className="inbox">
            <div className="inbox-head">
              <b>許可の受信箱</b>
              <button className="small" onClick={() => setInboxOpen(false)}>閉じる</button>
            </div>
            {inbox.length === 0 && <div className="muted">許可待ちはありません</div>}
            {inbox.map(({ tab, item }) => (
              <div key={`${tab.key}:${item.id}`} className="inbox-item">
                <button className="link" onClick={() => onActivate(tab.key)}>{tabLabel(state, tab)} を開く</button>
                <PermissionCard item={item} compact onPermission={(id, allow) => onPermission(tab.key, id, allow)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
