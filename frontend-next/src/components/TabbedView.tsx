'use client';

import { ReactNode, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUrlSearchParams } from '@/hooks/useUrlSearchParams';
import { SectionWorkspace, SectionTab } from '@/components/layout/SectionWorkspace';

export interface TabbedViewProps {
  title: string;
  description: string;
  tabs: SectionTab[];
  defaultTab?: string;
  children: (activeTab: string) => ReactNode;
}

export function TabbedView({ title, description, tabs, defaultTab, children }: TabbedViewProps) {
  const searchParams = useUrlSearchParams();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const fallbackTab = defaultTab ?? tabs[0]?.value ?? '';
  const viewParam = searchParams.get('view');
  const activeTab =
    viewParam && tabs.some((t) => t.value === viewParam) ? viewParam : fallbackTab;

  const handleTabChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams);
      if (value === fallbackTab) next.delete('view');
      else next.set('view', value);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams, fallbackTab],
  );

  return (
    <SectionWorkspace
      title={title}
      description={description}
      tabs={tabs}
      defaultTab={activeTab}
      onTabChange={handleTabChange}
    >
      {children}
    </SectionWorkspace>
  );
}
