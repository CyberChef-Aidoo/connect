import { useEffect, useRef, useState } from 'react';
import { formatBytes } from './format';
import { displayPercent, overallBytes, transferStatusLabel, type TransferActivity } from './transfer';

export type TransferCardModel = {
  id: string;
  filename: string;
  direction: 'upload' | 'download';
  status: TransferActivity;
  totalBytes: number | null;
  transferredBytes: number;
  confirmedBytes: number | null;
  detail: string;
  error: string | null;
  speed: string;
  remaining: string;
  canCancel: boolean;
  canRetry: boolean;
};

export function TransferCards({
  items,
  onCancel,
  onRetry,
}: {
  items: TransferCardModel[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const [live, setLive] = useState('');
  const announced = useRef('');
  const statusKey = items.map((item) => `${item.id}:${item.status}`).join('|');
  const active = items.filter((item) => item.status === 'sending' || item.status === 'downloading' || item.status === 'finishing');
  const overall = overallBytes(active.map((item) => ({
    transferredBytes: item.transferredBytes,
    totalBytes: item.totalBytes,
  })));

  useEffect(() => {
    const next = items
      .filter((item) => item.status !== 'queued')
      .map((item) => `${item.filename}: ${transferStatusLabel(item.status)}`)
      .join('. ');
    if (next && next !== announced.current) {
      announced.current = next;
      setLive(next);
    }
  }, [statusKey, items]);

  if (items.length === 0) return null;
  const overallText = overall.totalBytes === null
    ? `${formatBytes(overall.transferredBytes)} sent. The total size is not known yet.`
    : `${formatBytes(overall.transferredBytes)} of ${formatBytes(overall.totalBytes)}`;

  return (
    <section className="transfer-board" aria-label="Transfers">
      <p className="sr" role="status" aria-live="polite">{live}</p>
      {active.length > 1 ? <p className="meta">Together: {overallText}</p> : null}
      <ul>
        {items.map((item) => {
          const percent = displayPercent(item.transferredBytes, item.totalBytes, item.status === 'completed');
          const amount = item.totalBytes === null
            ? `${formatBytes(item.transferredBytes)} sent`
            : `${formatBytes(item.transferredBytes)} of ${formatBytes(item.totalBytes)}`;
          const confirmed = item.confirmedBytes === null ? '' : `Confirmed ${formatBytes(item.confirmedBytes)}`;
          const line = [transferStatusLabel(item.status), amount, confirmed, item.speed, item.remaining].filter(Boolean).join(' · ');
          return (
            <li key={item.id} className="transfer-card">
              <div className="transfer-head">
                <span className="filename">{item.filename}</span>
                <span className="meta">{transferStatusLabel(item.status)}</span>
              </div>
              <div
                className={percent === null && item.status !== 'completed' ? 'bar unknown' : 'bar'}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={percent === null ? undefined : 100}
                aria-valuenow={percent ?? undefined}
                aria-valuetext={line}
                aria-label={item.filename}
              >
                <span style={percent === null ? undefined : { width: `${percent}%` }} />
              </div>
              <p className="meta">{line}</p>
              {item.detail ? <p className="meta">{item.detail}</p> : null}
              {item.error ? <p className="fail">{item.error}</p> : null}
              <div className="transfer-actions">
                {item.canCancel ? <button type="button" className="ghost" onClick={() => onCancel(item.id)}>Cancel</button> : null}
                {item.canRetry ? <button type="button" className="ghost" onClick={() => onRetry(item.id)}>Try again</button> : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
