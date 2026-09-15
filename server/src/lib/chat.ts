/**
 * The Companion request pipeline (see brief section 6):
 *  1. confirm access                         (route middleware)
 *  2. select included usage or customer key
 *  3. load published instructions + safety rules
 *  4. load recent messages + summary
 *  5. load relevant approved memories if toggle permits
 *  6. retrieve course passages
 *  7. stream from OpenAI
 *  8. save reply, sources, model, version, usage
 */
import type { Response } from 'express';
import type OpenAI from 'openai';
import { all, one, run, nowIso } from '../db/db.js';
import { getPublished, estimateCost, type CompanionConfig } from './companion.js';
import { platformClient, customerClient, estimateTokens } from './openai.js';
import { decrypt, newId } from './crypto.js';
import { retrievePassages, type Passage } from './retrieval.js';
import { relevantMemories, MEMORY_CATEGORIES } from './memory.js';
import { getUsageStatus, reserveIncluded, recordCustomerKeyUsage, completeUsage, releaseUsage, usageSettings } from './usage.js';
import type { SessionUser } from '../middleware/auth.js';
import { HttpError } from './http.js';

export interface ChatParams {
  user: SessionUser;
  conversation: any;               // conversations row
  userMessageId: string;
  attachments?: { type: 'journal'; entryId: string; title: string; text: string }[];
  previewConfig?: CompanionConfig; // owner preview of a draft version
  regenerate?: boolean;
}

interface Selected { client: OpenAI; source: 'included' | 'customer_key'; ledgerId: string }

function selectClient(user: SessionUser, modelIncluded: boolean, conversationId: string, modelId: string): Selected {
  const status = getUsageStatus(user);
  const keyRow = one<any>('SELECT key_enc, valid FROM customer_api_keys WHERE user_id = ?', user.id);

  const useCustomer = () => {
    if (!keyRow?.valid) {
      throw new HttpError(402, 'Your included usage for this month is used up. Connect your own OpenAI API key or wait for the next reset.', 'usage_exhausted', { resetDate: status.periodEnd, modelRequiresKey: !modelIncluded });
    }
    return { client: customerClient(decrypt(keyRow.key_enc)), source: 'customer_key' as const, ledgerId: recordCustomerKeyUsage(user, conversationId, modelId) };
  };

  if (!modelIncluded) {
    if (status.paymentSource !== 'customer_key') {
      throw new HttpError(402, 'This model requires your own OpenAI API key.', 'model_requires_key', { modelRequiresKey: true });
    }
    return useCustomer();
  }
  if (status.paymentSource === 'customer_key') return useCustomer();

  const client = platformClient(); // throws 503 before reserving if the platform key is missing
  const ledgerId = reserveIncluded(user, conversationId, modelId);
  if (!ledgerId) {
    throw new HttpError(402, 'Your included usage for this month is used up. Connect your own OpenAI API key or wait for the next reset.', 'usage_exhausted', { resetDate: status.periodEnd });
  }
  return { client, source: 'included', ledgerId };
}

/**
 * Cheap pre-flight used by the route BEFORE the student's message is saved, so an
 * exhausted allowance or missing key rejects the request without leaving a stray message.
 * (The race-safe reservation still happens inside selectClient.)
 */
export function assertCanSend(user: SessionUser, modelId: string) {
  const cfg = getPublished();
  const model = cfg.models.find((m) => m.id === modelId && m.enabled);
  if (!model) throw new HttpError(400, 'The selected model is no longer available. Please choose another.', 'model_unavailable');
  const status = getUsageStatus(user);
  const keyRow = one<any>('SELECT valid FROM customer_api_keys WHERE user_id = ?', user.id);
  const keyActive = status.paymentSource === 'customer_key' && !!keyRow?.valid;
  if (!model.included && !keyActive) throw new HttpError(402, 'This model requires your own OpenAI API key.', 'model_requires_key', { modelRequiresKey: true });
  if (keyActive) return;
  platformClient();
  if (status.includedExhausted) {
    throw new HttpError(402, 'Your included usage for this month is used up. Connect your own OpenAI API key or wait for the next reset.', 'usage_exhausted', { resetDate: status.periodEnd });
  }
}

function sse(res: Response, event: string, data: unknown) {
  if (res.writableEnded || res.destroyed) return; // the student closed the tab
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

const MEMORY_TAG_RE = /<memory_suggestion>([\s\S]*?)<\/memory_suggestion>/g;

export async function runChat(res: Response, p: ChatParams, abort: AbortSignal) {
  const cfg = p.previewConfig ?? getPublished();
  const settings = usageSettings();
  const model = cfg.models.find((m) => m.id === p.conversation.model_id && m.enabled);
  if (!model) throw new HttpError(400, 'The selected model is no longer available. Please choose another.', 'model_unavailable');
  const depth = cfg.depth[p.conversation.depth as 'fast' | 'medium' | 'extended'] ?? cfg.depth.medium;

  // 2) payment source. Owner preview always uses platform key and is not metered.
  const sel: Selected = p.previewConfig
    ? { client: platformClient(), source: 'included', ledgerId: '' }
    : selectClient(p.user, model.included, p.conversation.id, model.id);

  try {
    await generate(res, p, cfg, settings, model, depth, sel, abort);
  } catch (e) {
    if (sel.ledgerId) releaseUsage(sel.ledgerId, true);
    throw e;
  }
}

async function generate(
  res: Response,
  p: ChatParams,
  cfg: CompanionConfig,
  settings: ReturnType<typeof usageSettings>,
  model: NonNullable<CompanionConfig['models'][number]>,
  depth: CompanionConfig['depth']['medium'],
  sel: Selected,
  abort: AbortSignal,
) {
  // 4) history
  const history = all<any>(
    `SELECT id, role, content, attachments_json FROM messages WHERE conversation_id = ? AND status != 'failed' ORDER BY created_at ASC, rowid ASC`,
    p.conversation.id,
  );
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const query = lastUser?.content ?? '';
  const recent = history.slice(-settings.maxContextMessages);

  // 5) memories
  const memoryOn = !!p.conversation.memory_enabled && !p.conversation.is_temporary && !p.previewConfig;
  const memories = memoryOn ? await relevantMemories(p.user.id, query, settings.memoryPassages) : [];

  // 6) course passages
  let passages: Passage[] = [];
  try {
    passages = await retrievePassages(query, cfg.fileIds, settings.retrievalPassages);
  } catch (e) {
    console.error('retrieval failed', (e as Error).message);
  }

  // 3) system prompt
  const system = buildSystemPrompt(cfg, depth.instruction, memories.map((m) => `[${m.category}] ${m.content}`), passages, memoryOn, p.conversation.summary);

  const input: OpenAI.Responses.ResponseInput = [];
  for (const m of recent) {
    let content = m.content;
    if (m.role === 'user' && m.attachments_json) {
      const att = JSON.parse(m.attachments_json) as any[];
      for (const a of att) if (a.text) content += `\n\n---\nAttached journal entry "${a.title}":\n${a.text}`;
    }
    input.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }

  const assistantId = newId('msg');
  let text = '';
  let sentLen = 0; // characters already streamed to the client (memory tags held back)
  let inputTokens = 0, outputTokens = 0;
  let status: 'complete' | 'stopped' | 'failed' = 'complete';
  let errorMsg: string | null = null;

  sse(res, 'meta', { messageId: assistantId, paymentSource: sel.source, model: model.id, depth: p.conversation.depth, promptVersion: cfg.versionNumber });

  try {
    const reasoning = isReasoningModel(model.id);
    const stream = await sel.client.responses.create(
      {
        model: model.id,
        instructions: system,
        input,
        // Reasoning tokens count toward max_output_tokens, so give reasoning models headroom.
        max_output_tokens: reasoning ? depth.maxOutputTokens + 1500 : depth.maxOutputTokens,
        ...(reasoning ? { reasoning: { effort: depth.reasoning ?? 'low' } } : {}),
        stream: true,
        store: false,
      },
      { signal: abort },
    );
    for await (const ev of stream) {
      if (ev.type === 'response.output_text.delta') {
        text += ev.delta;
        // Hide memory suggestion tags (and any partial opening tag) from the streamed view
        const visible = visibleSoFar(text);
        if (visible.length > sentLen) {
          sse(res, 'delta', { text: visible.slice(sentLen) });
          sentLen = visible.length;
        }
      } else if (ev.type === 'response.completed') {
        inputTokens = ev.response.usage?.input_tokens ?? estimateTokens(system + JSON.stringify(input));
        outputTokens = ev.response.usage?.output_tokens ?? estimateTokens(text);
      } else if (ev.type === 'error') {
        throw new Error((ev as any).message ?? 'OpenAI stream error');
      }
    }
  } catch (e: any) {
    if (abort.aborted) {
      status = text ? 'stopped' : 'failed';
    } else {
      status = 'failed';
      errorMsg = friendlyOpenAIError(e, sel.source);
    }
  }

  // Extract memory suggestions
  const suggestions: { category: string; content: string }[] = [];
  let visible = text;
  if (memoryOn) {
    for (const m of text.matchAll(MEMORY_TAG_RE)) {
      const body = m[1].trim();
      const mm = /^\[?(\w+)\]?\s*[:\-]\s*(.+)$/s.exec(body);
      const category = mm && (MEMORY_CATEGORIES as readonly string[]).includes(mm[1].toLowerCase()) ? mm[1].toLowerCase() : 'theme';
      const content = (mm ? mm[2] : body).trim();
      if (content.length > 5 && content.length < 400) suggestions.push({ category, content });
    }
  }
  visible = visible.replace(MEMORY_TAG_RE, '').trim();

  if (!inputTokens) inputTokens = estimateTokens(system + JSON.stringify(input));
  if (!outputTokens) outputTokens = estimateTokens(text);
  const cost = estimateCost(model, inputTokens, outputTokens);

  const sources = dedupeSources(passages);
  const isFailure = status === 'failed';

  if (!p.previewConfig) {
    run(
      `INSERT INTO messages (id, conversation_id, role, content, status, model_id, depth, prompt_version, sources_json, payment_source, input_tokens, output_tokens, cost_usd, error)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assistantId, p.conversation.id, visible, status, model.id, p.conversation.depth, cfg.versionNumber,
      JSON.stringify(sources), sel.source, inputTokens, outputTokens, cost, errorMsg,
    );
    run('UPDATE conversations SET last_message_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), p.conversation.id);

    // Failed / duplicate responses do not count as completed replies.
    if (sel.ledgerId) {
      if (isFailure) releaseUsage(sel.ledgerId, true);
      else completeUsage(sel.ledgerId, assistantId, inputTokens, outputTokens, cost);
    }

    // Save memory suggestions as pending (student must approve)
    if (!isFailure && suggestions.length) {
      const { createMemory } = await import('./memory.js');
      for (const s of suggestions.slice(0, 3)) {
        await createMemory(p.user.id, { ...s, status: 'pending', sourceConversationId: p.conversation.id, sourceMessageId: assistantId });
      }
    }

    // Auto-title after first exchange
    if (p.conversation.title_auto && history.filter((m) => m.role === 'user').length === 1 && !isFailure) {
      const title = makeTitle(query);
      run('UPDATE conversations SET title = ? WHERE id = ? AND title_auto = 1', title, p.conversation.id);
      sse(res, 'title', { title });
    }
  }

  const pending = !p.previewConfig && !isFailure && suggestions.length
    ? all('SELECT id, category, content FROM memories WHERE user_id = ? AND status = ? AND source_message_id = ?', p.user.id, 'pending', assistantId)
    : [];

  sse(res, 'done', {
    messageId: assistantId,
    status,
    error: errorMsg,
    content: visible,
    sources,
    memorySuggestions: pending,
    usage: p.previewConfig ? null : getUsageStatus(p.user),
  });
  if (!res.writableEnded) res.end();
}

function buildSystemPrompt(cfg: CompanionConfig, depthInstruction: string, memories: string[], passages: Passage[], memoryOn: boolean, summary: string | null) {
  const parts: string[] = [];
  parts.push(`# Identity\nYou are "${cfg.name}". ${cfg.description}`);
  parts.push(`# Instructions\n${cfg.instructions}`);
  parts.push(`# Safety rules (always apply)\n${cfg.safetyRules}`);
  parts.push(`# Response depth\n${depthInstruction}`);
  if (summary) parts.push(`# Earlier in this conversation (summary)\n${summary}`);
  if (passages.length) {
    const lines = passages.map((ps, i) => `[Source ${i + 1}] ${labelFor(ps)}\n${ps.content}`);
    parts.push(
      `# Approved course material\nUse the following passages when they are relevant. When a passage informs your answer, mention where it comes from in plain language (for example "In Module 2, Values, the course suggests..."). Do not quote entire passages; paraphrase. Never mention file names or "sources" by number.\n\n${lines.join('\n\n')}`,
    );
  } else {
    parts.push(`# Approved course material\nNo course passages matched this message. Answer from the course instructions and general good practice, and say when something is not covered by the course.`);
  }
  if (memoryOn) {
    if (memories.length) parts.push(`# What the student has approved you to remember\n${memories.map((m) => `- ${m}`).join('\n')}\nUse these only where they are genuinely relevant.`);
    parts.push(
      `# Memory suggestions\nCross-chat memory is ON for this conversation. If the student shares something durable and useful for future conversations (a value, goal, commitment, preference, recurring theme, or a practice that helped), you MAY propose at most one short memory at the very end of your reply using exactly this format on its own line:\n<memory_suggestion>[category]: one concise sentence in the student's terms</memory_suggestion>\nCategories: ${MEMORY_CATEGORIES.join(', ')}. Do not propose memories about sensitive health details. The student must approve anything before it is remembered, so never claim you have remembered something.`,
    );
  } else {
    parts.push(`# Memory\nCross-chat memory is OFF for this conversation. Do not reference other conversations and do not propose anything to remember.`);
  }
  return parts.join('\n\n');
}

/** gpt-5 family and o-series accept the `reasoning` parameter; 4.x/4o models do not. */
export function isReasoningModel(id: string): boolean {
  return /^(gpt-5|o[1-9])/.test(id) && !/chat-latest/.test(id);
}

const TAG_OPEN = '<memory_suggestion>';

/**
 * The reply text with completed memory-suggestion tags removed and any partly-received
 * tag held back. Grows monotonically, so streaming continues after a tag closes.
 */
export function visibleSoFar(text: string): string {
  const withoutTags = text.replace(/<memory_suggestion>[\s\S]*?<\/memory_suggestion>/g, '');
  const open = withoutTags.indexOf(TAG_OPEN);
  if (open >= 0) return withoutTags.slice(0, open);      // tag started, not yet closed
  const lt = withoutTags.lastIndexOf('<');
  if (lt >= 0 && TAG_OPEN.startsWith(withoutTags.slice(lt))) return withoutTags.slice(0, lt); // partial "<memo"
  return withoutTags;
}

function labelFor(p: Passage) {
  return [p.module, p.section].filter(Boolean).join(' - ') || p.title;
}

function dedupeSources(passages: Passage[]) {
  const seen = new Set<string>();
  const out: { fileId: string; title: string; module: string; section: string }[] = [];
  for (const p of passages) {
    const k = `${p.fileId}|${p.module}|${p.section}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ fileId: p.fileId, title: p.title, module: p.module, section: p.section });
  }
  return out;
}

function makeTitle(q: string) {
  const t = q.replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  const cut = t.length > 48 ? t.slice(0, 48).replace(/\s\S*$/, '') + '…' : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

function friendlyOpenAIError(e: any, source: 'included' | 'customer_key'): string {
  const st = e?.status;
  if (source === 'customer_key') {
    if (st === 401) return 'OpenAI rejected your API key. Check it in Settings.';
    if (st === 429) return 'OpenAI reports your key has run out of quota or funds. Your message was not lost.';
  }
  if (st === 429) return 'The Companion is busy right now. Please try again in a moment.';
  if (st === 400 && /model/i.test(String(e?.message))) return 'That model is not available for this key.';
  return 'The Companion could not complete this reply. Your message was not lost and this did not count toward your usage.';
}

/** Produce a concise summary of a long conversation (used for "continue in a new chat" and context compaction). */
export async function summarizeConversation(user: SessionUser, conversationId: string): Promise<string> {
  const msgs = all<any>(`SELECT role, content FROM messages WHERE conversation_id = ? AND status = 'complete' ORDER BY created_at ASC`, conversationId);
  if (!msgs.length) return '';
  const transcript = msgs.map((m) => `${m.role === 'user' ? 'Student' : 'Companion'}: ${m.content}`).join('\n\n').slice(-24000);
  const keyRow = one<any>('SELECT key_enc, valid FROM customer_api_keys WHERE user_id = ?', user.id);
  const status = getUsageStatus(user);
  const client = status.paymentSource === 'customer_key' && keyRow?.valid ? customerClient(decrypt(keyRow.key_enc)) : platformClient();
  const cfg = getPublished();
  const modelId = cfg.models.find((m) => m.included && m.enabled)?.id ?? cfg.models[0]?.id ?? 'gpt-4.1-mini';
  const r = await client.responses.create({
    model: modelId,
    instructions: 'Summarize this conversation between a student and a course companion in 5-8 concise bullet points, capturing the situation, key insights, decisions, and open questions. Write in the second person ("You..."). No preamble.',
    input: transcript,
    max_output_tokens: 400,
    store: false,
  });
  const text = r.output_text?.trim() ?? '';
  run('UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?', text, nowIso(), conversationId);
  return text;
}
