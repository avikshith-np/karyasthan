import { IG_PACKAGE } from './device.js';

// Pure readers over dumpScreen() nodes — what's on Instagram's screen, no device I/O.
// Resource ids observed on Instagram for Android (2026-10, OxygenOS 12), specs/005.

const rid = (name) => `${IG_PACKAGE}:id/${name}`;
export const find = (nodes, name) => nodes.find(n => n.id === rid(name)) || null;
export const findAll = (nodes, name) => nodes.filter(n => n.id === rid(name));

// Instagram blocks/challenges that need a human. Seeing any of these ends the session
// and raises the dashboard alert — the bot never tries to get past them.
const BLOCKER_RE = /confirm (?:it'?s|that it'?s) you|help us confirm|suspicious (?:login|activity)|unusual activity|we restrict certain activity|try again later|action blocked|we limit how often|enter (?:the |your )?(?:security |confirmation )?code|your account (?:has been|was) (?:suspended|disabled|locked)|we suspended your account|log in to (?:instagram|continue)|session expired/i;

export function detectBlocker(nodes) {
  for (const n of nodes) {
    const label = `${n.text} ${n.desc}`.trim();
    if (label && BLOCKER_RE.test(label)) return label.slice(0, 200);
  }
  return null;
}

export function screenKind(nodes) {
  if (find(nodes, 'direct_send_button_multi_select') || find(nodes, 'direct_private_share_recipients_recycler_view')
    || find(nodes, 'link_tracking_disclosure_text_view')) return 'share_sheet';
  // Any other Instagram bottom sheet on top (e.g. the first-Save "Collect the posts you
  // love" sheet). Closed with BACK — its rows can do things (that one un-saves).
  if (find(nodes, 'bottom_sheet_drag_handle_frame')
    || nodes.some(n => n.id === rid('background_dimmer') && /dismiss/i.test(n.desc))) return 'sheet';
  if (find(nodes, 'clips_viewer_view_pager') && find(nodes, 'clips_author_username')) return 'reels';
  if (nodes.some(n => /^Saved$/.test(n.text)) && nodes.some(n => /^(All|Collections)$/.test(n.text))) return 'saved';
  return 'other';
}

const parseCount = (s) => {
  const m = String(s || '').match(/(\d[\d,]*)/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
};

/** The reel currently filling the Reels viewer. */
export function readReel(nodes) {
  const author = find(nodes, 'clips_author_username');
  const captionBox = find(nodes, 'clips_caption_component');
  const caption = captionBox?.bounds
    ? nodes.filter(n => n.bounds && n !== captionBox && n.bounds.y1 >= captionBox.bounds.y1 && n.bounds.y2 <= captionBox.bounds.y2)
      .map(n => (n.text || n.desc).trim()).filter(t => t && !/^see more$/i.test(t)).join(' ').replace(/\s*…\s*$/, '').trim()
    : '';
  const like = find(nodes, 'like_button');
  const save = find(nodes, 'save_button');
  return {
    account: author ? (author.text || author.desc).trim() : null,
    caption: caption || null,
    isAd: nodes.some(n => /^(Sponsored|Ad)$/i.test((n.text || n.desc || '').trim())),
    likeCount: parseCount(find(nodes, 'like_count')?.text),
    commentCount: parseCount(find(nodes, 'comment_count')?.text),
    likeNode: like,
    liked: !!like?.selected,
    saveNode: save,
    saved: !!save?.selected || /^(Remove|Unsave|Saved)/i.test(save?.desc || ''),
    shareNode: find(nodes, 'direct_share_button'),
    reelsTab: find(nodes, 'clips_tab'),
  };
}

/**
 * A post/reel opened in Instagram's FEED viewer (e.g. from the Saved grid, titled
 * "All Posts"): different ids from the Reels viewer, and it shows the audio title.
 */
function readPost(nodes) {
  const name = find(nodes, 'row_feed_photo_profile_name');
  const save = find(nodes, 'row_feed_button_save');
  return {
    account: name ? (name.text || name.desc).trim() : null,
    audio: find(nodes, 'secondary_label')?.text.trim() || null,
    shareNode: find(nodes, 'row_feed_button_share'),
    saveNode: save,
    saved: !!save?.selected || /remove from saved/i.test(save?.desc || ''),
  };
}

/** Whatever single reel/post is open: the Reels viewer or the feed viewer. */
export function readOpenMedia(nodes) {
  const reel = readReel(nodes);
  return reel.account ? reel : readPost(nodes);
}

/**
 * A stable-enough identity for "did the swipe move to a new reel?". Not the like count:
 * our own like changes it, which made a liked reel look new.
 */
export const reelKey = (r) => `${r.account || ''}|${(r.caption || '').slice(0, 60)}|${r.commentCount ?? ''}`;

/**
 * The share sheet's search results. Returns rows with the row's toggle node, so the
 * caller can require an EXACT group-name match (similar-named strangers appear below).
 */
export function shareSearchRows(nodes) {
  const names = findAll(nodes, 'row_user_primary_name');
  const seconds = findAll(nodes, 'row_user_secondary_name');
  const toggles = findAll(nodes, 'recipient_toggle');
  const sameRow = (a, b) => a?.bounds && b?.bounds && Math.abs((a.bounds.y1 + a.bounds.y2) / 2 - (b.bounds.y1 + b.bounds.y2) / 2) < 70;
  return names.map(n => ({
    name: n.text.trim(),
    secondary: seconds.find(s => s.bounds && n.bounds && s.bounds.y1 >= n.bounds.y1 && s.bounds.y1 - n.bounds.y2 < 20)?.text.trim() || '',
    toggle: toggles.find(t => sameRow(t, n)) || null,
  }));
}

/** A group chat row reads like "AB, friend_two and 4 others" under its title. */
export const looksLikeGroup = (row) => /,|\band \d+ others?\b/i.test(row.secondary);

export function selectedChats(nodes) {
  return nodes.filter(n => n.id === rid('direct_share_sheet_grid_view_pog') && / Chat selected$/.test(n.desc))
    .map(n => n.desc.replace(/ (?:Verified )?Chat selected$/, '').trim());
}

// ── Direct messages (the group thread) ───────────────────────────────────────

/** The group's row in the Messages inbox: "Squad, unread, 2 new messages ·, 19m". */
export function readInboxRow(nodes, groupName) {
  const row = nodes.find(n => n.bounds && n.desc && n.desc.startsWith(`${groupName}, `));
  if (!row) return null;
  const unread = /,\s*unread\b/i.test(row.desc);
  const m = row.desc.match(/(\d+)\s+new messages?/i);
  return { node: row, unread, newCount: m ? parseInt(m[1], 10) : (unread ? 1 : 0) };
}

const NOT_A_MESSAGE_RE = /^(tap and hold to react|seen|sent|delivered|seen by .*|active (now|\d+\s*\w+ ago)|message…|typing…|.* is typing…?)$/i;
const TIME_SEPARATOR_RE = /^((today|yesterday|mon|tue|wed|thu|fri|sat|sun)\w*[\s,]*)?\d{1,2}[:.]\d{2}(\s?[ap]m)?$|^\d{1,2}\s+\w+\s+\d{4}(,?\s+\d{1,2}[:.]\d{2})?$|^\w{3,9}\s+\d{1,2}(,\s*\d{4})?(\s+at\s+\d{1,2}[:.]\d{2}.*)?$/i;
const inside = (a, b) => a.bounds && b.bounds && a.bounds.x1 >= b.bounds.x1 && a.bounds.x2 <= b.bounds.x2 && a.bounds.y1 >= b.bounds.y1 && a.bounds.y2 <= b.bounds.y2;
const onlyEmoji = (t) => !/[\p{L}\p{N}]/u.test(t);

/**
 * Messages visible in the open thread, top to bottom. Who sent what is inferred like a
 * person reads it: right-aligned bubbles are ours; a "username" label starts a run of
 * someone's messages; "X replied to you" names the sender of the next bubble. Quoted
 * (replied-to) content is skipped; emoji-only reaction chips are not messages.
 * Each: { fromMe, sender (username or display name or null), kind: 'text'|'reel',
 *         text, reelAccount, replyToMe, node }.
 */
export function parseThread(nodes) {
  const title = find(nodes, 'thread_title');
  const composer = find(nodes, 'message_composer_bar');
  const top = (find(nodes, 'direct_thread_toggle_action_bar')?.bounds?.y2) ?? 237;
  const bottom = composer?.bounds?.y1 ?? 2200;
  const quoted = findAll(nodes, 'context_reply_context_message_container');
  const cards = findAll(nodes, 'reel_share_item_view').filter(c => !quoted.some(q => inside(c, q)));
  const items = [];
  for (const n of nodes) {
    if (!n.bounds || n.bounds.y1 < top || n.bounds.y2 > bottom + 2 || n === title) continue;
    if (quoted.some(q => inside(n, q))) continue;
    if (n.id === rid('username')) { items.push({ type: 'sender', name: n.text.trim(), y: n.bounds.y1 }); continue; }
    if (n.id === rid('direct_context_reply_context_info_text_view')) {
      const m = n.text.trim().match(/^(.+?) replied to (you|.+)$/i);
      if (m) items.push({ type: 'reply_ctx', who: m[1], toMe: /^you$/i.test(m[2]), y: n.bounds.y1 });
      continue;
    }
    if (n.id === rid('reel_share_item_view') && cards.includes(n)) {
      const author = nodes.find(t => t.id === rid('title_text') && inside(t, n));
      items.push({ type: 'msg', kind: 'reel', text: null, reelAccount: author?.text.trim() || null, node: n, y: n.bounds.y1 });
      continue;
    }
    const isText = n.cls.endsWith('TextView') && n.text.trim() && (n.id === rid('direct_text_message_text_view') || !n.id);
    if (!isText || cards.some(c => inside(n, c))) continue;
    const t = n.text.trim();
    if (NOT_A_MESSAGE_RE.test(t) || TIME_SEPARATOR_RE.test(t) || onlyEmoji(t)) continue;
    items.push({ type: 'msg', kind: 'text', text: t, reelAccount: null, node: n, y: n.bounds.y1 });
  }
  items.sort((a, b) => a.y - b.y);

  const out = [];
  let runSender = null;
  let pending = null; // from "X replied to you"
  for (const it of items) {
    if (it.type === 'sender') { runSender = it.name; continue; }
    if (it.type === 'reply_ctx') { pending = it; continue; }
    const cx = (it.node.bounds.x1 + it.node.bounds.x2) / 2;
    const fromMe = (pending && /^you$/i.test(pending.who)) || (!pending && cx > 560);
    let sender = null;
    if (fromMe) runSender = null;
    else sender = pending?.who || runSender;
    out.push({ fromMe, sender, kind: it.kind, text: it.text, reelAccount: it.reelAccount, replyToMe: !!pending?.toMe, node: it.node });
    pending = null;
  }
  return out;
}

export const messageKey = (m) => `${m.fromMe ? 'me' : (m.sender || '?')}|${m.kind}|${m.text || m.reelAccount || ''}`;

/** The group's People screen: [{ displayName, username, admin, isSelf }]. */
export function readMembers(nodes) {
  const headers = findAll(nodes, 'row_header_textview').map(h => ({ text: h.text.trim(), y: h.bounds?.y1 ?? 0 }));
  const seconds = findAll(nodes, 'row_user_secondary_name');
  return findAll(nodes, 'row_user_primary_name').map((p) => {
    const sec = seconds.find(s => s.bounds && p.bounds && s.bounds.y1 >= p.bounds.y1 && s.bounds.y1 - p.bounds.y2 < 30);
    const secText = sec?.text.trim() || '';
    const admin = /^admin\b/i.test(secText);
    const username = (secText.replace(/^admin\s*•\s*/i, '') || p.text).trim();
    const header = headers.filter(h => h.y < (p.bounds?.y1 ?? 0)).pop()?.text || '';
    return { displayName: p.text.trim(), username, admin, isSelf: /^you$/i.test(header) };
  });
}
