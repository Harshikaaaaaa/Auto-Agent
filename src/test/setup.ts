import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * jsdom does not implement several browser APIs that React Flow and the
 * workflow runtime depend on. Polyfill them once, here, so component tests
 * exercise real component code instead of failing on environment gaps.
 */

// React Flow measures node/pane dimensions via ResizeObserver.
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// React Flow's transform maths uses DOMMatrix.
if (!('DOMMatrixReadOnly' in globalThis)) {
  class DOMMatrixReadOnlyStub {
    m22 = 1;
    constructor(_transform?: string) {}
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
}

if (!('matchMedia' in globalThis)) {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jsdom lacks these element geometry helpers that React Flow reads.
if (typeof Element !== 'undefined') {
  const elementProto = Element.prototype as unknown as Record<string, unknown>;
  if (typeof elementProto.getBoundingClientRect !== 'function') {
    elementProto.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        top: 0,
        right: 800,
        bottom: 600,
        left: 0,
      } as DOMRect;
    };
  }
  if (typeof elementProto.scrollIntoView !== 'function') {
    elementProto.scrollIntoView = () => {};
  }
}

// crypto.randomUUID is used for run ids and node ids.
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...globalThis.crypto,
      randomUUID: () => '00000000-0000-4000-8000-000000000000',
      getRandomValues: (arr: Uint8Array) => arr.fill(1),
    },
  });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
