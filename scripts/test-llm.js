import { callLlm } from '../src/brain/llm.js';

console.log('Testing LLM connection...\n');

const system = `You are Karyasthan. You're in a WhatsApp group with friends.
You speak English. Keep responses short, casual, funny.`;

const user = `[Kit]: so what's the plan this weekend?
[Sam]: we should go somewhere
[Jo]: or just stay in and watch something

---
Reply as Karyasthan. Be natural. Keep it SHORT.`;

try {
  const response = await callLlm(system, user, { role: 'mouth', caller: 'test.llm' });
  if (response) {
    console.log('✓ LLM responded:');
    console.log(`  "${response}"\n`);
    console.log(`  Length: ${response.length} chars`);
  } else {
    console.log('✗ LLM returned no response. Check your API key and provider settings.');
  }
} catch (err) {
  console.error('✗ LLM call failed:', err.message);
}
