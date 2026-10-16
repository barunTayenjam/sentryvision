'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'framer-motion';
import {
  BarChart3,
  Bell,
  LogOut,
  MessageSquare,
  Radio,
  Settings,
  Shield,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuthStore } from '@/stores/auth';
import { useCameraStore } from '@/stores/camera';
import { useSocketStore } from '@/stores/socket';
import { ShortcutHelp } from '@/components/layout/ShortcutHelp';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', label: 'Dashboard', shortLabel: 'Home', icon: Radio },
  { href: '/events', label: 'Events', shortLabel: 'Events', icon: Bell },
  { href: '/security', label: 'Security', shortLabel: 'Security', icon: Shield },
  { href: '/analytics', label: 'Analytics', shortLabel: 'Analytics', icon: BarChart3 },
  { href: '/ask', label: 'Assistant', shortLabel: 'Ask', icon: MessageSquare },
  { href: '/settings', label: 'Settings', shortLabel: 'Settings', icon: Settings },
];

function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SystemStatus() {
  const connected = useSocketStore((state) => state.connected);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider',
        connected
          ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
          : 'border-zinc-500/20 bg-zinc-500/10 text-zinc-400',
      )}
    >
      <span className={cn('h-1 w-1 rounded-full', connected ? 'bg-emerald-300' : 'bg-zinc-500')} />
    </span>
  );
}

function Clock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
    update();
    const id = window.setInterval(update, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className="hidden font-mono text-[10px] tabular-nums text-muted-foreground xl:inline">
      {time}
    </span>
  );
}

function UserMenu({ onLogout }: { onLogout: () => void }) {
  const user = useAuthStore((state) => state.user);
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold uppercase text-[#aeb7f2] transition-colors hover:bg-primary/30"
          aria-label="User menu"
        >
          {user.username.slice(0, 1)}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-44">
        <div className="border-b border-white/[0.06] px-3 py-2">
          <p className="truncate text-xs font-medium text-foreground">{user.username}</p>
          <p className="text-[10px] capitalize text-muted-foreground">{user.role}</p>
        </div>
        <DropdownMenuItem onSelect={onLogout}>
          <LogOut className="mr-2 h-3.5 w-3.5" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const logout = useAuthStore((state) => state.logout);
  const fetchCameras = useCameraStore((state) => state.fetchCameras);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    void fetchCameras();
  }, [fetchCameras]);

  const handleLogout = useCallback(async () => {
    await logout();
    router.replace('/login');
  }, [logout, router]);

  const dockAnimation = reduceMotion
    ? { duration: 0.01 }
    : { type: 'spring' as const, stiffness: 300, damping: 30 };

  return (
    <div className="flex h-[100dvh] flex-col bg-background text-foreground">
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      <ShortcutHelp />

      <motion.nav
        initial={false}
        animate={{ y: 0 }}
        transition={dockAnimation}
        className="flex h-14 shrink-0 items-center justify-between border-t border-white/[0.06] bg-card px-3 sm:px-6"
        aria-label="Primary navigation"
      >
        <div className="hidden shrink-0 items-center gap-2 md:flex">
          <span className="text-xs font-semibold tracking-tight">SentryVision</span>
          <SystemStatus />
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-center gap-0.5 sm:gap-1">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-11 min-w-[42px] flex-col items-center justify-center gap-0.5 rounded-md px-2 text-[9px] font-medium transition-colors sm:min-w-[64px] sm:px-2.5 sm:text-[10px]',
                  active ? 'text-[#aeb7f2]' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <item.icon className="h-4 w-4" strokeWidth={active ? 2 : 1.5} />
                <span className="hidden sm:inline">{item.shortLabel}</span>
                {active && (
                  <motion.span
                    layoutId="dock-active"
                    className="absolute -top-[7px] h-[3px] w-8 rounded-b-full bg-primary"
                    transition={dockAnimation}
                  />
                )}
              </Link>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-2 md:gap-3">
          <Clock />
          <UserMenu onLogout={handleLogout} />
        </div>
      </motion.nav>
      {/* iOS home-indicator safe area: nav keeps its 56px, inset fills below */}
      <div className="h-[env(safe-area-inset-bottom)] shrink-0 bg-card" aria-hidden="true" />
    </div>
  );
}
