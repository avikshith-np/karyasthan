import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { getDb } from '../memory/db.js';
import { getActiveFlow, startFlow, refreshFlow, clearFlow } from '../behavior/activeFlows.js';
import { parseReceipt } from '../billing/receiptParser.js';
import { parseAssignment } from '../billing/assignmentParser.js';
import { equalSplit, itemizedSplit, formatSummary, formatEqualSummary, paisaToRupees } from '../billing/splitEngine.js';
import { sendText, sendReaction } from '../whatsapp/actions.js';
import { simulateTyping } from '../behavior/timing.js';
import { phoneFromJid } from '../utils/jidUtils.js';
import { config, getPersona } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { getRawMessage } from '../whatsapp/events.js';
import {
  createBillSplit, getBillSplit, getActiveBill, getBillByImage,
  getRecentParsedBills, updateBillState, updateFlowProgress,
  completeBill, cancelBill,
} from '../memory/billStore.js';

const FLOW_TYPE = 'skill:bill-split';
const SELF_NAMES = getPersona().aliases;
const BILL_WORDS = ['split', 'bill', 'divide', 'calculate', 'kitna', 'how much', 'total', 'pay', 'share'];

function isBotMentioned(msg, botJid, botLid) {
  if (msg.metadata?.mentionedJids?.length) {
    const botPhone = botJid ? phoneFromJid(botJid) : null;
    const botLidId = botLid ? phoneFromJid(botLid) : null;
    const configPhone = config.phoneNumber;
    const matched = msg.metadata.mentionedJids.some(jid => {
      const phone = phoneFromJid(jid);
      return (botPhone && phone === botPhone)
        || (botLidId && phone === botLidId)
        || (configPhone && phone === configPhone);
    });
    if (matched) return true;

    // LID mismatch fallback: single @mention is very likely for us
    logger.debug({
      mentionedJids: msg.metadata.mentionedJids,
      botPhone, botLidId, configPhone,
    }, 'bill-split: @mention JIDs did not match bot — possible LID mismatch');
    if (msg.metadata.mentionedJids.length === 1) return true;
  }
  if (msg.content) {
    const lower = msg.content.toLowerCase();
    if (SELF_NAMES.some(n => lower.includes(n))) return true;
  }
  return false;
}

function isQuotedFromSelf(quotedId) {
  if (!quotedId) return false;
  try {
    const db = getDb();
    const row = db.prepare('SELECT is_from_self FROM messages WHERE id = ?').get(quotedId);
    return row?.is_from_self === 1;
  } catch {
    return false;
  }
}

function findRecentImage(chatJid, maxAgeSec = 300) {
  try {
    const db = getDb();
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
    const rows = db.prepare(
      `SELECT id FROM messages
       WHERE group_jid = ? AND message_type = 'image' AND timestamp > ?
       ORDER BY timestamp DESC LIMIT 5`
    ).all(chatJid, cutoff);
    for (const row of rows) {
      if (getRawMessage(row.id)) return row.id;
    }
  } catch {}
  return null;
}

export default {
  name: 'bill-split',

  shouldHandle(msg, context) {
    if (!context.isGroup && !context.isDm) return false;

    const lower = (msg.content || '').toLowerCase();
    const hasBillWord = BILL_WORDS.some(w => lower.includes(w));
    const mentioned = isBotMentioned(msg, context.botJid, context.botLid);

    // ── Check 1: Active in-memory flow for this chat ──
    const flow = getActiveFlow(msg.groupJid);
    if (flow?.type === FLOW_TYPE) {
      if (context.isDm) return true;

      const meta = flow.metadata;

      // Always intercept from known flow participants
      const isInitiator = msg.senderJid === meta.initiatorJid;
      const isFlowContributor = meta.participantJids?.has(msg.senderJid);
      const isNamedPerson = meta.people?.length > 0 && meta.people.some(
        name => msg.senderName?.toLowerCase().includes(name.toLowerCase())
      );
      if (isInitiator || isFlowContributor || isNamedPerson || mentioned) return true;

      // Unknown senders: only intercept with very strong signals
      // (NOT keyword matching — "calculate", "bill", etc. appear in normal conversation)
      if (isQuotedFromSelf(msg.quotedId)) return true;
      if (meta.people?.length > 0 && meta.people.some(name => lower.includes(name.toLowerCase()))) return true;

      // Everything else from unknown senders: pass through to normal pipeline
      logger.debug({ msgId: msg.id, sender: msg.senderName }, 'bill-split: flow active but unknown sender, passing through');
      return false;
    }

    // ── Check 1.5: Resumable bill in DB (no in-memory flow) ──
    try {
      const activeBill = getActiveBill(msg.groupJid);
      if (activeBill) {
        const isKnownByJid = msg.senderJid === activeBill.initiator_jid
          || activeBill.participantJids.includes(msg.senderJid);
        const isNamedInBill = activeBill.people?.length > 0 && activeBill.people.some(
          name => msg.senderName?.toLowerCase().includes(name.toLowerCase())
        );
        const isKnown = isKnownByJid || isNamedInBill;
        if ((isKnown || mentioned) && hasBillWord) {
          msg._resumeBillId = activeBill.id;
          logger.debug({ msgId: msg.id, billId: activeBill.id }, 'bill-split: resuming from DB');
          return true;
        }
        if (isQuotedFromSelf(msg.quotedId) && isKnown) {
          msg._resumeBillId = activeBill.id;
          return true;
        }
      }
    } catch {}

    // ── Check 2: Reply to an image ──
    if (msg.quotedId) {
      const db = getDb();
      const quoted = db.prepare('SELECT message_type FROM messages WHERE id = ?').get(msg.quotedId);
      const isImage = (quoted && quoted.message_type === 'image')
        || !!getRawMessage(msg.quotedId)?.message?.imageMessage;
      if (isImage) {
        if (hasBillWord) {
          logger.debug({ msgId: msg.id }, 'bill-split: trigger (reply to image + bill keyword)');
          return true;
        }
        if (lower.length < 30 && mentioned) {
          logger.debug({ msgId: msg.id }, 'bill-split: trigger (short reply to image + mention)');
          return true;
        }
      }
      return false;
    }

    // ── Check 3: Image sent with caption containing bill keyword ──
    if (msg.messageType === 'image' && msg.content && hasBillWord) {
      logger.debug({ msgId: msg.id }, 'bill-split: trigger (image + bill keyword caption)');
      return true;
    }

    // ── Check 4: Text-only with bill keyword — look back for recent image or DB ──
    if (msg.messageType === 'text' && hasBillWord && (mentioned || context.isDm)) {
      // First check DB for auto-detected bills
      try {
        const parsed = getRecentParsedBills(msg.groupJid, 1);
        if (parsed.length > 0) {
          msg._parsedBillId = parsed[0].id;
          logger.debug({ msgId: msg.id, billId: parsed[0].id }, 'bill-split: trigger (text + auto-detected bill in DB)');
          return true;
        }
      } catch {}

      // Fall back to raw message cache
      const imageId = findRecentImage(msg.groupJid);
      if (imageId) {
        msg._lookbackImageId = imageId;
        logger.debug({ msgId: msg.id, imageId }, 'bill-split: trigger (text + lookback image)');
        return true;
      }
    }

    return false;
  },

  async handle(sock, msg, context) {
    // Active in-memory flow
    const flow = getActiveFlow(msg.groupJid);
    if (flow?.type === FLOW_TYPE) {
      refreshFlow(msg.groupJid);
      return handleFlowMessage(sock, msg, context, flow);
    }

    // Resume from DB
    if (msg._resumeBillId) {
      return resumeFlow(sock, msg, context, msg._resumeBillId);
    }

    // New trigger
    return handleTrigger(sock, msg, context);
  },
};

// ── Trigger: Start a new bill split ──

async function handleTrigger(sock, msg, context) {
  const imageId = msg._lookbackImageId || msg.quotedId || msg.id;

  // Check if there's already an active bill for this group
  const existingActive = getActiveBill(msg.groupJid);
  if (existingActive) {
    await reply(sock, msg, "there's already a bill split in progress — say 'cancel' to scrap it, or finish it first");
    return true;
  }

  // Check if auto-detect already parsed this bill (from DB)
  if (msg._parsedBillId) {
    const parsed = getBillSplit(msg._parsedBillId);
    if (parsed) {
      return startFlowFromBill(sock, msg, parsed.bill, parsed.id, parsed.image_msg_id);
    }
  }

  // Check if this specific image was already parsed
  const existingBill = getBillByImage(imageId);
  if (existingBill && existingBill.state === 'PARSED') {
    return startFlowFromBill(sock, msg, existingBill.bill, existingBill.id, existingBill.image_msg_id);
  }

  // Need to download and parse the image
  const rawMsg = getRawMessage(imageId);
  if (!rawMsg) {
    await reply(sock, msg, "that image is too old, send the bill again and tag me");
    return true;
  }

  await simulateTyping(sock, msg.groupJid, 30);

  let base64, mimetype;
  try {
    const buffer = await downloadMediaMessage(
      rawMsg, 'buffer', {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    if (!buffer || buffer.length === 0) {
      await reply(sock, msg, "couldn't download the image, try again");
      return true;
    }
    base64 = buffer.toString('base64');
    const imgMsg = rawMsg.message?.imageMessage;
    mimetype = imgMsg?.mimetype?.split(';')[0]?.trim() || 'image/jpeg';
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to download bill image');
    await reply(sock, msg, "couldn't get the image, send the bill again and tag me");
    return true;
  }

  const bill = await parseReceipt(base64, mimetype);
  if (!bill) {
    await reply(sock, msg, "that doesn't look like a bill to me 🤔 send a clearer photo and try again");
    return true;
  }

  // Store in DB and start flow
  const billId = createBillSplit(msg.groupJid, imageId, bill.restaurant, bill, 'ACTIVE', msg.senderJid);
  return startFlowFromBill(sock, msg, bill, billId, imageId);
}

async function startFlowFromBill(sock, msg, bill, billId, imageMsgId) {
  // Update DB state
  updateBillState(billId, 'ACTIVE');

  // Start in-memory flow — metadata holds IDs, not full bill
  startFlow(msg.groupJid, FLOW_TYPE, {
    billSplitId: billId,
    bill,
    people: [],
    assignments: [],
    initiatorJid: msg.senderJid,
    participantJids: new Set([msg.senderJid]),
  });

  // Format item list
  const itemList = bill.items.map((item, i) =>
    `${i + 1}. ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''} — ${paisaToRupees(item.totalPricePaisa)}`
  ).join('\n');

  const totalLine = `Total: ${paisaToRupees(bill.totalPaisa)}`;
  const taxLine = bill.taxPaisa > 0 ? ` (incl. tax ${paisaToRupees(bill.taxPaisa)})` : '';

  await reply(sock, msg,
    `${bill.restaurant ? bill.restaurant + '\n\n' : ''}${itemList}\n${totalLine}${taxLine}\n\nwho all ate?`
  );

  return true;
}

// ── Resume: Reconstruct flow from DB ──

async function resumeFlow(sock, msg, context, billId) {
  const record = getBillSplit(billId);
  if (!record) return handleTrigger(sock, msg, context);

  // Reconstruct in-memory flow
  const participantJids = new Set(record.participantJids || []);
  participantJids.add(msg.senderJid);

  startFlow(msg.groupJid, FLOW_TYPE, {
    billSplitId: record.id,
    bill: record.bill,
    people: record.people || [],
    assignments: record.assignments || [],
    initiatorJid: record.initiator_jid,
    participantJids,
  });

  updateBillState(record.id, 'ACTIVE');

  logger.info({ billId: record.id, groupJid: msg.groupJid }, 'Resumed bill split from DB');

  const flow = getActiveFlow(msg.groupJid);
  return handleFlowMessage(sock, msg, context, flow);
}

// ── Flow: Handle subsequent messages during bill split ──

async function handleFlowMessage(sock, msg, context, flow) {
  // Track this sender as a flow contributor
  if (!flow.metadata.participantJids) flow.metadata.participantJids = new Set();
  flow.metadata.participantJids.add(msg.senderJid);

  // Detect new bill image sent during active flow — don't let it get swallowed
  if (msg.messageType === 'image') {
    const lower = (msg.content || '').toLowerCase();
    if (BILL_WORDS.some(w => lower.includes(w))) {
      await reply(sock, msg, "one split at a time da — finish this one first or say 'cancel' to scrap it");
      return true;
    }
  }

  // Cancel command
  if (/\b(cancel|stop|never\s?mind|forget it|leave it)\b/i.test(msg.content || '')) {
    if (flow.metadata.billSplitId) cancelBill(flow.metadata.billSplitId);
    clearFlow(msg.groupJid);
    await reply(sock, msg, 'ok, scrapped the split');
    return true;
  }
  return handleActive(sock, msg, flow);
}

// ── Single conversational handler ──

async function handleActive(sock, msg, flow) {
  const { bill } = flow.metadata;
  const lower = (msg.content || '').toLowerCase();

  // Quick heuristic: equal split
  if (/\b(equal|equally|barabar|same for all|split equally)\b/.test(lower) && flow.metadata.people.length > 0) {
    return doEqualSplit(sock, msg, flow, bill);
  }

  // Quick heuristic: "rest shared by all"
  if (/\b(rest|remaining|baaki)\b/.test(lower) && /\b(all|everyone|shared|sabko)\b/.test(lower)) {
    assignRemaining(flow, bill);
    return doItemizedSplit(sock, msg, flow, bill);
  }

  // Build full context for the LLM
  const itemList = bill.items.map((item, i) =>
    `${i}. ${item.name}${item.qty > 1 ? ` x${item.qty}` : ''} — ${paisaToRupees(item.totalPricePaisa)}`
  ).join('\n');

  const assigned = flow.metadata.assignments;
  const assignedIndices = new Set(assigned.map(a => a.itemIndex));

  const assignedStr = assigned.length > 0
    ? assigned.map(a => {
        const item = bill.items[a.itemIndex];
        return `  ${item.name} → ${a.people.join(' & ')}`;
      }).join('\n')
    : '  nothing yet';

  const unassigned = bill.items
    .map((item, i) => ({ ...item, index: i }))
    .filter(item => !assignedIndices.has(item.index));

  const unassignedStr = unassigned.length > 0
    ? unassigned.map(item => item.name).join(', ')
    : 'all items assigned';

  const peopleStr = flow.metadata.people.length > 0
    ? flow.metadata.people.join(', ')
    : 'not yet known';

  const allAssigned = unassigned.length === 0 && flow.metadata.people.length > 0 && assigned.length > 0;

  const senderShortName = matchSenderToPeople(msg.senderName, flow.metadata.people);

  const systemPrompt = `You are ${getPersona().name}, helping split a restaurant bill in a WhatsApp group.

BILL ITEMS (use the zero-based index shown):
${itemList}
Total: ${paisaToRupees(bill.totalPaisa)}

CURRENT STATE:
People: ${peopleStr}
Assigned so far:
${assignedStr}
Unassigned items: ${unassignedStr}

The sender is "${senderShortName}" (WhatsApp display name: "${msg.senderName || 'Unknown'}"). "I"/"me"/"my" = "${senderShortName}". Always use names from the People list above verbatim — do not invent new names or use display-name variants.

Fields:
- "people": full list of everyone eating (keep existing names + add new ones). Omit or [] if no change.
- "assignments": items being assigned or reassigned in THIS message. Each: {"itemIndex": N, "people": ["Name1","Name2"]}. Use itemIndex from the list above. Omit or [] if none.
- "equal_split": true ONLY if user explicitly wants to split equally.
- "confirmed": true ONLY if all items were already assigned AND user is confirming ("yes", "looks good", "correct", "done", "seri", "athe", "haan").
- "not_about_bill": true ONLY if the message is clearly unrelated to this split (side conversation, a question to another human, random chatter). When true, leave all other fields empty.
- "message": your casual, short response (1-3 lines).

RULES:
- Match item names loosely: "sandwich" = Focaccia Veg Sandwich, "tea"/"chai" = Bc Chai, "coffee" = Cold Coffee, "mint lime"/"fresh lime" may map to Mini Lime, etc. If a food item in the user's message has no reasonable match on the bill, omit that assignment entirely (do not guess wildly).
- ONE entry per item. For any single bill item, emit at most ONE assignment object whose "people" array lists EVERY person who had that item. Never emit the same itemIndex twice in the assignments array. Example: if Person A had one Gobi Dosa and Person B had one Gobi Dosa (from a Gobi Dosa x2 bill line), return a single {"itemIndex": 3, "people": ["Person A", "Person B"]} — not two separate entries.
- "split"/"shared" = both people had it. Same rule: list all sharers in that item's people array in ONE entry.
- Multi-quantity items (qty > 1) where each person had one get split evenly among the listed people; do NOT try to duplicate the item.
- For corrections like "oh I also had tea": return that item with the FULL updated people list (existing + new person).
- Do NOT calculate money amounts in your message — just item names and people.
- If you extracted assignments, briefly confirm what you understood in "message".
- If items remain unassigned, ask about them in "message".
- If ALL items are now assigned (including from previous state + this message), list a quick draft in "message" showing who had what, then ask "anything wrong?" or "correct?".
- Keep "message" SHORT. You are texting, not writing an essay.`;

  const userMessage = `[${senderShortName}]: ${msg.content}`;

  const action = await parseAssignment(systemPrompt, userMessage, { maxTokens: 2048, temperature: 0.3 });

  if (!action) {
    return handleParseFailure(sock, msg, flow, allAssigned);
  }

  // Reset failure counter on any successful parse
  flow.metadata.consecutiveParseFailures = 0;

  // Escape hatch: message isn't about the bill — stay silent
  if (action.not_about_bill === true) {
    logger.debug({ msgId: msg.id, sender: msg.senderName }, 'bill-split: not_about_bill, staying silent');
    return true;
  }

  // Process equal split
  if (action.equal_split) {
    if (action.people?.length > 0) flow.metadata.people = action.people;
    if (flow.metadata.people.length > 0) {
      return doEqualSplit(sock, msg, flow, bill);
    }
    await reply(sock, msg, "who all ate? give me the names first");
    return true;
  }

  // Process people
  if (action.people?.length > 0) {
    flow.metadata.people = action.people;
  }

  // Process assignments (only if we have people)
  if (action.assignments?.length > 0 && flow.metadata.people.length > 0) {
    applyAssignments(flow, action.assignments, bill);
  }

  // Persist progress to DB
  persistProgress(flow);

  // Check confirmation — finalize the split
  if (action.confirmed && flow.metadata.people.length > 0 && flow.metadata.assignments.length > 0) {
    assignRemaining(flow, bill);
    return doItemizedSplit(sock, msg, flow, bill);
  }

  // Send the LLM's message
  const replyText = action.message || "tell me who had what";
  await simulateTyping(sock, msg.groupJid, replyText.length);
  await reply(sock, msg, replyText);
  return true;
}

async function handleParseFailure(sock, msg, flow, allAssigned) {
  flow.metadata.consecutiveParseFailures = (flow.metadata.consecutiveParseFailures || 0) + 1;
  const count = flow.metadata.consecutiveParseFailures;

  if (count === 1) {
    try {
      await sendReaction(sock, msg.groupJid, msg.id, '🤔', msg.senderJid);
    } catch (err) {
      logger.debug({ err: err.message }, 'bill-split: reaction failed on parse error');
    }
    return true;
  }

  // 2+ consecutive failures: send a concrete rephrasing hint
  const people = flow.metadata.people || [];
  const bill = flow.metadata.bill;
  const p1 = people[0] || 'Ashish';
  const p2 = people[1] || people[0] || 'Vaishnav';
  const item1 = bill?.items?.[0]?.name?.toLowerCase() || 'ghee roast';
  const item2 = bill?.items?.[1]?.name?.toLowerCase() || 'cheese paneer dosa';
  const hint = allAssigned
    ? "didn't get that — say 'yes' to confirm or tell me what's wrong"
    : `try like: '${p1} had ${item1}, ${p2} had ${item2}'`;

  await simulateTyping(sock, msg.groupJid, hint.length);
  await reply(sock, msg, hint);
  return true;
}

function matchSenderToPeople(senderName, people) {
  if (!senderName || !people?.length) return senderName || 'Unknown';
  const tokens = senderName.toLowerCase().split(/[\s\-_.,;/]+/).filter(Boolean);
  for (const person of people) {
    const lower = person.toLowerCase();
    if (tokens.includes(lower)) return person;
  }
  return senderName;
}

// ── Helpers ──

function persistProgress(flow) {
  if (!flow.metadata.billSplitId) return;
  try {
    updateFlowProgress(
      flow.metadata.billSplitId,
      flow.metadata.people,
      flow.metadata.assignments,
      [...(flow.metadata.participantJids || [])],
    );
  } catch (err) {
    logger.debug({ err: err.message }, 'Failed to persist bill flow progress');
  }
}

function applyAssignments(flow, newAssignments, bill) {
  // Merge same-item entries within this batch by union of people.
  // Without this, an LLM that emits one entry per person for a shared item
  // (e.g. Gobi x2 → [Person A], then Gobi x2 → [Person B]) loses the first
  // when the second overwrites it.
  const batch = new Map(); // itemIndex -> Set<string>
  for (const a of newAssignments) {
    let itemIndex = a.itemIndex;
    if ((itemIndex == null || itemIndex < 0 || itemIndex >= bill.items.length) && a.item) {
      const lower = a.item.toLowerCase();
      itemIndex = bill.items.findIndex(item => item.name.toLowerCase().includes(lower));
      if (itemIndex < 0) itemIndex = fuzzyFindItem(a.item, bill.items);
      if (itemIndex < 0) {
        logger.warn(
          { requested: a.item, billItems: bill.items.map(i => i.name) },
          'bill-split: could not match item to bill'
        );
        continue;
      }
    }
    if (itemIndex == null || itemIndex < 0 || itemIndex >= bill.items.length) continue;
    if (!a.people?.length) continue;
    if (!batch.has(itemIndex)) batch.set(itemIndex, new Set());
    const set = batch.get(itemIndex);
    for (const p of a.people) set.add(p);
  }
  for (const [itemIndex, peopleSet] of batch) {
    flow.metadata.assignments = flow.metadata.assignments.filter(
      existing => existing.itemIndex !== itemIndex
    );
    flow.metadata.assignments.push({ itemIndex, people: [...peopleSet] });
  }
}

const ITEM_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'with', 'one', 'two']);

function tokenizeItem(str) {
  return str.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !ITEM_STOPWORDS.has(t));
}

function fuzzyFindItem(query, billItems) {
  const qTokens = tokenizeItem(query);
  if (qTokens.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < billItems.length; i++) {
    const iTokens = new Set(tokenizeItem(billItems[i].name));
    let score = 0;
    for (const t of qTokens) if (iTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore >= 1 ? bestIdx : -1;
}

function assignRemaining(flow, bill) {
  const assignedIndices = new Set(flow.metadata.assignments.map(a => a.itemIndex));
  for (let i = 0; i < bill.items.length; i++) {
    if (!assignedIndices.has(i)) {
      flow.metadata.assignments.push({ itemIndex: i, people: [...flow.metadata.people] });
    }
  }
}

async function doEqualSplit(sock, msg, flow, bill) {
  const { people } = flow.metadata;
  const shares = equalSplit(bill.totalPaisa, people.length);
  const summary = formatEqualSummary(shares, people, bill);

  await simulateTyping(sock, msg.groupJid, summary.length);
  await reply(sock, msg, summary);

  if (flow.metadata.billSplitId) completeBill(flow.metadata.billSplitId, people, flow.metadata.assignments);
  clearFlow(msg.groupJid);
  return true;
}

async function doItemizedSplit(sock, msg, flow, bill) {
  const result = itemizedSplit(bill, flow.metadata.assignments);
  const summary = formatSummary(result, bill);

  await simulateTyping(sock, msg.groupJid, summary.length);
  await reply(sock, msg, summary);

  if (flow.metadata.billSplitId) completeBill(flow.metadata.billSplitId, flow.metadata.people, flow.metadata.assignments);
  clearFlow(msg.groupJid);
  return true;
}

async function reply(sock, msg, text) {
  await sendText(sock, msg.groupJid, text);
}
