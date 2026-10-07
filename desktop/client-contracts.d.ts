/** v1 ports for future web/standalone hosts; desktop is the implemented adapter. */
export interface Readable<T> { get(): T }
export interface SessionOwner { sessionId: string; connectionId: string; profile: string }
export interface ProfileRoute { profile: string; connectionId?: string; mode?: string; [key: string]: unknown }
export interface GatewayEvent {
  type: string; payload?: Record<string, unknown>; seq?: number;
  session_id?: string; profile?: string; connectionId?: string; replayed?: boolean;
  [key: string]: unknown;
}
export interface SpeechHostPort {
  state: {
    focusedSessionOwner: Readable<SessionOwner | null>;
    focusedSessionId: Readable<string | null>;
    focusedStoredSessionId?: Readable<string | null>;
    busyBySession: Readable<Record<string, boolean>>;
  };
  composer: { submit(session: string, text: string): boolean };
  profileRoutes(): Promise<ProfileRoute[]>;
  requestProfile(route: ProfileRoute, method: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any>;
  navigate(path: string): void;
  locationKey(): string;
}
export interface SpeechContextPort {
  onEvent(name: string, receive: (event: GatewayEvent) => void): () => void;
  rest(path: string, options?: {method?: string; timeoutMs?: number; body?: unknown}): Promise<any>;
  onDispose(dispose: () => void): void;
}
export interface SpeechBootstrap {
  url: string; capture_rate: 16000; playback_rate: 24000; protocol: 1; speech_gate: 1;
}
export type SpeechProvider = "qwen" | "service";

