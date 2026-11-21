import '../assets/content.css';
import { createRoot } from 'react-dom/client';
import { HudApp } from '../components/HudApp';
import { getLastHoveredSrc, getLastMouse, setupTriggers } from './content/triggers';

/**
 * Cursor-Resident HUD — isolated from the host page via Shadow DOM.
 * Tailwind CSS is injected into the shadow root (cssInjectionMode: 'ui').
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'vrc-hud',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        container.id = 'vrc-hud-container';
        container.style.cssText = 'position:static;display:contents;';
        const root = createRoot(container);
        root.render(<HudApp />);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });
    ui.mount();
    const teardownTriggers = setupTriggers();

    const onRuntimeMessage = (msg: { type?: string; srcUrl?: string }) => {
      if (msg?.type === 'OPEN_HUD') {
        window.dispatchEvent(
          new CustomEvent('vrc:open', {
            detail: {
              srcUrl: msg.srcUrl ?? getLastHoveredSrc(),
              fromAction: !msg.srcUrl,
              x: getLastMouse().x,
              y: getLastMouse().y,
            },
          }),
        );
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    ctx.onInvalidated(() => {
      teardownTriggers();
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    });
  },
});
