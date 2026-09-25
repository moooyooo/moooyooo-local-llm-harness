import { useState } from 'react';
import type { MessageKey } from '../../../shared/i18n';
import { t } from '../i18n';
import { pendingPermissions, tabCwd, tabLabel, tabStatus, type State, type TabStatus } from '../state';
import { PermissionCard } from './Transcript';

const STATUS_LABEL: Record<TabStatus, MessageKey> = {
  permission: 'tabs.status.permission',
  busy: 'tabs.status.busy',
  idle: 'tabs.status.idle',
  stopped: 'tabs.status.stopped',
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
              title={[tabCwd(state, tab), tab.session?.model, t(STATUS_LABEL[status])].filter(Boolean).join('\n')}
              onClick={() => onActivate(tab.key)}
              onAuxClick={(e) => e.button === 1 && onClose(tab.key)}
            >
              <span className={`dot st-${status} ${tab.unread ? 'unread' : ''}`} />
              <span className="tab-label">{tabLabel(state, tab)}</span>
              <button
                className="tab-close"
                title={t('tabs.close')}
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
        <button className="tab-new" title={t('tabs.new')} onClick={onNew}>＋</button>
      </div>

      <div className="inbox-wrap">
        <button className={`inbox-btn ${inbox.length ? 'has' : ''}`} onClick={() => setInboxOpen(!inboxOpen)}>
          {t('tabs.inbox')} <b>{inbox.length}</b>
        </button>
        {inboxOpen && (
          <div className="inbox">
            <div className="inbox-head">
              <b>{t('tabs.inboxTitle')}</b>
              <button className="small" onClick={() => setInboxOpen(false)}>{t('common.close')}</button>
            </div>
            {inbox.length === 0 && <div className="muted">{t('tabs.inboxEmpty')}</div>}
            {inbox.map(({ tab, item }) => (
              <div key={`${tab.key}:${item.id}`} className="inbox-item">
                <button className="link" onClick={() => onActivate(tab.key)}>{t('tabs.openTab', { name: tabLabel(state, tab) })}</button>
                <PermissionCard item={item} compact onPermission={(id, allow) => onPermission(tab.key, id, allow)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
