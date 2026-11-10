// BSD-159: Verlauf eines Chats aus Astryx-Bausteinen – Nachrichten des Nutzers als Blase, Antworten als Teile:
// Thinking einklappbar, Text als Markdown (lokal gerendert, kein HTML, keine fremden Bilder), Tool-Karten mit Status
// und Freigabe, Hinweise, Fehler mit Retry, Tokens/Kosten je Antwort (BSD-74).
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { ChatMessage, ChatMessageBubble, ChatMessageList, ChatToolCalls, type ChatToolCallItem } from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { formatCost, formatTokens, PAGE_URI, type ChatPart, type ChatTurnBuilder, type TranscriptItem, type TurnUsage } from "@based/brain";
import { memo, type ReactNode } from "react";
import { AgentBar } from "../components/AgentMark.js";
import type { PendingApproval } from "./controller.js";

/** Links auf Seiten (based://page/<id>) werden Sprünge innerhalb der App. */
export const internalLinks = (md: string) => md.replaceAll(PAGE_URI, "#page-");

const MD_COMPONENTS = {
  // Keine Bilder von fremden Servern: der Link bleibt, geladen wird nichts.
  image: ({ src, alt }: { src: string; alt: string }) => (
    <a className="chat-image-link" href={src} target="_blank" rel="noopener noreferrer">{alt ? `Image: ${alt}` : "Image"}</a>
  ),
  link: ({ href, children }: { href: string; children: ReactNode }) =>
    href.startsWith("#") ? <a href={href}>{children}</a> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
};

/** Markdown einer Antwort; nur neu geparst, wenn sich der Text ändert (BSD-74: kein Re-Parse je Delta anderer Teile). */
export const AnswerMarkdown = memo(function AnswerMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <Markdown isStreaming={streaming} density="compact" contentWidth="100%" headingLevelStart={3} components={MD_COMPONENTS}>
      {internalLinks(text)}
    </Markdown>
  );
});

export function usageLine(u: TurnUsage): string | undefined {
  const tokens = u.inputTokens + u.outputTokens;
  if (tokens === 0 && u.costUSD === 0) return undefined;
  const cost = u.costUSD > 0 ? ` · ${u.estimated ? "~" : ""}${formatCost(u.costUSD)}` : "";
  return `${formatTokens(tokens)} tokens${cost}`;
}

const TOOL_LABELS: Record<string, string> = {
  search: "Search", read_page: "Read page", list_pages: "List pages", create_page: "Create page", append_markdown: "Append to page",
  replace_page_content: "Rewrite page", find_replace: "Edit text", update_page: "Update page", list_databases: "List databases",
  query_database: "Query database", add_row: "Add row", update_row: "Update row",
};

function toolItem(p: ChatPart): ChatToolCallItem {
  const status = p.status === "running" ? "running" : p.status === "waiting" ? "pending" : p.status === "failed" ? "error" : "complete";
  const item: ChatToolCallItem = { key: p.id, name: TOOL_LABELS[p.toolName] ?? p.toolName, status };
  if (p.detail) item.target = p.detail;
  if (p.status === "failed" && p.output) item.errorMessage = p.output;
  if (p.output) item.resultDetail = <CodeBlock code={p.output} language="plaintext" hasLanguageLabel={false} />;
  return item;
}

function ToolCard({ part, approval, onAnswer }: { part: ChatPart; approval: PendingApproval | undefined; onAnswer: (id: string, ok: boolean) => void }) {
  return (
    <div className="chat-tool" data-testid="tool-card" data-tool={part.toolName} data-status={part.status}>
      <ChatToolCalls calls={[toolItem(part)]} />
      {approval ? (
        <div className="chat-approval" role="group" aria-label="Approval needed">
          <span className="t-desc">Based wants to {(TOOL_LABELS[part.toolName] ?? part.toolName).toLowerCase()}{part.detail ? ` “${part.detail}”` : ""}.</span>
          <Button size="sm" variant="primary" label="Allow" onClick={() => onAnswer(part.id, true)} />
          <Button size="sm" variant="ghost" label="Deny" onClick={() => onAnswer(part.id, false)} />
        </div>
      ) : null}
    </div>
  );
}

function Thinking({ part }: { part: ChatPart }) {
  const running = part.status === "running";
  return (
    <Collapsible defaultIsOpen={false} chevronPosition="start" className="chat-thinking" data-testid="thinking" trigger={<span className="t-meta">{running ? "Thinking…" : "Thought"}</span>}>
      <p className="t-desc chat-thinking-text">{part.text}</p>
    </Collapsible>
  );
}

function AssistantTurn({ turn, last, approvals, onAnswer, onRetry }: { turn: ChatTurnBuilder; last: boolean; approvals: readonly PendingApproval[]; onAnswer: (id: string, ok: boolean) => void; onRetry: () => void }) {
  const usage = usageLine(turn.usage);
  const meta = [turn.model, usage].filter(Boolean).join(" · ");
  return (
    <ChatMessage sender="assistant">
      <div className="chat-answer" data-testid="assistant-message" data-done={turn.done ? "" : undefined}>
        <AgentBar label="Answer from Based" />
        <div className="chat-answer-body">
          {turn.parts.map((p) => {
            if (p.kind === "thinking") return <Thinking key={p.id} part={p} />;
            if (p.kind === "tool") return <ToolCard key={p.id} part={p} approval={approvals.find((a) => a.call.id === p.id)} onAnswer={onAnswer} />;
            return p.text ? <div key={p.id} className="chat-text" data-testid="answer-text"><AnswerMarkdown text={p.text} streaming={p.status === "running"} /></div> : null;
          })}
          {!turn.done && turn.parts.length === 0 ? <span className="t-meta chat-pending" role="status">Based is thinking…</span> : null}
          {turn.notices.map((n, i) => <p key={i} className="t-meta">{n}</p>)}
          {turn.error && turn.stopped ? <p className="t-meta" data-testid="stopped">Stopped.</p> : null}
          {turn.error && !turn.stopped ? (
            <Banner status="error" title="The answer failed" description={turn.error} endContent={last ? <Button size="sm" label="Retry" onClick={onRetry} /> : undefined} />
          ) : null}
          {meta && turn.done ? <span className="t-data chat-meta" data-testid="turn-usage">{meta}</span> : null}
        </div>
      </div>
    </ChatMessage>
  );
}

export function ChatMessages({ items, running, approvals, onAnswer, onRetry, empty }: {
  items: readonly TranscriptItem[];
  running: boolean;
  approvals: readonly PendingApproval[];
  onAnswer: (id: string, ok: boolean) => void;
  onRetry: () => void;
  empty: ReactNode;
}) {
  const lastAssistant = items.findLastIndex((i) => i.kind === "assistant");
  return (
    <ChatMessageList isStreaming={running} density="compact" emptyState={empty} align="top">
      {items.map((item, i) =>
        item.kind === "user" ? (
          <ChatMessage key={item.id} sender="user">
            <ChatMessageBubble variant="ghost"><span className="chat-user-text" data-testid="user-message">{item.text}</span></ChatMessageBubble>
          </ChatMessage>
        ) : (
          <AssistantTurn key={item.id} turn={item.turn} last={i === lastAssistant && i === items.length - 1} approvals={approvals} onAnswer={onAnswer} onRetry={onRetry} />
        ),
      )}
    </ChatMessageList>
  );
}
