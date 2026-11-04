// Prompts on a terminal. One readline interface per question, closed before the next
// prompt: left open it also echoes what's typed at a hidden prompt.
import readline from 'node:readline';
import fs from 'node:fs';
import tty from 'node:tty';

/** Ctrl-C or Ctrl-D at a prompt. setup.js ends cleanly on it; what's saved stays saved. */
export class Interrupted extends Error {}

/**
 * A readable terminal, or null. Under `curl | bash` stdin is the installer script, so with no
 * terminal on stdin this opens the controlling one. close() when done.
 */
export function openTerminal() {
  if (process.stdin.isTTY) return { input: process.stdin, close: () => { try { process.stdin.pause(); } catch { /* gone */ } } };
  try {
    const fd = fs.openSync('/dev/tty', 'r');
    const input = new tty.ReadStream(fd);
    return { input, close: () => { try { input.destroy(); } catch { /* gone */ } } };
  } catch { return null; }
}

export function createUi({ input, output }) {
  function showHelp(text) {
    output.write('\n');
    for (const line of String(text).split('\n')) output.write(`  ${line}\n`);
    output.write('\n');
  }

  /** help: printed when someone types ?, then the question comes again. */
  async function ask(question, def = '', { help = '' } = {}) {
    for (;;) {
      const a = await askOnce(question, def);
      if (a !== '?') return a;
      showHelp(help || 'Nothing more to add here. Enter keeps what is in brackets.');
    }
  }

  function askOnce(question, def = '') {
    const suffix = def ? ` [${def}]` : '';
    return new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
      let answered = false;
      rl.on('close', () => { if (!answered) { output.write('\n'); reject(new Interrupted()); } });
      rl.on('SIGINT', () => rl.close());
      rl.question(`  ${question}${suffix}: `, (a) => {
        answered = true;
        rl.close();
        resolve(a.trim() || def);
      });
    });
  }

  async function confirm(question, defaultYes = false, opts = {}) {
    const a = (await ask(`${question} ${defaultYes ? '(Y/n)' : '(y/N)'}`, '', opts)).toLowerCase();
    if (!a) return defaultYes;
    return a === 'y' || a === 'yes';
  }

  /** A numbered choice. Returns the chosen item. */
  async function choose(question, items, defIndex = 0, opts = {}) {
    for (;;) {
      const a = await ask(question, String(defIndex + 1), opts);
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1];
      output.write(`  ! Type a number from 1 to ${items.length}.\n`);
    }
  }

  /** Nothing typed shows but a star per character. Needs a terminal. */
  function askSecret(question) {
    return new Promise((resolve, reject) => {
      if (!input.isTTY || typeof input.setRawMode !== 'function') {
        reject(new Error('Hidden input needs a terminal.'));
        return;
      }
      output.write(`  ${question}: `);
      input.setRawMode(true);
      input.resume();
      let buf = '';
      const finish = (fn) => {
        input.removeListener('data', onData);
        input.setRawMode(false);
        input.pause();
        output.write('\n');
        fn();
      };
      function onData(chunk) {
        const text = chunk.toString('utf8');
        if (text.startsWith('\u001b')) return;             // arrow keys and the like
        for (const c of text) {
          if (c === '\n' || c === '\r') { finish(() => resolve(buf.trim())); return; }
          if (c === '\u0003') { finish(() => reject(new Interrupted())); return; }
          if (c === '\u0004') {
            if (buf) { finish(() => resolve(buf.trim())); } else { finish(() => reject(new Interrupted())); }
            return;
          }
          if (c === '\u007f' || c === '\b') {
            if (buf) { buf = [...buf].slice(0, -1).join(''); output.write('\b \b'); }
            continue;
          }
          if (c < ' ') continue;
          buf += c;
          output.write('*');
        }
      }
      input.on('data', onData);
    });
  }

  return { ask, confirm, choose, askSecret };
}
