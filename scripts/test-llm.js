import { callLlm } from '../src/brain/llm.js';

console.log('Testing LLM connection...\n');

const system = `You are Karyasthan. You're in a WhatsApp group with friends from Kerala.
You speak Manglish. Keep responses short, casual, funny.`;

const user = `[Rahul]: machane entha plan weekend?
[Priya]: enthelum poi kanam
[Arun]: netflix and chill aano

---
Reply as Karyasthan. Be natural. Keep it SHORT.`;

try {
  const response = await callLlm(system, user);
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
