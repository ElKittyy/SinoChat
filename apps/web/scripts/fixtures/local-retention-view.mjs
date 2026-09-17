import { createElement, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatPanel } from "../../src/dashboard/ChatPanel.tsx";
import { nextConversationExpiry, pruneExpiredConversation, useLocalMessageExpiry } from "../../src/localMessageRetention.ts";

let root;

function RetentionView({ initial, currentUserId }) {
  const [conversations, setConversations] = useState(initial);
  const expire = useCallback((now) => {
    setConversations((current) => current.map((conversation) => pruneExpiredConversation(conversation, now)));
  }, []);
  useLocalMessageExpiry(nextConversationExpiry(conversations), expire);
  return createElement("div", {
    "data-testid": "retention-view",
    "data-retained-count": conversations.reduce((count, item) => count + item.messages.length, 0),
  }, createElement(ChatPanel, { conversation: conversations[0], currentUserId }));
}

export function mountRetentionView(conversations, currentUserId) {
  unmountRetentionView();
  let element = document.getElementById("retention-root");
  if (!element) {
    element = document.createElement("div");
    element.id = "retention-root";
    document.body.append(element);
  }
  root = createRoot(element);
  root.render(createElement(RetentionView, { initial: conversations, currentUserId }));
}

export function unmountRetentionView() {
  root?.unmount();
  root = undefined;
}
