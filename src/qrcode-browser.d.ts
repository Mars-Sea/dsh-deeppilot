declare module 'qrcode/lib/browser.js' {
  import type { QRCodeToStringOptions } from 'qrcode'

  export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>
}
