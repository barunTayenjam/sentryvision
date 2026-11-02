'use client';

import { useEffect, useState } from 'react';
import { eventService } from '@/services/api/eventService';
import { cn } from '@/lib/utils';

interface ThreatCounts {
  persons: number;
  vehicles: number;
  animals: number;
  motion: number;
  jevUrgent: number;
}

export const ThreatMatrix = () => {
  const [counts, setCounts] = useState<ThreatCounts>({
    persons: 0,
    vehicles: 0,
    animals: 0,
    motion: 0,
    jevUrgent: 0,
  });
  const [loading, setLoading] = useState(true);
  // A failed fetch must read as UNKNOWN, never as zero — zeros here would
  // fake an "all clear" on a security dashboard.
  const [failed, setFailed] = useState<Record<'persons' | 'vehicles' | 'jev', boolean>>({
    persons: false,
    vehicles: false,
    jev: false,
  });

  useEffect(() => {
    const fetchCounts = async () => {
      // Query exactly the window the label advertises.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const [personsRes, vehiclesRes, jevRes] = await Promise.allSettled([
        eventService.getEnhancedEventsList({ event_type: 'person', pageSize: 1, start_date: since }),
        eventService.getEnhancedEventsList({ event_type: 'vehicle', pageSize: 1, start_date: since }),
        eventService.getEnhancedEventsList({ jev_urgent: true, pageSize: 1, start_date: since }),
      ]);

      const persons =
        personsRes.status === 'fulfilled' ? personsRes.value.pagination?.totalEvents || 0 : 0;
      const vehicles =
        vehiclesRes.status === 'fulfilled' ? vehiclesRes.value.pagination?.totalEvents || 0 : 0;
      const jevUrgent =
        jevRes.status === 'fulfilled' ? jevRes.value.pagination?.totalEvents || 0 : 0;

      setCounts({ persons, vehicles, animals: 0, motion: 0, jevUrgent });
      setFailed({
        persons: personsRes.status === 'rejected',
        vehicles: vehiclesRes.status === 'rejected',
        jev: jevRes.status === 'rejected',
      });
      setLoading(false);
    };

    fetchCounts();
    const interval = setInterval(fetchCounts, 30000);
    return () => clearInterval(interval);
  }, []);

  const threats: Array<{
    label: string;
    count: number | null;
    color: string;
    bg: string;
    border: string;
  }> = [
    { label: 'PERSON', count: failed.persons ? null : counts.persons, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20' },
    { label: 'VEHICLE', count: failed.vehicles ? null : counts.vehicles, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20' },
    { label: 'JEV URGENT', count: failed.jev ? null : counts.jevUrgent, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
    { label: 'ANIMAL', count: counts.animals, color: 'text-green-400', bg: 'bg-green-500/10', border: 'border-green-500/20' },
    { label: 'MOTION', count: counts.motion, color: 'text-muted-foreground', bg: 'bg-white/[0.06]', border: 'border-white/[0.10]' },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-[0.15em] font-medium text-muted-foreground">
          Threat Matrix
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          Last 24h{Object.values(failed).some(Boolean) ? ' · live data unavailable' : ''}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {threats.map((threat) => (
          <div
            key={threat.label}
            className={cn(
              'rounded-lg border p-3 text-center',
              threat.bg,
              threat.border,
            )}
          >
            <div className={cn('text-2xl font-semibold tabular-nums', threat.color)}>
              {loading || threat.count === null ? '--' : threat.count}
            </div>
            <div className="text-xs uppercase tracking-[0.1em] text-muted-foreground mt-1">
              {threat.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
