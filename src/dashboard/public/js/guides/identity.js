// Guide: Identity (pages/identity.js). Plain data, see components/guide.js.
export default {
  title: 'Identity',
  intro: [
    'This is his character sheet: the identity file (src/personality/identity.md) written in plain prose and placed at the top of every reply prompt. Who he is, how he talks, what he cares about and what he avoids all come from here, together with what he has learned about people.',
    'Saving takes effect at once: the file is rewritten and the next model call uses the new text. There is no draft and no automatic backup of the old version, so copy it somewhere first if you might want it back.',
  ],
  sections: [
    {
      id: 'editor',
      title: 'Editing the file',
      where: 'IDENTITY.MD · MARKDOWN panel',
      text: [
        'The editor holds the whole file as written, including any sections the prompt leaves out, so saving never drops anything you can\'t see. BYTES and LINES in the header and the status line (with UNSAVED while you have changes) update as you type; the panel head shows the cursor line and column.',
      ],
      items: [
        ['SAVE', 'Writes the file and reloads it into the running bot. Refused when the text is empty or over 50 KB. Needs a writable dashboard (DASHBOARD_READONLY=false); the save is audited as identity.put with the size only.'],
        ['↩ DISCARD', 'After a confirm, throws away your edits and puts back the text last loaded or saved. It does not undo an earlier save.'],
      ],
      tips: [
        'His name, the names he answers to and his language settings live in persona.json, not here; this page doesn\'t change them.',
        'Lines are taken literally. A line telling him to always mention one thing makes him fixate on it. Describe tendencies ("sometimes", "when it fits") rather than rules.',
        'Imitate mode never touches this file: while he is imitating someone a temporary identity is used instead, and his own comes back when it ends.',
      ],
    },
    {
      id: 'legacy',
      title: 'Legacy capability sections',
      where: 'amber warning above the editor',
      text: [
        'Older identity files carried their own instructions for images, voice notes, web search and similar abilities. Those manuals now live in code, and sections with these headings are left out of the prompt when it is built. The warning lists the ones still in your file.',
        'Editing them changes nothing about his behaviour. Removing them just keeps the file and the prompt in step.',
      ],
    },
    {
      id: 'age',
      title: 'His age while the life simulation runs',
      text: [
        'While the life simulation is on, his age follows his simulated birthday: a {{AGE}} placeholder, or the first "<age> years old" matching the age set at setup, is replaced with his current age in the prompt. The file itself is not changed. With life off the text is used exactly as written.',
      ],
    },
  ],
};
