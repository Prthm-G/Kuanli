import {
  Crown,
  Shield,
  UserCog,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';

import type { AccountRole } from '@/lib/auth/roles';
import type { ChipVariant } from './settings-chip';

/**
 * Single source of truth for per-role chip metadata across settings
 * surfaces (the Overview identity chip and the Members roster/invite
 * chips). Previously duplicated in both files; hoisted here so a label,
 * icon, or colour change lands once.
 *
 * `variant` drives the token-based <SettingsChip>; `className` is the
 * inline Tailwind string the Members tab applies to its own spans.
 */
export const ROLE_META: Record<
  AccountRole,
  { icon: LucideIcon; label: string; variant: ChipVariant; className: string }
> = {
  owner: {
    icon: Crown,
    label: 'Owner',
    variant: 'owner',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  },
  admin: {
    icon: Shield,
    label: 'Admin',
    variant: 'admin',
    className: 'border-primary/40 bg-primary/10 text-primary',
  },
  agent: {
    icon: UserCog,
    label: 'Counsellor',
    variant: 'muted',
    className: 'border-border bg-muted text-muted-foreground',
  },
  viewer: {
    icon: UserIcon,
    label: 'Viewer',
    variant: 'muted',
    // Outline-only so it stays quieter than the filled Counsellor chip in
    // both modes — bg-card would blend into a card surface in light mode.
    className: 'border-border bg-transparent text-muted-foreground',
  },
};

/**
 * Label for a role value, for the closed role picker. Base UI's
 * `<Select.Value>` shows the raw value ("agent") unless given a renderer:
 * `<SelectValue>{roleLabel}</SelectValue>`. The database value stays `agent`.
 */
export function roleLabel(value: unknown): string {
  return typeof value === 'string' && value in ROLE_META
    ? ROLE_META[value as AccountRole].label
    : String(value ?? '');
}
