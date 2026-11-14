import * as v from 'valibot';
import { request, userSchema } from './api';

const profileResponse = v.object({ user: userSchema });

export function updateProfile(input: { name: string; avatarSeed: string }) {
  return request('/api/me/profile', profileResponse, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}
