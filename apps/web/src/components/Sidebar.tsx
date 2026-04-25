import type { PageId } from '../App';

export function Sidebar({
  page,
  setPage,
  inboxCount,
  actionsCount,
}: {
  page: PageId;
  setPage: (p: PageId) => void;
  inboxCount: number | null;
  actionsCount: number | null;
}) {
  const item = (id: PageId, label: string, badge?: React.ReactNode) => (
    <div
      className={`nav-item ${page === id ? 'on' : ''}`}
      onClick={() => setPage(id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setPage(id)}
    >
      <span>{label}</span>
      {badge !== undefined && <span className={`badge ${id === 'inbox' && inboxCount && inboxCount > 0 ? 'alert' : ''}`}>{badge}</span>}
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="mark">Linkbook</div>
        <div className="studio">Flight Design Co.</div>
      </div>

      <nav className="nav-scroll">
        {item('inbox', 'Inbox', inboxCount ?? '·')}

        <div className="nav-section">Overview</div>
        {item('cash', 'Cash')}
        {item('pipeline', 'Pipeline')}
        {item('utilization', 'Utilization')}
        {item('projects', 'Projects')}
        {item('clients', 'Clients')}

        <div className="nav-section">Queue</div>
        {item('actions', 'Actions', actionsCount ?? '·')}

        <div className="nav-section">Settings</div>
        {item('integrations', 'Integrations')}
      </nav>

      <div className="sidebar-foot">
        <div className="av">N</div>
        <div className="who">Neel</div>
      </div>
    </aside>
  );
}
