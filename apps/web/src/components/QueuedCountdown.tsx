import { useEffect, useState } from 'react';
import type { ActionRow } from '../lib/types';
import { post } from '../lib/api';

export function QueuedCountdown({ action, onChange }: { action: ActionRow; onChange: () => void }) {
  const queuedUntil = action.queued_until ? new Date(action.queued_until).getTime() : null;
  const [secsLeft, setSecsLeft] = useState<number>(
    queuedUntil ? Math.max(0, Math.ceil((queuedUntil - Date.now()) / 1000)) : 30,
  );

  useEffect(() => {
    if (!queuedUntil) return;
    const t = setInterval(() => {
      const left = Math.max(0, Math.ceil((queuedUntil - Date.now()) / 1000));
      setSecsLeft(left);
      if (left === 0) {
        // poll for the post-execute state
        onChange();
      }
    }, 250);
    return () => clearInterval(t);
  }, [queuedUntil, onChange]);

  async function undo() {
    try {
      await post(`/actions/${action.id}/undo`);
      onChange();
    } catch {
      /* swallow — server may have already executed */
      onChange();
    }
  }

  const pct = Math.round((secsLeft / 30) * 100);

  return (
    <div className="queued">
      <div className="ring" style={{ ['--p' as string]: pct } as React.CSSProperties}>
        <span>{secsLeft}</span>
      </div>
      <div className="msg">
        <b>Sending in {secsLeft}s</b> · once timer elapses, action becomes irreversible
      </div>
      <button className="undo" onClick={undo} disabled={secsLeft === 0}>
        Undo
      </button>
    </div>
  );
}
