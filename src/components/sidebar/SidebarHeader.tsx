
import React from 'react';
import { translations } from '../../utils/translations';
import { AppLogo } from '../icons/AppLogo';
import { IconSidebarToggle } from '../icons/CustomIcons';
import { FOCUS_VISIBLE_RING_PRIMARY_OFFSET_CLASS } from '../../constants/appConstants';

interface SidebarHeaderProps {
  onToggle: () => void;
  isOpen: boolean;
  t: (key: keyof typeof translations) => string;
}

export const SidebarHeader: React.FC<SidebarHeaderProps> = ({ onToggle, isOpen, t }) => (
  <div className="p-2 sm:p-3 flex items-center justify-between flex-shrink-0 h-[60px]">
    <div className="flex items-center gap-2 pl-2">
      <AppLogo className="h-8 w-auto" />
      <span className="text-sm font-semibold text-[var(--theme-text-primary)]">阿荣AI工作站</span>
    </div>
    <button onClick={onToggle} className={`p-2 text-[var(--theme-icon-history)] hover:bg-[var(--theme-bg-tertiary)] rounded-md ${FOCUS_VISIBLE_RING_PRIMARY_OFFSET_CLASS}`} aria-label={isOpen ? t('historySidebarClose') : t('historySidebarOpen')}>
      <IconSidebarToggle size={20} strokeWidth={2} />
    </button>
  </div>
);
