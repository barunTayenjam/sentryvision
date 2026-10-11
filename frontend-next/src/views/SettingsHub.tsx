'use client';

import { FileText, SlidersHorizontal } from 'lucide-react';
import { TabbedView } from '@/components/TabbedView';
import SettingsPage from '@/views/Settings';
import LogsPage from '@/views/LogsPage';

const tabs = [
  { value: 'configuration', label: 'Configuration', icon: SlidersHorizontal },
  { value: 'logs', label: 'System logs', icon: FileText },
];

export default function SettingsHub() {
  return (
    <TabbedView
      title="Settings"
      description="Configure detection, notifications, storage, and system access."
      tabs={tabs}
      defaultTab="configuration"
    >
      {(tab) => (tab === 'logs' ? <LogsPage /> : <SettingsPage />)}
    </TabbedView>
  );
}
