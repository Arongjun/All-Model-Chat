import { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../../contexts/I18nContext';
import { useSettingsStore } from '../../../stores/settingsStore';
import { AboutSection } from './AboutSection';

describe('AboutSection', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initialState = useSettingsStore.getState();
  const packageVersion = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
  ).version as string;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useSettingsStore.setState(initialState);
  });

  it('updates translated copy from the global i18n context', async () => {
    await act(async () => {
      useSettingsStore.setState({ language: 'en' });
      root.render(
        <I18nProvider>
          <AboutSection />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Arong AI Station');
    expect(container.textContent).toContain('Local build');

    act(() => {
      useSettingsStore.setState({ language: 'zh' });
    });

    expect(container.textContent).toContain('阿荣AI工作站');
    expect(container.textContent).toContain('当前版本');
  });

  it('mirrors the package version without external repository links', async () => {
    await act(async () => {
      useSettingsStore.setState({ language: 'zh' });
      root.render(
        <I18nProvider>
          <AboutSection />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain(`v${packageVersion}`);
    expect(container.querySelector('a[href*="github.com"]')).toBeNull();
    expect(container.textContent).not.toContain('GitHub');
    expect(container.textContent).not.toContain('星标');
  });

  it('does not render the manual update check controls in the about panel', async () => {
    await act(async () => {
      useSettingsStore.setState({ language: 'zh' });
      root.render(
        <I18nProvider>
          <AboutSection />
        </I18nProvider>,
      );
    });

    const checkButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('检查更新'),
    );

    expect(checkButton).toBeUndefined();
    expect(container.textContent).not.toContain('检查更新');
    expect(container.textContent).not.toContain('已是最新');
    expect(container.textContent).not.toContain('发现可用更新');
    expect(container.textContent).not.toContain('暂时无法检查更新');
  });
});
