import React, { Suspense, lazy, useEffect } from 'react';
import { HistorySidebar } from '../sidebar/HistorySidebar';
import { ChatArea } from './ChatArea';
import { AppModals } from '../modals/AppModals';
import type { AppViewModel } from '../../hooks/app/useApp';
import { useMainContentViewModel } from './useMainContentViewModel';
import { useWindowContext } from '../../contexts/WindowContext';

const LazySidePanel = lazy(async () => {
  const module = await import('./SidePanel');
  return { default: module.SidePanel };
});

interface MainContentProps {
  app: AppViewModel;
}

export const MainContent: React.FC<MainContentProps> = ({ app }) => {
  const { document: targetDocument } = useWindowContext();
  const {
    chatArea,
    sidebarProps,
    appModalsProps,
    sidePanelContent,
    handleCloseSidePanel,
    sidePanelKey,
    overlayVisible,
    currentThemeId,
    closeHistorySidebar,
  } = useMainContentViewModel({ app });

  useEffect(() => {
    const targetWindow = targetDocument.defaultView;
    if (!targetWindow) {
      return;
    }

    const syncBrowserChromeColor = () => {
      const computedRoot = targetWindow.getComputedStyle(targetDocument.documentElement);
      const computedBody = targetWindow.getComputedStyle(targetDocument.body);
      const backgroundColor =
        computedRoot.getPropertyValue('--theme-bg-primary').trim() ||
        computedBody.backgroundColor ||
        '#ffffff';
      const isDarkTheme = currentThemeId === 'onyx';

      let themeColorMeta = targetDocument.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!themeColorMeta && targetDocument.head) {
        themeColorMeta = targetDocument.createElement('meta');
        themeColorMeta.name = 'theme-color';
        targetDocument.head.appendChild(themeColorMeta);
      }
      themeColorMeta?.setAttribute('content', backgroundColor);

      targetDocument
        .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]')
        ?.setAttribute('content', isDarkTheme ? 'black-translucent' : 'default');

      targetDocument.documentElement.style.backgroundColor = backgroundColor;
      targetDocument.body.style.backgroundColor = backgroundColor;
      targetDocument.getElementById('root')?.style.setProperty('background-color', backgroundColor);
    };

    syncBrowserChromeColor();
    const frameId = targetWindow.requestAnimationFrame(syncBrowserChromeColor);
    const timeoutId = targetWindow.setTimeout(syncBrowserChromeColor, overlayVisible ? 80 : 180);

    return () => {
      targetWindow.cancelAnimationFrame(frameId);
      targetWindow.clearTimeout(timeoutId);
    };
  }, [currentThemeId, overlayVisible, targetDocument]);

  return (
    <>
      <div
        onClick={closeHistorySidebar}
        className={`fixed inset-0 z-40 bg-transparent transition-opacity duration-300 md:hidden ${
          overlayVisible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden="true"
      />

      <HistorySidebar {...sidebarProps} />
      <ChatArea chatArea={chatArea} />

      {sidePanelContent && (
        <Suspense fallback={null}>
          <LazySidePanel
            key={sidePanelKey}
            content={sidePanelContent}
            onClose={handleCloseSidePanel}
            themeId={currentThemeId}
          />
        </Suspense>
      )}

      <AppModals {...appModalsProps} />
    </>
  );
};
