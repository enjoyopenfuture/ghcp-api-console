import type { DeviceCodeResponse } from './deviceFlow.js';

export interface AccountCredentials {
  githubUsername: string;
  ssoUsername: string;
  ssoPassword: string;
}

export interface AuthStrategy {
  readonly name: string;
  authorize(device: DeviceCodeResponse, signal?: AbortSignal): Promise<void>;
}
