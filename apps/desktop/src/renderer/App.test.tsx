// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

const info = {
  schemaVersion: 1 as const,
  name: 'Mona' as const,
  version: '0.1.0',
  electron: '45.3.0',
  chrome: '140.0.0',
  node: '24.0.0',
  platform: 'win32',
  arch: 'x64',
  engine: { status: 'not_started' as const, detail: 'No runtime yet.', descriptors: [] as string[] },
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.mona = { getAppInfo: async () => ({ ok: true, data: info }) };
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
});

describe('Mona renderer', () => {
  it('shows the real app version and placeholder navigation', async () => {
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[data-testid="app-version"]')?.textContent).toBe('v0.1.0');
    expect(Array.from(document.querySelectorAll('[data-testid^="nav-"]')).map((node) => node.textContent)).toEqual([
      'Projects',
      'Work',
      'Cost',
      'Settings',
    ]);
    expect(document.body.textContent).not.toContain('mona.fixture.test-only');
    expect(document.querySelector('[data-testid="engine-state"]')?.textContent).toBe('Engine not connected');
    await act(async () => {
      root.unmount();
    });
  });

  it('renders a bridge error instead of pretending the engine is ready', async () => {
    window.mona = {
      getAppInfo: async () => ({
        ok: false,
        error: { code: 'untrusted_sender', message: 'IPC sender is not trusted.', retryable: false },
      }),
    };
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('IPC sender is not trusted.');
    await act(async () => {
      root.unmount();
    });
  });

  it('switches theme without any network call', async () => {
    const container = document.getElementById('root');
    if (!container) throw new Error('missing root');
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const toggle = Array.from(document.querySelectorAll('button')).find((node) => node.textContent === 'Afterglow');
    if (!toggle) throw new Error('theme toggle missing');
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.documentElement.dataset.theme).toBe('afterglow');
    await act(async () => {
      root.unmount();
    });
  });
});
