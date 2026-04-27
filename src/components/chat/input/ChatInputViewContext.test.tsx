import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChatInputViewProvider,
  useChatInputActionsView,
  useChatInputLayoutView,
} from './ChatInputViewContext';

const render = async (node: React.ReactNode) => {
  const container = document.createElement('div');
  const root = createRoot(container);

  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });

  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    },
  };
};

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }

  render() {
    if (this.state.error) {
      return <div data-testid="boundary-error">{this.state.error}</div>;
    }

    return this.props.children;
  }
}

describe('ChatInputViewContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requires the provider before chat input view hooks can be used', async () => {
    const Consumer = () => {
      useChatInputActionsView();
      return null;
    };

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container, unmount } = await render(
      <ErrorBoundary>
        <Consumer />
      </ErrorBoundary>,
    );

    expect(container.querySelector('[data-testid="boundary-error"]')?.textContent).toBe(
      'useChatInputView must be used within ChatInputViewProvider',
    );

    await unmount();
  });

  it('provides focused view slices to chat input children', async () => {
    const value = {
      toolbarProps: {} as any,
      actionsProps: {
        canSend: true,
        isLoading: false,
      },
      slashCommandProps: {} as any,
      fileDisplayProps: {} as any,
      inputProps: {} as any,
      layoutProps: {
        isFullscreen: true,
        isPipActive: false,
        isAnimatingSend: false,
        isMobile: false,
        initialTextareaHeight: 28,
        isConverting: false,
      },
      fileInputs: {} as any,
      formProps: {} as any,
      themeId: 'onyx',
    } as any;

    const Consumer = () => {
      const actions = useChatInputActionsView();
      const layout = useChatInputLayoutView();

      return (
        <div>
          <span data-testid="can-send">{String(actions.canSend)}</span>
          <span data-testid="fullscreen">{String(layout.isFullscreen)}</span>
        </div>
      );
    };

    const { container, unmount } = await render(
      <ChatInputViewProvider value={value}>
        <Consumer />
      </ChatInputViewProvider>,
    );

    expect(container.querySelector('[data-testid="can-send"]')?.textContent).toBe('true');
    expect(container.querySelector('[data-testid="fullscreen"]')?.textContent).toBe('true');

    await unmount();
  });
});
