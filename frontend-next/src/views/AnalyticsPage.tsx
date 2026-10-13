'use client';

import { BarChart3, Film } from 'lucide-react';
import { TabbedView } from '@/components/TabbedView';
import InsightsPage from '@/views/InsightsPage';
import TimelapsePage from '@/views/TimelapsePage';

const tabs = [
  { value: 'overview', label: 'Overview', icon: BarChart3 },
  { value: 'timelapse', label: 'Timelapse', icon: Film },
];

export default function AnalyticsPage() {
  return (
    <TabbedView
      title="Analytics"
      description="Daily activity, threat patterns, and time-lapse review across your cameras."
      tabs={tabs}
      defaultTab="overview"
    >
      {(tab) => (tab === 'timelapse' ? <TimelapsePage /> : <InsightsPage />)}
    </TabbedView>
  );
}
