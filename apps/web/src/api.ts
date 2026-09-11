import { io, Socket } from 'socket.io-client';

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export type Persona = {
  publicId: string;
  name: string;
  shortDescription: string;
  identityBackground: string;
  speakingHabits: string[];
  attitudeStyle: string[];
  transformRules: string[];
  examples: Array<{ input: string; output: string }>;
  visual: { color?: string; symbol?: string };
  visibility: string;
  enabled: boolean;
  version: number;
};

export type Room = { code: string; name: string; type: 'NORMAL' | 'THEME'; status?: string; maxMembers?: number };

export type ChatMessage = {
  publicId: string;
  sequenceNo: number;
  sender: { memberId: number | string; nickname: string };
  persona: Persona;
  text: string;
  createdAt: string;
};

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('lipu-token');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `请求失败：${response.status}`);
  }
  return response.json();
}

export async function ensureSession() {
  if (localStorage.getItem('lipu-token')) return;
  const result = await request<{ token: string; user: { nickname: string } }>('/api/session', { method: 'POST', body: '{}' });
  localStorage.setItem('lipu-token', result.token);
  localStorage.setItem('lipu-nickname', result.user.nickname);
}

export function connectSocket(): Socket {
  return io(API_URL, { transports: ['websocket'], auth: { token: localStorage.getItem('lipu-token') } });
}

