// Saved chats: every question and answer goes into the conversations/messages tables (db/schema.sql).
// A conversation belongs to one user of one company. Every query checks both, so nobody can read
// or add to another user's chat by guessing its id.
import type { AskResult, Turn } from "../answer/ask.js";
import { pool } from "../db.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FOLLOW_UP_TURNS = 3; // how many earlier questions and answers a follow-up gets as context

// The citations column holds the citations and the evidence quote together: {"items": [...], "evidence": "..."}.
// Older rows hold only the list of citations.
type StoredCitations = AskResult["citations"] | { items: AskResult["citations"]; evidence: string } | null;

function readCitations(stored: StoredCitations): { citations: AskResult["citations"] | null; evidence: string | null } {
  if (stored === null) return { citations: null, evidence: null };
  if (Array.isArray(stored)) return { citations: stored, evidence: null };
  return { citations: stored.items, evidence: stored.evidence || null };
}

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export type SavedMessage = {
  role: "user" | "assistant";
  content: string;
  citations: AskResult["citations"] | null;
  evidence: string | null; // the source line(s) the answer rests on, word for word
  abstained: boolean | null;
  latencyMs: number | null;
  costUsd: number | null;
  createdAt: string;
};

// The conversation id if it exists and belongs to this user, else null
export async function ownConversation(tenantId: string, userId: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3",
    [id, tenantId, userId],
  );
  return rows[0]?.id ?? null;
}

// A new chat, titled with its first question
export async function createConversation(tenantId: string, userId: string, firstQuestion: string): Promise<string> {
  const title = firstQuestion.length > 80 ? `${firstQuestion.slice(0, 77)}…` : firstQuestion;
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO conversations (tenant_id, user_id, title) VALUES ($1, $2, $3) RETURNING id",
    [tenantId, userId, title],
  );
  return rows[0]!.id;
}

// The user's chats, the most recently used first
export async function listConversations(tenantId: string, userId: string): Promise<ConversationSummary[]> {
  const { rows } = await pool.query<{ id: string; title: string | null; updated_at: Date }>(
    `SELECT c.id, c.title, COALESCE(MAX(m.created_at), c.created_at) AS updated_at
     FROM conversations c
     LEFT JOIN messages m ON m.conversation_id = c.id AND m.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1 AND c.user_id = $2
     GROUP BY c.id
     ORDER BY updated_at DESC
     LIMIT 100`,
    [tenantId, userId],
  );
  return rows.map((row) => ({ id: row.id, title: row.title ?? "(no title)", updatedAt: row.updated_at.toISOString() }));
}

// Every message of one chat, oldest first. null = no such chat for this user.
export async function conversationMessages(tenantId: string, userId: string, id: string): Promise<SavedMessage[] | null> {
  if (!(await ownConversation(tenantId, userId, id))) return null;
  const { rows } = await pool.query<{
    role: "user" | "assistant";
    content: string;
    citations: StoredCitations;
    abstained: boolean | null;
    latency_ms: number | null;
    cost_usd: string | null;
    created_at: Date;
  }>(
    `SELECT role, content, citations, abstained, latency_ms, cost_usd, created_at
     FROM messages WHERE conversation_id = $1 AND tenant_id = $2 ORDER BY created_at, role DESC`,
    [id, tenantId],
  );
  return rows.map((row) => ({
    role: row.role,
    content: row.content,
    ...readCitations(row.citations),
    abstained: row.abstained,
    latencyMs: row.latency_ms,
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
    createdAt: row.created_at.toISOString(),
  }));
}

// The last few questions and answers, oldest first: the context for a follow-up question
export async function recentTurns(tenantId: string, conversationId: string): Promise<Turn[]> {
  const { rows } = await pool.query<{ role: string; content: string }>(
    `SELECT role, content FROM messages WHERE conversation_id = $1 AND tenant_id = $2
     ORDER BY created_at DESC, role ASC LIMIT $3`,
    [conversationId, tenantId, FOLLOW_UP_TURNS * 2],
  );
  const turns: Turn[] = [];
  const oldestFirst = rows.reverse();
  for (let i = 0; i < oldestFirst.length; i++) {
    const row = oldestFirst[i]!;
    const next = oldestFirst[i + 1];
    if (row.role === "user" && next?.role === "assistant") {
      turns.push({ question: row.content, answer: next.content });
      i++;
    }
  }
  return turns;
}

// Saves one question and its answer together (one transaction), so a chat never has half a turn
export async function saveTurn(tenantId: string, conversationId: string, question: string, result: AskResult): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // clock_timestamp(): the answer gets a later time than the question, even inside one transaction
    await client.query(
      "INSERT INTO messages (tenant_id, conversation_id, role, content, created_at) VALUES ($1, $2, 'user', $3, clock_timestamp())",
      [tenantId, conversationId, question],
    );
    await client.query(
      `INSERT INTO messages (tenant_id, conversation_id, role, content, citations, abstained, latency_ms,
                             input_tokens, output_tokens, cost_usd, created_at)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9, clock_timestamp())`,
      [
        tenantId,
        conversationId,
        result.answer,
        JSON.stringify({ items: result.citations, evidence: result.evidence } satisfies StoredCitations),
        result.abstained,
        result.latencyMs,
        result.inputTokens,
        result.outputTokens,
        result.costUsd,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteConversation(tenantId: string, userId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rowCount } = await pool.query("DELETE FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3", [
    id,
    tenantId,
    userId,
  ]);
  return (rowCount ?? 0) > 0;
}
