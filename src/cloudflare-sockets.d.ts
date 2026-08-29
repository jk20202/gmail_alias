// 声明 Cloudflare Sockets Runtime API (connect)
// 仅用于本地 tsc 类型检查;运行时由 Workers 运行时直接提供,无需打包进产物。
// 需 compatibility_date >= 2024-09-23(已在 wrangler.toml 配置)。
// 参考: https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/
declare module 'cloudflare:sockets' {
  export interface SocketAddress {
    hostname: string;
    port: number;
  }
  export interface SocketOptions {
    secureTransport?: 'off' | 'on' | 'starttls';
    allowHalfOpen?: boolean;
  }
  export interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    opened: Promise<void>;
    closed: Promise<void>;
    close(): Promise<void>;
    startTls(): Socket;
  }
  export function connect(address: string | SocketAddress, options?: SocketOptions): Socket;
}
