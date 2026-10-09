"""LangGraph agent: Nova Lite answers in character with text + emotion, remembers per thread_id."""

import json
import logging
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from langchain_aws import ChatBedrockConverse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from pydantic import BaseModel, Field

load_dotenv()  # optional: on the server the AWS role is used instead

log = logging.getLogger(__name__)

MODEL_ID = "us.amazon.nova-lite-v1:0"
REGION = "us-east-1"
MAX_MESSAGES = 20
SAFE_LINE = "Sorry friend, I lost my train of thought. Could you say that again?"

CHARACTER = json.loads((Path(__file__).parent / "character.json").read_text(encoding="utf-8"))

SYSTEM_PROMPT = (
    CHARACTER["personality"]
    + "\n\nRules:\n"
    "- Reply in 1 to 3 short sentences.\n"
    "- No lists, no emojis, no markdown.\n"
    "- Be friendly and family-safe: you are shown on a big screen.\n"
    "- Always stay in character.\n"
    "- Pick the emotion that best fits your reply."
)


class Reply(BaseModel):
    """The character's answer."""

    text: str = Field(description="What the character says out loud, 1-3 short sentences.")
    emotion: Literal["neutral", "happy", "angry", "sad", "relaxed"] = Field(
        description="Facial emotion shown while speaking."
    )


class State(MessagesState):
    emotion: str


llm = ChatBedrockConverse(model=MODEL_ID, region_name=REGION).with_structured_output(
    Reply, include_raw=True
)


def _raw_text(raw) -> str:
    """Plain text from a raw AIMessage (content may be a string or a list of blocks)."""
    content = getattr(raw, "content", "")
    if isinstance(content, list):
        content = " ".join(b.get("text", "") for b in content if isinstance(b, dict))
    return (content or "").strip()


def _trim(messages):
    """Keep the last MAX_MESSAGES; Bedrock needs the conversation to start with a user turn."""
    recent = messages[-MAX_MESSAGES:]
    while recent and not isinstance(recent[0], HumanMessage):
        recent = recent[1:]
    return recent


def answer(state: State):
    out = llm.invoke([SystemMessage(SYSTEM_PROMPT), *_trim(state["messages"])])
    reply = out.get("parsed")
    if not isinstance(reply, Reply) or not reply.text.strip():
        log.warning("Invalid structured output, using fallback: %s", out.get("parsing_error"))
        reply = Reply(text=_raw_text(out.get("raw")) or SAFE_LINE, emotion="neutral")
    return {"messages": [AIMessage(reply.text)], "emotion": reply.emotion}


builder = StateGraph(State)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
graph = builder.compile(checkpointer=InMemorySaver())


def _config(thread_id: str):
    return {"configurable": {"thread_id": thread_id}}


def _to_reply(result) -> Reply:
    return Reply(text=result["messages"][-1].content, emotion=result.get("emotion", "neutral"))


async def ask(text: str, thread_id: str) -> Reply:
    """Send the user's text on this conversation thread; returns the character's Reply."""
    result = await graph.ainvoke({"messages": [HumanMessage(text)]}, _config(thread_id))
    return _to_reply(result)


def ask_sync(text: str, thread_id: str) -> Reply:
    """Sync version (e.g. for asyncio.to_thread or scripts)."""
    result = graph.invoke({"messages": [HumanMessage(text)]}, _config(thread_id))
    return _to_reply(result)
