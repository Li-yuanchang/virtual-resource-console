declare module "@novnc/novnc" {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: Record<string, string>;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    scaleViewport: boolean;
    clipViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    disconnect(): void;
    focus(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code?: string, down?: boolean): void;
    clipboardPasteFrom(text: string): void;
  }
}
