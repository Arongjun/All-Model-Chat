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
  <div className="flex h-[60px] flex-shrink-0 items-center justify-between gap-2 px-3 py-2 sm:p-3">
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <AppLogo className="h-7 w-[96px] flex-none sm:h-8 sm:w-[118px]" />
      <span
        className="min-w-0 truncate whitespace-nowrap text-[13px] font-semibold leading-none text-[var(--theme-text-primary)] sm:text-sm"
        title="阿荣AI工作站"
      >
        阿荣AI工作站
      </span>
    </div>
    <button
      type="button"
      onClick={onToggle}
      className={`flex-none rounded-md p-2 text-[var(--theme-icon-history)] hover:bg-[var(--theme-bg-tertiary)] ${FOCUS_VISIBLE_RING_PRIMARY_OFFSET_CLASS}`}
      aria-label={isOpen ? t('historySidebarClose') : t('historySidebarOpen')}
    >
      <IconSidebarToggle size={20} strokeWidth={2} />
    </button>
  </div>
);
