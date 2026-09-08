import "@testing-library/jest-dom/vitest";

globalThis.ResizeObserver ??= class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

Element.prototype.scrollIntoView ??= function scrollIntoView() {};
