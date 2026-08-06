// The agent itself, defined with Flue's hooks API.
// This file is the part that agent-koans verifies.
'use agent';
import { useModel } from '@flue/runtime';

export function Assistant() {
  useModel('koan/default');
  return 'You are a task-solving agent. Complete the task given by the user.';
}
