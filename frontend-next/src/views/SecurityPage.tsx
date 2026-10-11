'use client';

import { Activity, Users } from 'lucide-react';
import { TabbedView } from '@/components/TabbedView';
import PeoplePage from '@/views/PeoplePage';
import EventsPage from '@/views/EventsPage';

const tabs = [
  { value: 'people', label: 'People', icon: Users },
  { value: 'logs', label: 'Detection history', icon: Activity },
];

export default function SecurityPage() {
  return (
    <TabbedView
      title="Security"
      description="Recognized people, visitor activity, and the detection history behind each decision."
      tabs={tabs}
      defaultTab="people"
    >
      {(tab) => (tab === 'logs' ? <EventsPage embedded /> : <PeoplePage />)}
    </TabbedView>
  );
}
