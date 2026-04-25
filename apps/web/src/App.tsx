import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { Inbox } from './pages/Inbox';
import { Cash } from './pages/Cash';
import { Pipeline } from './pages/Pipeline';
import { Utilization } from './pages/Utilization';
import { Projects } from './pages/Projects';
import { Clients } from './pages/Clients';
import { Actions } from './pages/Actions';
import { Integrations } from './pages/Integrations';
import { api } from './lib/api';
import type { InboxResp, ActionsResp } from './lib/types';

export type PageId =
  | 'inbox' | 'cash' | 'pipeline' | 'utilization' | 'projects' | 'clients' | 'actions' | 'integrations';

export function App() {
  const [page, setPage] = useState<PageId>('inbox');
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [actionsCount, setActionsCount] = useState<number | null>(null);

  // top-of-app counts for sidebar badges. Polled cheaply.
  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const [inbox, actions] = await Promise.all([
          api<InboxResp>('/inbox'),
          api<ActionsResp>('/actions?status=open'),
        ]);
        if (cancelled) return;
        setInboxCount(inbox.events.length);
        setActionsCount(actions.stats.open);
      } catch {
        /* ignore — surface elsewhere */
      }
    }
    pull();
    const t = setInterval(pull, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [page]);

  return (
    <div className="shell">
      <Sidebar page={page} setPage={setPage} inboxCount={inboxCount} actionsCount={actionsCount} />
      <main className="main">
        {page === 'inbox' && <Inbox />}
        {page === 'cash' && <Cash />}
        {page === 'pipeline' && <Pipeline />}
        {page === 'utilization' && <Utilization />}
        {page === 'projects' && <Projects />}
        {page === 'clients' && <Clients />}
        {page === 'actions' && <Actions />}
        {page === 'integrations' && <Integrations />}
      </main>
    </div>
  );
}
