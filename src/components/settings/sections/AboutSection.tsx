import React from 'react';
import { useI18n } from '../../../contexts/I18nContext';
import { AppLogo } from '../../icons/AppLogo';
import { useResponsiveValue } from '../../../hooks/useDevice';
import packageJson from '../../../../package.json';

export const AboutSection: React.FC = () => {
  const { t } = useI18n();
  const isCompactViewport = useResponsiveValue(true, false, 900);
  const currentVersion = packageJson.version;

  return (
    <div
      className={`flex min-h-full flex-col items-center px-4 text-center animate-in fade-in slide-in-from-bottom-4 duration-500 ${isCompactViewport ? 'py-2.5' : 'py-3 sm:py-4 md:py-5'}`}
    >
      <div className="relative">
        <div className="absolute -inset-5 rounded-full bg-[radial-gradient(circle_at_center,_rgba(0,229,255,0.22),_transparent_68%)] blur-xl" />
        <div className="relative">
          <AppLogo
            className={`h-auto drop-shadow-2xl ${isCompactViewport ? 'w-32' : 'w-40 sm:w-44 md:w-52'}`}
            ariaLabel={t('about_logo_alt')}
          />
        </div>
      </div>

      <div className={`flex max-w-lg flex-col items-center ${isCompactViewport ? 'mt-3 space-y-3.5' : 'mt-4 space-y-4 sm:mt-5 sm:space-y-5'}`}>
        <h3 className={`font-bold tracking-tight text-[var(--theme-text-primary)] ${isCompactViewport ? 'text-[1.75rem]' : 'text-2xl'}`}>
          {t('about_title')}
        </h3>

        <div className="relative inline-flex items-center justify-center overflow-hidden rounded-full p-[1px]">
          <span className="absolute inset-0 bg-gradient-to-r from-cyan-400 via-emerald-400 to-blue-500 opacity-80" />
          <span
            className={`relative flex items-center gap-3 rounded-full bg-[var(--theme-bg-primary)] px-4 sm:px-5 ${isCompactViewport ? 'py-1' : 'py-1.5'}`}
          >
            <span className="font-mono text-sm font-bold text-[var(--theme-text-primary)]">v{currentVersion}</span>
            <span className="h-3.5 w-px bg-[var(--theme-border-secondary)] opacity-50" />
            <span className="flex items-center gap-2 text-xs font-medium text-[var(--theme-text-secondary)]">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {t('about_local_version')}
            </span>
          </span>
        </div>

        <p className={`max-w-md text-sm text-[var(--theme-text-secondary)] ${isCompactViewport ? 'leading-5' : 'leading-6'}`}>
          {t('about_description')}
        </p>
      </div>
    </div>
  );
};
